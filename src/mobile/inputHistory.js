/**
 * 移动版输入历史（按会话分开，存本机 localStorage）。
 *
 * 为什么要有：手机上打字费劲，而实际发的指令高度重复（「继续」「跟上测试」「git status」）。
 * 每次重新敲一遍是纯浪费。
 *
 * 为什么按会话分开：不同项目的指令互不相干，混在一起候选里全是别的项目的东西。
 * 为什么存本机：这是打字习惯，不值得占服务端存储；而且手机与电脑的输入方式本就不同
 * （电脑上有终端可直接敲），共用一份反而互相干扰。
 */

const KEY_PREFIX = 'wt_m_hist_';

/** 每个会话最多留几条。20 条足够覆盖常用指令，又不会让候选列表长到要翻页 */
export const MAX_ITEMS = 20;

/** 单条最长。太长的多是粘贴的大段文本，留着占地方又选不中 */
export const MAX_LEN = 200;

const keyOf = (sessionId) => `${KEY_PREFIX}${sessionId}`;

/**
 * 读某会话的历史，最近用过的在前。
 * localStorage 在隐私模式下会抛异常 —— 一律吞掉返回空数组，历史读不出来不该让输入框不能用。
 */
export function loadHistory(sessionId) {
  if (!sessionId) return [];
  try {
    const raw = localStorage.getItem(keyOf(sessionId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x) : [];
  } catch {
    return [];
  }
}

/**
 * 记一条。返回新的历史数组（调用方用它更新 state，避免再读一次 localStorage）。
 *
 * 规则：
 * - 去重后**提到最前**（而不是简单追加）—— 刚用过的下次最可能再用
 * - 空白、超长的不记
 * - 单字符不记（1/2/3/Esc 这些本来就有专门按钮，进历史只会挤掉真正有用的）
 */
export function pushHistory(sessionId, text) {
  const t = String(text || '').trim();
  if (!sessionId || !t || t.length > MAX_LEN || t.length < 2) return loadHistory(sessionId);
  const next = [t, ...loadHistory(sessionId).filter((x) => x !== t)].slice(0, MAX_ITEMS);
  try { localStorage.setItem(keyOf(sessionId), JSON.stringify(next)); } catch { /* 存不了就只当次有效 */ }
  return next;
}

/** 清空某会话的历史 */
export function clearHistory(sessionId) {
  try { localStorage.removeItem(keyOf(sessionId)); } catch { /* 忽略 */ }
  return [];
}

/**
 * 按已输入的前缀筛候选。
 *
 * 前缀为空时给全部（刚点进输入框就能看到最近用过的几条）。
 * 匹配不分大小写，且**前缀完全相同的那条不给**（选它等于没变化，白占一个位置）。
 */
export function suggest(history, prefix, limit = 6) {
  const p = String(prefix || '').trim().toLowerCase();
  const list = (history || []).filter((x) => typeof x === 'string' && x);
  if (!p) return list.slice(0, limit);
  return list.filter((x) => {
    const l = x.toLowerCase();
    return l.startsWith(p) && l !== p;
  }).slice(0, limit);
}

export default { loadHistory, pushHistory, clearHistory, suggest, MAX_ITEMS, MAX_LEN };
