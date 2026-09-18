/**
 * 会话用量采集：每轮把各会话的 CLI 记录读成「本会话至今花了多少 / 今天花了多少」
 *
 * 只统计会话里 CLI 自己的消耗；WebTmux 监控自身的调用记在另一张表（TokenStatsService），两者不混。
 * 长程会话不参与：它自己有一套账（LongRunLoop.spentUsd），混在一起会重复记。
 */

import { existsSync, readdirSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { readClaudeRun } from './ClaudeUsageReader.js';
import { readCodexRun, listCodexRuns } from './CodexUsageReader.js';
import { decideBinding, siblingsOf } from './UsageAttribution.js';
import { diffCumulative, localDayKey } from './costMath.js';
import pricingTable from './PricingTable.js';

export const CLAUDE_PROJECTS = () => path.join(os.homedir(), '.claude', 'projects');
/** 与 index.js:1056 同一套编码（历史上漏过下划线，导致带下划线的项目找不到目录） */
export const encodeCwd = (cwd) => String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');

/** 某工作目录下最新的 transcript（排他推断时用；hook 给了路径就不会走到这里） */
export function newestTranscript(workingDir, root = null) {
  const dir = path.join(root || CLAUDE_PROJECTS(), encodeCwd(workingDir));
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ file: path.join(dir, f), mtimeMs: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.file || null;
}

export class SessionUsageService {
  constructor({ ledger, pricing = pricingTable, claudeProjectsRoot = null, codexRoot = null } = {}) {
    Object.assign(this, { ledger, pricing, claudeProjectsRoot, codexRoot });
    this.state = new Map();   // sessionId -> 上一轮结果（用于 diff，不变就不广播）
  }

  /** 一个会话的一轮采集。返回 {ok, sessionUsd, todayUsd, ...} 或 {ok:false, kind, reason} */
  collect(session, allSessions, now = Date.now()) {
    const binding = decideBinding(session, siblingsOf(session, allSessions));
    if (binding.kind === 'unsupported' || binding.kind === 'ambiguous') {
      return { ok: false, kind: binding.kind, cli: binding.cli, reason: binding.reason };
    }
    const runs = this._runsFor(session, binding);
    if (!runs.length) return { ok: true, kind: 'empty', cli: binding.cli, sessionUsd: this.ledger.sessionTotal(session.id), todayUsd: this._today(session.id, now) };

    let estimated = false, incomplete = false, model = '';
    for (const run of runs) {
      const prev = this.ledger.getCursor(binding.cli, run.runKey);
      const cur = { filePath: run.filePath, ...(prev ? { inode: prev.inode, fileSize: prev.file_size, fileMtime: prev.file_mtime, scanOffset: prev.scan_offset, anchorUsd: prev.anchor_usd, byModel: prev.byModel } : {}) };
      const read = binding.cli === 'claude'
        ? readClaudeRun(cur, this.pricing)
        : readCodexRun(cur, this.pricing, session.currentModel || session.codexProvider?.model || '');
      if (!read) {
        // 文件没动，但归属可能刚变（另一个会话接管了这份记录）：用上次已知累计当基线补一次认领，
        // 否则接管后到下一次文件变动之间花的钱会被算到原持有者头上
        const cur0 = this.ledger.activeBinding(binding.cli, run.runKey);
        if (!cur0 || cur0.session_id !== session.id) {
          this.ledger.claim(session.id, binding.cli, run.runKey, prev?.cum_usd || 0, binding.source || 'exclusive', now);
        }
        continue;
      }
      if (read.estimated) estimated = true;
      if (read.costComplete === false) incomplete = true;
      if (read.model) model = read.model;
      const bound = this.ledger.activeBinding(binding.cli, run.runKey);
      if (!bound || bound.session_id !== session.id) {
        this.ledger.claim(session.id, binding.cli, run.runKey, read.cumUsd, binding.source || 'exclusive', now);
        this.ledger.record({ sessionId: session.id, cli: binding.cli, runKey: run.runKey, deltaUsd: 0, cursor: read, now });
        continue;                                           // 认领当轮只记基线，绝不把历史算进来
      }
      const { delta } = diffCumulative(prev ? { inode: prev.inode, fileSize: prev.file_size, cumUsd: prev.cum_usd } : null,
        { inode: read.inode, fileSize: read.fileSize, cumUsd: read.cumUsd });
      // 第二道闸：本会话在这个 run 上累计记的钱，不得超过「当前累计 − 认领基线」。
      // 游标可能比认领还旧（上一次 WebTmux 运行留下的、或该 run 曾被别的会话跟过），只靠 diff 会把认领前的钱算进来
      const room = Math.max(0, read.cumUsd - (bound.claimed_cum_usd || 0) - (bound.credited_usd || 0));
      this.ledger.record({ sessionId: session.id, cli: binding.cli, runKey: run.runKey, deltaUsd: Math.min(delta, room),
        tokens: read.tokens || {}, model: read.model || model, cursor: read, now });
    }
    return {
      ok: true, kind: 'ok', cli: binding.cli, source: binding.source,
      sessionUsd: this.ledger.sessionTotal(session.id), todayUsd: this._today(session.id, now),
      estimated, incomplete, model,
    };
  }

  _today(sessionId, now) {
    return this.ledger.dayTotal(localDayKey(now), sessionId);
  }

  _runsFor(session, binding) {
    if (binding.cli === 'claude') {
      const filePath = binding.filePath
        || (binding.runKey ? path.join(this.claudeProjectsRoot || CLAUDE_PROJECTS(), encodeCwd(session.workingDir), `${binding.runKey}.jsonl`) : null)
        || newestTranscript(session.workingDir, this.claudeProjectsRoot);
      if (!filePath || !existsSync(filePath)) return [];
      return [{ runKey: binding.runKey || path.basename(filePath, '.jsonl'), filePath }];
    }
    // codex：该工作目录下、会话创建之后还在写的 rollout。只取最近的几份，历史留给基线排除
    const since = session.createdAt ? new Date(session.createdAt).getTime() : 0;
    return listCodexRuns(session.workingDir, { since, root: this.codexRoot, limit: 8 })
      .map((f) => ({ runKey: f.path, filePath: f.path }));
  }
}
