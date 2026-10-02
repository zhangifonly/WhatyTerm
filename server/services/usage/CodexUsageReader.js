/**
 * Codex 会话的累计用量：读 rollout 文件尾部的最后一条 token_count
 *
 * 实测（135 个本地 rollout）：`total_token_usage` 是累计值且单调不回退（跨 14 次 compacted 也不退），
 * `cached ⊂ input`、`reasoning ⊂ output`、`input + output === total_tokens` 恒等；
 * 累计值就在 EOF 最后一条 token_count 里，所以尾读 256KB 足够（比 Claude 那边便宜得多），找不到再逐级放宽。
 * Codex 不写费用，按 CC Switch 价格表折算。
 */

import { openSync, readSync, closeSync, statSync, existsSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { codexBillable, priceUsage } from './costMath.js';
import { scanCodexChunk, freshCodexState, CODEX_SCAN_VERSION } from './codexScan.js';

const SCAN_CHUNK = 4 * 1024 * 1024;
// 单轮最多扫这么多：iSpring 那份 300MB 记录一口气扫完要 2 秒，期间服务事件循环被占住、终端跟着卡。
// 分几轮扫完，没扫完前返回 pending，不计任何新增费用
export const SCAN_BUDGET = 64 * 1024 * 1024;

export const CODEX_SESSIONS_DIR = () => path.join(os.homedir(), '.codex', 'sessions');
const TAIL_STEPS = [256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024];

function readAt(filePath, from, bytes) {
  const buf = Buffer.alloc(Math.max(0, bytes));
  const fd = openSync(filePath, 'r');
  try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
  return buf.toString('utf8');
}

function tail(filePath, size, bytes) {
  const from = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - from);
  const fd = openSync(filePath, 'r');
  try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
  return buf.toString('utf8');
}

const lastMatch = (text, re) => {
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m;
  return last;
};

/** 尾部解析：最后一条 total_token_usage 与最后出现的 model */
export function parseCodexTail(text) {
  const usage = lastMatch(text, /"total_token_usage":\{[^}]*\}/g);
  if (!usage) return null;
  let total;
  try { total = JSON.parse(`{${usage[0]}}`).total_token_usage; } catch { return null; }
  const model = lastMatch(text, /"model":"([^"]+)"/g);
  return { total, model: model ? model[1] : '' };
}

/** rollout 文件首行 session_meta 里的 cwd（定位这份记录属于哪个目录） */
export function readRolloutCwd(filePath) {
  try {
    const line = readAt(filePath, 0, 8192).split('\n')[0];
    return (line.match(/"cwd":"([^"]+)"/) || [])[1] || '';
  } catch { return ''; }
}

/**
 * 是否子代理的 rollout：主线程派生的子代理各写一份记录（session_meta.source.subagent，实测 iSpring 目录里
 * 最新的几份全是子代理，用的是 luna / astra）。它们的花费照常算进会话，但「当前模型」只认主线程
 */
