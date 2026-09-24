/**
 * 两层价格表怎么选（纯函数）：CC Switch（用户手填，优先）+ LiteLLM（自动，补缺）。
 *
 * 优先级不是简单的"先查 CC Switch 再查自动"：
 *   1. CC Switch 确切命中（原名/去上下文档位/去日期/点号写法）
 *   2. 自动表确切命中
 *   3. CC Switch 的后缀借价（-preview 之类）
 *   4. 自动表的后缀借价
 * 理由：`gpt-5.6-sol-preview` 若 LiteLLM 有它自己的价，就不该拿 CC Switch 的 gpt-5.6-sol 去借 ——
 * 确切的价永远胜过借来的价，来源优先级只在同一确切程度内起作用。
 */

import { matchModelId } from './costMath.js';

const NONE = { price: null, modelId: '', how: '', source: '' };

/**
 * @param {string} model
 * @param {object|null} ccs   CC Switch 价格 {id: price}
 * @param {object|null} auto  自动价格 {id: price}
 * @param {{ccsKeys?:string[], autoKeys?:string[]}} [keys] 预先算好的键列表（自动表两千多条，别每次 Object.keys）
 * @returns {{price:object|null, modelId:string, how:string, source:''|'ccswitch'|'litellm'}}
 */
export function resolvePrice(model, ccs, auto, keys = {}) {
  const c = ccs ? matchModelId(model, keys.ccsKeys || Object.keys(ccs)) : { id: '' };
  const a = auto ? matchModelId(model, keys.autoKeys || Object.keys(auto)) : { id: '' };
  const exact = (m) => m.id && m.how !== 'suffix';
  const pick = exact(c) ? ['ccswitch', c, ccs]
    : exact(a) ? ['litellm', a, auto]
      : c.id ? ['ccswitch', c, ccs]
        : a.id ? ['litellm', a, auto] : null;
  if (!pick) return NONE;
  const [source, m, table] = pick;
  return { price: table[m.id], modelId: m.id, how: m.how, source };
}

/**
 * CC Switch 与自动表对同一模型报价不一致（输入或输出价）。CC Switch 照样生效，只是提示它可能过时了。
 * 缓存价不比：两边对缓存写价的口径（5 分钟 / 1 小时档）常不同，比了全是噪音。
 */
export function priceConflict(modelId, ccs, auto) {
  const c = ccs?.[modelId], a = auto?.[modelId];
  if (!c || !a) return null;
  const same = (x, y) => Math.abs(Number(x) - Number(y)) < 1e-9;
  if (same(c.in, a.in) && same(c.out, a.out)) return null;
  return { model: modelId, ccswitch: { in: c.in, out: c.out }, auto: { in: a.in, out: a.out } };
}
