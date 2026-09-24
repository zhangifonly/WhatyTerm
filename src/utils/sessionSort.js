/**
 * 会话列表排序 —— **桌面版与移动版共用这一份**（纯函数，无 React、无 IO）。
 *
 * 为什么必须共用：两端各写一份的后果实测过 —— 桌面是「置顶 → 排序模式 → 门牌号」三层，
 * 移动版只有「needsAction 一层」，而且 needsAction 的口径还只覆盖三类中的一类，
 * 于是同一批会话在手机上和电脑上顺序完全不同，人在两端来回看时对不上号。
 * 排序规则以后再改也只改这里，不会重新漂移。
 */

/** 排序模式：固定顺序（门牌号）/ 最近活跃 / 待处理优先 */
export const SORT_MODES = ['fixed', 'active', 'pending'];
export const SORT_LABELS = { fixed: '固定顺序', active: '最近活跃', pending: '待处理优先' };
export const DEFAULT_SORT = 'fixed';

/** 循环切换：固定 → 活跃 → 待处理 → 固定 */
export const nextSortMode = (mode) => {
  const i = SORT_MODES.indexOf(mode);
  return SORT_MODES[(i < 0 ? 0 : i + 1) % SORT_MODES.length];
};

/** 时间戳，非法/缺失一律归 0 —— NaN 参与比较会让排序结果不确定（NaN !== NaN 恒真） */
const ms = (v) => {
  const t = new Date(v || 0).getTime();
  return Number.isFinite(t) ? t : 0;
};

/**
 * 门牌号：按创建时间升序编号，1 起。
 * 它同时充当**同档内的确定性兜底** —— 没有它，同为「待处理」的几条会话顺序取决于
 * 服务端返回顺序，列表会随增量推送无规律跳动。
 */
export function sessionNumbers(sessions = []) {
  const byCreated = [...(sessions || [])].sort((a, b) => {
    const ta = ms(a?.createdAt);
    const tb = ms(b?.createdAt);
    if (ta !== tb) return ta - tb;
    return String(a?.id).localeCompare(String(b?.id));   // createdAt 相同时用 id 兜底
  });
  const map = {};
  byCreated.forEach((s, i) => { if (s?.id) map[s.id] = i + 1; });
  return map;
}

/**
 * 「需要你看一眼」的会话集合 —— 三类合一，与桌面版红点口径同源。
 *
 * ⚠ 移动版原来只认第三类（空闲等继续），于是屏上挂着确认菜单、或任务报错的会话
 *   在手机列表里不会被置前 —— 恰恰是最该先看的两类。
 *
 * @param {Array} sessions
 * @param {object} aiStatusMap  sessionId -> ai:status 载荷
 */
/**
 * 长程在等你回答的会话。定义只写这一处：条目是长程模式、任务在跑、且执行者停下来等人。
 *
 * ⚠ 长程条目不经过 AI 监控（监控会跳过长程模式），所以 aiStatusMap 里永远没有它们 ——
 *   只看 aiStatusMap 的话，长程等你这件最要紧的事在排序里完全隐形。
 *
 * @param {Array} sessions
 * @param {Array} tasks  长程任务摘要（longrun:task 广播 / longrun:status 的结果）
 */
export function longRunWaitingIds(sessions = [], tasks = []) {
  const bySession = new Map();
  for (const t of tasks || []) if (t?.sessionId) bySession.set(t.sessionId, t);
  const out = new Set();
  for (const s of sessions || []) {
    if (s?.runMode !== 'longrun') continue;
    const t = bySession.get(s.id);
    if (t?.state === 'running' && t.awaitingHuman) out.add(s.id);
  }
  return out;
}

export function needsActionIds(sessions = [], aiStatusMap = {}, longRunTasks = []) {
  const awaiting = new Set();   // 屏上有确认菜单等按键
  const errored = new Set();    // 任务失败要你判断（与"等确认"是两回事，不并档）
  const idle = new Set();       // 空闲等「继续」，且自动操作关着 —— 没人替它按

  for (const s of sessions || []) {
    const st = aiStatusMap?.[s?.id];
    if (!st) continue;
    if (st.actionType === 'select' || st.actionType === 'confirm') awaiting.add(s.id);
  }
  for (const s of sessions || []) {
    const st = aiStatusMap?.[s?.id];
    if (!st || awaiting.has(s.id)) continue;
    if (st.actionType === 'error' || (st.requireConfirmation && st.actionType !== 'text_input')) errored.add(s.id);
  }
  for (const s of sessions || []) {
    const st = aiStatusMap?.[s?.id];
    if (!st?.needsAction || s.autoActionEnabled) continue;   // 自动操作开着的它自己会处理
    if (awaiting.has(s.id) || errored.has(s.id)) continue;
    idle.add(s.id);
  }
  // 长程在等你也算「需要你看一眼」—— 而且是最该先看的：它整轮都停在那里
  return new Set([...longRunWaitingIds(sessions, longRunTasks), ...awaiting, ...errored, ...idle]);
}

/**
 * 实际渲染顺序：置顶永远在最前，其余按当前排序模式，同档内按门牌号。
 *
 * @param {object} o
 * @param {Array} o.sessions
 * @param {Set|Array} [o.pinnedIds]  置顶集合
 * @param {string} [o.sortMode]
 * @param {object} [o.numbers]       门牌号（缺省现算）
 * @param {Set} [o.needIds]          需操作集合（缺省视为空）
 */
export function orderSessions({ sessions = [], pinnedIds, sortMode = DEFAULT_SORT, numbers, needIds } = {}) {
  const list = [...(sessions || [])];
  const pins = pinnedIds instanceof Set ? pinnedIds : new Set(pinnedIds || []);
  const nums = numbers || sessionNumbers(list);
  const needs = needIds instanceof Set ? needIds : new Set(needIds || []);
  const num = (s) => nums[s?.id] || 9999;

  list.sort((a, b) => {
    const pa = pins.has(a?.id) ? 0 : 1;
    const pb = pins.has(b?.id) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (sortMode === 'active') {
      const ta = ms(a?.updatedAt || a?.createdAt);
      const tb = ms(b?.updatedAt || b?.createdAt);
      if (ta !== tb) return tb - ta;                 // 新的在前
    } else if (sortMode === 'pending') {
      const na = needs.has(a?.id) ? 0 : 1;
      const nb = needs.has(b?.id) ? 0 : 1;
      if (na !== nb) return na - nb;
    }
    return num(a) - num(b);                          // 同档内按门牌号，保证顺序确定
  });
  return list;
}

export default { SORT_MODES, SORT_LABELS, DEFAULT_SORT, nextSortMode, sessionNumbers, needsActionIds, longRunWaitingIds, orderSessions };
