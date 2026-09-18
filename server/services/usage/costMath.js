/**
 * 会话用量与费用：纯算术部分（零 I/O、零 Date.now，参数即全部输入，便于单测）
 *
 * 口径来自实测（2026-09-18）：
 *   · Claude 的 transcript 每条 assistant `usage` 是**当轮上下文占用**，累加与 CLI 自己的账对不上
 *     （同一文件自算 $6.90 vs CLI 自记 $2.48）。所以只对**锚点（cost-state）之后**的增量折算，到新锚点归正。
 *   · Codex 的 `total_token_usage` 是累计值：`cached ⊂ input`、`reasoning ⊂ output`、`input + output === total_tokens`
 *     （135 个 rollout 全部成立）。
 *   · 价格表（CC Switch model_pricing）精度可信：`claude-opus-4-8` 重算 403.50 vs CLI 自记 403.50252。
 */

/** 一轮（60 秒）合法花费的上限。超过必是重锚点/换文件的 bug，钳住并重新定基线，绝不把几千刀一次性记进当天 */
export const MAX_STEP_USD = 200;

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
};

/**
 * 模型名归一化：价格表里查不到时逐级放宽。
 * 实测 `claude-opus-5[1m]` 表里没有，归一到 `claude-opus-5` 误差 −0.34%，可接受。
 */
export function normalizeModelId(model, known = []) {
  const raw = String(model || '').trim();
  if (!raw) return '';
  if (known.includes(raw)) return raw;
  const noCtx = raw.replace(/\[[^\]]*\]$/, '');                 // claude-opus-5[1m] → claude-opus-5
  if (known.includes(noCtx)) return noCtx;
  const noDate = noCtx.replace(/-20\d{6}$/, '').replace(/-latest$/, '');
  if (known.includes(noDate)) return noDate;
  // 最长前缀：gpt-5.6-sol-preview → gpt-5.6-sol
  const prefix = known.filter((k) => noDate.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return prefix || '';
}

/**
 * 一次调用的费用。price 为每百万 token 单价 {in, out, cacheRead, cacheWrite}。
 * 查不到价格返回 null —— **绝不按 0 计价**，0 会被读成"没花钱"。
 */
export function priceUsage(usage, price) {
  if (!price) return null;
  const u = usage || {};
  return (num(u.input) * num(price.in) + num(u.output) * num(price.out)
    + num(u.cacheRead) * num(price.cacheRead) + num(u.cacheWrite) * num(price.cacheWrite)) / 1e6;
}

/** Codex 累计用量 → 可计费口径。cached/cache_write 是 input 的子集，reasoning 已含在 output 里，都不叠加 */
export function codexBillable(total) {
  const t = total || {};
  const input = num(t.input_tokens), cached = num(t.cached_input_tokens), cacheWrite = num(t.cache_write_input_tokens);
  return {
    input: Math.max(0, input - cached - cacheWrite),
    cacheRead: cached,
    cacheWrite,
    output: num(t.output_tokens),
  };
}

/**
 * 累计值 → 本轮增量。任何异常都不产生负数，改为「重新定基线、本轮记 0」。
 * @param {object|null} prev {inode, fileSize, cumUsd}
 * @param {object} next 同上
 */
export function diffCumulative(prev, next) {
  const cum = num(next?.cumUsd);
  if (!prev) return { delta: 0, rebase: true, why: 'first-seen' };
  if (prev.inode !== next.inode) return { delta: 0, rebase: true, why: 'inode-changed' };     // 文件被删后重建
  if (num(next.fileSize) < num(prev.fileSize)) return { delta: 0, rebase: true, why: 'truncated' };
  const d = cum - num(prev.cumUsd);
  if (d < 0) return { delta: 0, rebase: true, why: 'cum-regressed' };                          // /clear 或换文件
  if (d > MAX_STEP_USD) return { delta: MAX_STEP_USD, rebase: true, why: 'clamped' };
  return { delta: d, rebase: false, why: 'ok' };
}

/**
 * 本地日期键 YYYY-MM-DD。
 * ⚠ 不要抄 TokenStatsService 的 `Math.floor(ts/86400000)`：那是 UTC 日，中国用户看到的"今天"会从早上 8 点开始。
 * @param {number} ts 毫秒
 * @param {string} [lastDay] 已记过的最后一天：时钟回拨时不回填历史，写进 lastDay 那一桶
 */
export function localDayKey(ts, lastDay = '') {
  const d = new Date(ts);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return lastDay && key < lastDay ? lastDay : key;
}
