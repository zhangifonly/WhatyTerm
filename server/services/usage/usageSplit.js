/**
 * 把一笔已认领的增量费用拆到各模型（v1.4.78：同一会话用了多个模型时，面板要分模型显示）。
 *
 * 拆分依据是两轮之间各模型折算费用的增长（读取器给的 modelUsd 是各模型累计折算值）。
 * 只按比例分配、总额以调用方给的 delta 为准：delta 已经过「认领后增量」两道闸，
 * 拆分不能改变会话总额，否则日账合计会和会话累计对不上。
 * 各模型都没增长（比如 Claude 刚换了锚点、分模型累计被清零）时，整笔记给主模型。
 */
const KEYS = ['input', 'cacheRead', 'cacheWrite', 'output'];

/**
 * @param {number} delta 本轮要记的总额
 * @param {object} prevUsd / curUsd 各模型累计折算费用 {model: usd}
 * @param {string} mainModel 兜底模型
 * @param {object} [prevTok] / [curTok] 各模型累计 token {model: {input,...}}，有就一并给出 token 增量
 * @returns {Array<{model, usd, tokens}>} usd 之和恒等于 delta
 */
export function splitDelta(delta, prevUsd = {}, curUsd = {}, mainModel = '', prevTok = null, curTok = null) {
  const grow = {};
  let total = 0;
  for (const [m, v] of Object.entries(curUsd || {})) {
    const g = (v || 0) - ((prevUsd || {})[m] || 0);
    if (g > 0) { grow[m] = g; total += g; }
  }
  const tokensOf = (m) => {
    if (!curTok?.[m]) return {};
    const out = {};
    for (const k of KEYS) out[k] = Math.max(0, (curTok[m][k] || 0) - ((prevTok || {})[m]?.[k] || 0));
    return out;
  };
  if (!(total > 0)) return [{ model: mainModel || '', usd: delta, tokens: tokensOf(mainModel) }];
  const models = Object.keys(grow);
  let assigned = 0;
  return models.map((m, i) => {
    // 最后一个取余数，保证合计与 delta 逐位相等（浮点累加误差不能漏进日账）
    const usd = i === models.length - 1 ? delta - assigned : delta * (grow[m] / total);
    assigned += usd;
    return { model: m, usd, tokens: tokensOf(m) };
  });
}

/** 上一轮费用最大的模型：本轮拆不出模型时的兜底（比记成「未标模型」有用） */
export function mainModelOf(modelUsd = {}) {
  let best = '', max = -1;
  for (const [m, v] of Object.entries(modelUsd || {})) if (m && v > max) { max = v; best = m; }
  return best;
}

/**
 * 同一个模型在记录里有两种写法（实测 claude-opus-5.5 与 claude-opus-5-5 并存），面板上合成一行。
 * 归一：小写、点换横线。显示名取花费更多的那种写法。空模型名的行放最后，名字如实写「未区分模型」。
 */
export const UNNAMED_MODEL = '未区分模型';
export function mergeModelAliases(rows = []) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.model ? r.model.toLowerCase().replace(/\./g, '-') : '';
    const g = groups.get(key);
    if (!g) { groups.set(key, { ...r, _top: r.usd }); continue; }
    if (r.usd > g._top) { g.model = r.model; g._top = r.usd; }
    for (const k of ['usd', 'today', 'input', 'output', 'cacheRead']) g[k] = (g[k] || 0) + (r[k] || 0);
  }
  return [...groups.values()].map(({ _top, ...r }) => ({ ...r, model: r.model || UNNAMED_MODEL }))
    .sort((a, b) => (a.model === UNNAMED_MODEL) - (b.model === UNNAMED_MODEL) || b.usd - a.usd);
}
