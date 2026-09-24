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
 * 前缀兜底只认这些「不改价」的后缀：预览/实验/思考模式。
 *
 * 为什么是白名单（2026-09-24 实测）：原来取任意最长前缀，`claude-opus-5-5` 被悄悄按 `claude-opus-5` 计价
 * （3572 条记录），界面上不报缺价 —— 新版本号、`-mini`/`-flash`/`-pro` 这类不同档位都会这样被套旧价，
 * 错了也看不出来。宁可报「不完整」让人去 CC Switch 补一条，不可静默算错。
 */
export const BENIGN_SUFFIX = /^-(preview|exp|experimental|beta|thinking)(-.*)?$/i;

/**
 * 模型名归一化：价格表里查不到时逐级放宽。
 * 实测 `claude-opus-5[1m]` 表里没有，归一到 `claude-opus-5` 误差 −0.34%，可接受。
 * @returns {string} 表里的条目名；查不到返回 ''（调用方标不完整，绝不记 0）
 */
export function normalizeModelId(model, known = []) {
  return matchModelId(model, known).id;
}

/**
 * 同上，但同时说明是怎么匹配上的：exact | context | date | dots | suffix | ''（没匹配上）。
 * 除 exact 外都是「借用」别的条目的价格，界面据此提示。
 */
export function matchModelId(model, known = []) {
  const raw = String(model || '').trim();
  if (!raw) return { id: '', how: '' };
  if (known.includes(raw)) return { id: raw, how: 'exact' };
  const noCtx = raw.replace(/\[[^\]]*\]$/, '');                 // claude-opus-5[1m] → claude-opus-5
  if (known.includes(noCtx)) return { id: noCtx, how: 'context' };
  const noDate = noCtx.replace(/-20\d{6}$/, '').replace(/-latest$/, '');
  if (known.includes(noDate)) return { id: noDate, how: 'date' };
  // 中转常把 claude-opus-4-8 写成 claude-opus-4.8。只在 claude- 上换：gpt-5.6 的点是正式名的一部分
  const dashed = /^claude-/.test(noDate) ? noDate.replace(/\./g, '-') : noDate;
  if (dashed !== noDate && known.includes(dashed)) return { id: dashed, how: 'dots' };
  // 最长前缀，且剩下的必须是白名单后缀：gpt-5.6-sol-preview → gpt-5.6-sol；claude-opus-5-5 ✗
  const prefix = known.filter((k) => noDate.startsWith(k) && BENIGN_SUFFIX.test(noDate.slice(k.length)))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? { id: prefix, how: 'suffix' } : { id: '', how: '' };
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
