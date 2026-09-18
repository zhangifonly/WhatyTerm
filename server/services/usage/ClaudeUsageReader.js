/**
 * Claude 会话的累计费用：游标式增量扫描 transcript
 *
 * 为什么不尾部读：活跃会话里最后一条 `cost-state` 距 EOF 实测 24MB / 29MB / 36MB，25 个活跃文件里还有 4 个一条都没有。
 * 尾部读 64KB 会静默读成 0，费用永远显示 0 —— 这是本功能最大的坑，改动此文件前先重读这段。
 *
 * 为什么可行：扫描很便宜，实测 45.5MB 全量扫完 49ms（约 1GB/s，含 4063 次 usage 解析）。
 * 首次 bootstrap 从 EOF 向前回溯找锚点（上限 64MB，实测最坏 36.7MB），之后每轮只读新追加的字节。
 *
 * 费用口径：锚点的 totalCostUSD 是 CLI 自己的账（权威），锚点之后的增量按价格表折算（实测偏差 ≤0.5%），
 * 每遇到新锚点自动归正，漂移不累积。
 */

import { openSync, readSync, closeSync, statSync, existsSync } from 'fs';
import { scanChunk } from './transcriptScan.js';
import { priceUsage } from './costMath.js';

export const CHUNK = 4 * 1024 * 1024;
export const BOOTSTRAP_LIMIT = 64 * 1024 * 1024;   // 回溯找锚点的上限（实测最坏 36.7MB）

function readRange(fd, from, to) {
  const len = Math.max(0, to - from);
  if (!len) return Buffer.alloc(0);
  const buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, from);
  return buf;
}

/** 从 EOF 向前回溯，找最后一条 cost-state 所在行的行首偏移；找不到返回 0（全靠折算，标 estimated） */
export function findLastAnchorOffset(fd, size, limit = BOOTSTRAP_LIMIT) {
  const mark = Buffer.from('"type":"cost-state"');
  const floor = Math.max(0, size - limit);
  let end = size;
  while (end > floor) {
    const from = Math.max(floor, end - CHUNK);
    const buf = readRange(fd, from, end);
    const at = buf.lastIndexOf(mark);
    if (at >= 0) {
      const lineStart = buf.lastIndexOf(0x0a, at);   // 回到行首
      return from + (lineStart >= 0 ? lineStart + 1 : 0);
    }
    end = from + mark.length;   // 重叠一点，避免标记跨块被切断
    if (from === floor) break;
  }
  return 0;
}

/**
 * 读一个 run 的当前累计费用。
 * @param {object} cur 游标：{filePath, inode, fileSize, fileMtime, scanOffset, anchorUsd, byModel}
 * @param {object} pricing PricingTable 实例
 * @returns {object|null} null = 文件没动；否则 {cumUsd, costComplete, byModel, scanOffset, inode, fileSize, fileMtime, anchorUsd, unknownModels}
 */
export function readClaudeRun(cur, pricing) {
  if (!cur?.filePath || !existsSync(cur.filePath)) return null;
  const st = statSync(cur.filePath);
  const sameFile = String(st.ino) === String(cur.inode);
  if (sameFile && st.size === cur.fileSize && st.mtimeMs === cur.fileMtime) return null;

  const fd = openSync(cur.filePath, 'r');
  try {
    let anchorUsd = cur.anchorUsd || 0;
    let byModel = sameFile ? { ...(cur.byModel || {}) } : {};
    let from = sameFile && st.size >= cur.scanOffset ? (cur.scanOffset || 0) : 0;
    if (!sameFile || !cur.scanOffset) {          // 首见 / 文件换了世代 → 回溯找锚点
      from = findLastAnchorOffset(fd, st.size);
      anchorUsd = 0; byModel = {};
    }
    let state = { remainder: '', byModel, anchor: null, anchorAt: -1 };
    for (let pos = from; pos < st.size; pos += CHUNK) {
      state = scanChunk(readRange(fd, pos, Math.min(st.size, pos + CHUNK)), state, pos);
      if (state.anchor) { anchorUsd = state.anchor.totalCostUSD; state.anchor = null; }
    }
    const unknownModels = [];
    let post = 0, mainModel = '', mainTokens = -1;
    for (const [model, usage] of Object.entries(state.byModel)) {
      if (model === '<synthetic>') continue;      // CLI 自己合成的记录，不是 API 调用
      const weight = usage.input + usage.cacheRead + usage.output;
      if (weight > mainTokens) { mainTokens = weight; mainModel = model; }   // 用量最大的那个模型报给界面
      const { price } = pricing.get(model);
      const usd = priceUsage(usage, price);
      if (usd === null) { unknownModels.push(model); continue; }
      post += usd;
    }
    return {
      cumUsd: anchorUsd + post,
      costComplete: unknownModels.length === 0 && (anchorUsd > 0 || post > 0 || st.size === 0),
      estimated: anchorUsd === 0,                  // 没有锚点：整份都是折算值
      byModel: state.byModel, unknownModels, model: mainModel,
      scanOffset: st.size - Buffer.byteLength(state.remainder, 'utf8'),
      anchorUsd, inode: String(st.ino), fileSize: st.size, fileMtime: st.mtimeMs,
    };
  } finally {
    closeSync(fd);
  }
}
