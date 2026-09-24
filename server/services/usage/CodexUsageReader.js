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
 * 读一个 rollout 的累计费用。
 * @returns {object|null} null = 文件没动；{cumUsd, costComplete, tokens, model, ...}
 */
export function readCodexRun(cur, pricing, fallbackModel = '') {
  if (!cur?.filePath || !existsSync(cur.filePath)) return null;
  const st = statSync(cur.filePath);
  if (String(st.ino) === String(cur.inode) && st.size === cur.fileSize && st.mtimeMs === cur.fileMtime) return null;
  let parsed = null;
  for (const bytes of TAIL_STEPS) {
    parsed = parseCodexTail(tail(cur.filePath, st.size, bytes));
    if (parsed || bytes >= st.size) break;
  }
  if (!parsed) return { cumUsd: 0, costComplete: false, tokens: null, model: '', unknownModels: [],
    inode: String(st.ino), fileSize: st.size, fileMtime: st.mtimeMs };
  const billable = codexBillable(parsed.total);
  // 模型名三级兜底：尾部 → 头部 → 调用方（会话已知模型 / codex 配置默认）。查不到价就标不完整，绝不按 0 计价
  const model = parsed.model || findModelInHead(cur.filePath) || fallbackModel;
  const { price, modelId, source } = pricing.get(model);
  const usd = priceUsage(billable, price);
  return {
    cumUsd: usd === null ? 0 : usd,
    costComplete: usd !== null,
    unknownModels: usd === null ? [model || '(未知模型)'] : [],
    autoModels: usd !== null && source === 'litellm' ? [model] : [],
    tokens: billable, model: modelId || model,
    inode: String(st.ino), fileSize: st.size, fileMtime: st.mtimeMs,
  };
}