export function isSubagentRollout(filePath) {
  try { return /"source":\{"subagent"/.test(readAt(filePath, 0, 8192).split('\n')[0]); } catch { return false; }
}

/** 空闲/旧会话的尾部可能没有 model 字段：到头部再找一次 */
export function findModelInHead(filePath, bytes = 65536) {
  try { return (readAt(filePath, 0, bytes).match(/"model":"([^"]+)"/) || [])[1] || ''; } catch { return ''; }
}

/** 列出某工作目录下的 rollout 文件（新的在前）。mtime 早于 since 的跳过 */
export function listCodexRuns(cwd, { since = 0, root = null, limit = 40 } = {}) {
  const base = root || CODEX_SESSIONS_DIR();
  if (!existsSync(base)) return [];
  const files = [];
  const walk = (dir, depth) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name);
      if (name.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (name.isFile() && name.name.startsWith('rollout-') && name.name.endsWith('.jsonl')) {
        const st = statSync(p);
        if (st.mtimeMs >= since) files.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  };
  try { walk(base, 0); } catch { /* 目录结构异常时按没有记录处理 */ }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
    .filter((f) => readRolloutCwd(f.path) === cwd);
}

/**
 * 读一个 rollout 的累计费用，按模型分开计价（v1.4.78，旧版按尾部模型给整份记录计价）。
 * 游标 cur.byModel 存扫描状态（各模型累计 token、当前模型、上一条累计值），每轮只扫新增部分。
 * @returns {object|null} null = 文件没动；{cumUsd, costComplete, tokens, model, modelUsd, byModel, scanOffset, ...}
 */
export function readCodexRun(cur, pricing, fallbackModel = '', budget = SCAN_BUDGET) {
  if (!cur?.filePath || !existsSync(cur.filePath)) return null;
  const st = statSync(cur.filePath);
  const sameFile = String(st.ino) === String(cur.inode);
  if (sameFile && st.size === cur.fileSize && st.mtimeMs === cur.fileMtime) return null;

  // 能接着上次扫：同一个文件、没被截短、状态是新版格式。否则从头扫（换模型前的旧游标只有尾部累计，没法拆）
  const resume = sameFile && cur.byModel?.v === CODEX_SCAN_VERSION && st.size >= (cur.scanOffset || 0);
  // rescan：这一份是从头重扫的（首见、换了文件、或旧版游标）。扫完后调用方要重定认领基线，
  // 否则新旧两种算法的累计差会被当成本轮新花的钱
  const state = resume ? { ...freshCodexState(), ...cur.byModel, models: { ...cur.byModel.models }, remainder: '' }
    : { ...freshCodexState(), rescan: true };
  const from = resume ? (cur.scanOffset || 0) : 0;
  const stop = Math.min(st.size, from + budget);
  const fd = openSync(cur.filePath, 'r');
  try {
    for (let pos = from; pos < stop; pos += SCAN_CHUNK) {
      const end = Math.min(stop, pos + SCAN_CHUNK);
      const buf = Buffer.alloc(end - pos);
      readSync(fd, buf, 0, buf.length, pos);
      scanCodexChunk(buf.toString('utf8'), state, fallbackModel);
    }
  } finally {
    closeSync(fd);
  }
  if (stop < st.size) {
    const { remainder: rest, ...partial } = state;
    // fileSize 记成 -1：下一轮一定不会被「文件没动」挡掉，从这里接着扫
    return { pending: true, progress: stop / st.size, byModel: partial, scanOffset: stop - Buffer.byteLength(rest, 'utf8'),
      inode: String(st.ino), fileSize: -1, fileMtime: -1 };
  }
  const rescanned = !!state.rescan;
  delete state.rescan;
  if (!state.lastTotal) return { cumUsd: 0, costComplete: false, tokens: null, model: '', unknownModels: [], modelUsd: {},
    byModel: { ...state, remainder: undefined }, scanOffset: st.size - Buffer.byteLength(state.remainder, 'utf8'),
    inode: String(st.ino), fileSize: st.size, fileMtime: st.mtimeMs };

  let cumUsd = 0;
  const modelUsd = {}, modelTokens = {}, unknownModels = [], autoModels = [];
  for (const [model, usage] of Object.entries(state.models)) {
    if (!(usage.input || usage.output || usage.cacheRead || usage.cacheWrite)) continue;
    const { price, modelId, source } = pricing.get(model || fallbackModel);
    const usd = priceUsage(usage, price);
    if (usd === null) { unknownModels.push(model || '(未知模型)'); continue; }   // 查不到价绝不按 0 计
    if (source === 'litellm') autoModels.push(model);
    const key = modelId || model;
    modelUsd[key] = (modelUsd[key] || 0) + usd;
    const tk = modelTokens[key] || (modelTokens[key] = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    for (const k of Object.keys(tk)) tk[k] += usage[k] || 0;
    cumUsd += usd;
  }
  const { remainder, ...saved } = state;
  return {
    rescanned, cumUsd, costComplete: unknownModels.length === 0,
    unknownModels, autoModels, modelUsd, modelTokens,
    tokens: codexBillable(state.lastTotal), model: pricing.get(state.curModel).modelId || state.curModel,
    byModel: saved, scanOffset: st.size - Buffer.byteLength(remainder, 'utf8'),
    inode: String(st.ino), fileSize: st.size, fileMtime: st.mtimeMs,
  };
}
