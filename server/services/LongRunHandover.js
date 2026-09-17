/**
 * 长程 → 终端：交接计划（纯逻辑 + 只读文件，可单测）
 *
 * 长程执行者用 `claude -p` 跑，这类会话**不进** ~/.claude/history.jsonl 索引，`claude -c` 找不到，
 * 只能 `claude --resume <id>` 接，而且必须在同一个工作目录（会话记录按 cwd 分目录存）。
 *
 * 接续方式（用户选定按水位自动）：最后一发水位低于交接下限 → resume 续同一对话，上下文都在；
 * 否则 fresh 开新对话、发「新对话开始提示词」从记忆接上 —— 避免一接手就面临自动压缩、费用也高。
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import { claudeProjectsDir } from './LongRunSandbox.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 该工作目录的 claude 会话记录目录（非字母数字一律换成 -，与 CLI 一致） */
export const transcriptDir = (root) => path.join(claudeProjectsDir(), String(root).replace(/[^a-zA-Z0-9]/g, '-'));

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** orchestrator.jsonl 里最后一条带 session_id 的 result 事件（坏行跳过） */
function lastResult(root) {
  let text = '';
  try { text = readFileSync(path.join(root, '.run', 'orchestrator.jsonl'), 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev;
    try { ev = JSON.parse(lines[i]); } catch { continue; }
    if (ev?.kind === 'result' && ev.session_id) return ev;
  }
  return null;
}

/**
 * 取要接续的 claude 会话 id。按可信度逐级兜底，每级都要求 id 形态正确且会话记录文件真的存在：
 *   1 内存里 loop.sessionId  2 .run/session_state.json  3 事件文件最后一条 result  4 会话记录目录里最新的文件
 * ⚠ 交接后 loop.sessionId / session_state 会被置 null（停在"交接完、还没发下一发"时），所以不能只看前两级。
 * @returns {{id: string, source: string} | null}
 */
export function resolveClaudeSessionId({ root, liveSessionId = null }) {
  const valid = (id) => typeof id === 'string' && UUID_RE.test(id) && existsSync(path.join(transcriptDir(root), `${id}.jsonl`));
  const state = readJson(path.join(root, '.run', 'session_state.json'));
  const candidates = [[liveSessionId, '运行中的任务'], [state?.session_id, 'session_state.json'], [lastResult(root)?.session_id, '事件文件最后一发']];
  for (const [id, source] of candidates) if (valid(id)) return { id, source };
  try {
    const dir = transcriptDir(root);
    const newest = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && UUID_RE.test(f.slice(0, -6)))
      .map((f) => [f, statSync(path.join(dir, f)).mtimeMs]).sort((a, b) => b[1] - a[1])[0];
    if (newest) return { id: newest[0].slice(0, -6), source: '会话记录目录最新文件' };
  } catch { /* 目录不存在 */ }
  return null;
}

/** 最后一发的水位：事件文件最后一条 result 的 context_peak；取不到返回 null */
export function lastContextPeak(root) {
  const ev = lastResult(root);
  return Number.isFinite(ev?.context_peak) ? ev.context_peak : null;
}

/**
 * 决定接续方式。
 * @param {'auto'|'resume'|'fresh'} mode
 * @returns {{mode: 'resume'|'fresh', reason: string}}
 */
export function decideHandover(mode, { peak, handoffFloor, hasSessionId }) {
  if (mode === 'fresh') return { mode: 'fresh', reason: '指定开新对话' };
  if (!hasSessionId) return { mode: 'fresh', reason: '找不到可接续的 claude 会话，开新对话从记忆接上' };
  if (mode === 'resume') return { mode: 'resume', reason: '指定续同一对话' };
  if (peak == null) return { mode: 'fresh', reason: '取不到最后一发的水位，稳妥起见开新对话' };
  return peak < handoffFloor
    ? { mode: 'resume', reason: `最后一发水位 ${peak.toLocaleString('en-US')} 低于交接下限 ${handoffFloor.toLocaleString('en-US')}，续同一对话` }
    : { mode: 'fresh', reason: `最后一发水位 ${peak.toLocaleString('en-US')} 已到交接下限 ${handoffFloor.toLocaleString('en-US')}，开新对话从记忆接上` };
}

const quoteSq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;

/** 终端里要打的启动命令。外部参考目录、指定过的模型原样带上（--add-dir 不随会话持久化） */
export function buildLaunchCommand({ mode, claudeSessionId, extraDirs = [], model = '' }) {
  const parts = ['claude'];
  if (mode === 'resume') parts.push('--resume', claudeSessionId);
  for (const d of extraDirs) parts.push('--add-dir', quoteSq(d));
  if (model) parts.push('--model', quoteSq(model));
  return parts.join(' ');
}

/** 实际发进 tmux 的一整行：先进项目目录再启动。界面展示与发送共用这一行，保证所见即所发 */
export function buildShellLine(root, command) {
  return `cd ${quoteSq(root)} && ${command}`;
}

/**
 * 清掉长程留下的投件与暂停文件。不清的话，下次再跑长程时它们会在第一发突然生效。
 * @returns {string[]} 删掉的文件名
 */
export function clearLeftoverInjections(root) {
  const removed = [];
  for (const name of ['pause', 'inject.txt', 'inject!.txt']) {
    const f = path.join(root, '.run', name);
    if (existsSync(f)) { try { unlinkSync(f); removed.push(name); } catch { /* 删不掉就留着，返回里不报 */ } }
  }
  return removed;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * 屏幕上 claude 的输入框是否已就绪（可以粘贴提示词）。只看末尾十几行、先剥 ANSI ——
 * 逐 token 分色的转义码会插进关键词中间，不剥必失配（WebTmux 踩过三次）。
 * ⚠ 不能用"屏上出现 claude"判：刚打进去的 `claude --resume …` 命令本身就含这个词。
 */
export function isClaudeInputReady(screen) {
  const tail = String(screen || '').replace(ANSI, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-14);
  return tail.some((l) => /\? for shortcuts|shift\+tab to cycle|accept edits on|bypass permissions on/i.test(l)
    || /^\s*[│|]?\s*❯\s*$/.test(l) || /^\s*[│|]?\s*❯\s/.test(l));
}

/** 多行提示词用 bracketed paste 包起来：直接发会在第一个换行处提前提交 */
export const bracketedPaste = (text) => `\x1b[200~${text}\x1b[201~`;
