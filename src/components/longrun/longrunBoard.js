/**
 * 长程任务看板：前端纯逻辑（对应原版 web.py 页面脚本，可单测）
 *
 * 时间线条目由后端归类后随事件推来（ev._entry），这里**不重复实现归类规则**。
 * 首次打开取快照，之后增量 applyEvent，字段语义与后端 LongRunBoard.handle 一致。
 *
 * 相对原版页面脚本修正的四处不一致（原版调研报告 §8）：
 *   1. 增量时时间线上限 400 ≠ 后端 1000 → 统一 1000
 *   2. 后端从不清 inject，刷新后「已注入，续跑中」卡片常驻 → 快照里注入之后已有发送就清掉
 *   3. 隐藏过程明细时计数仍显示「含过程 N」→ 只在显示时计入
 *   4. 不勾「折叠长内容」时非过程长条目显示「收起」但点了没反应 → 此时不给「收起」
 */

export const MAX_TIMELINE = 1000;
export const MAX_TRACE = 600;
export const MAX_LOG = 500;

export const VERDICT_LABEL = {
  continue: '未完成，已催继续',
  project_done: '项目已完成',
  decide: '监督者代你作答',
  needs_human: '需人类给意见',
};
export const STOP_LABEL = {
  project_done: '项目已完成', needs_human: '等待人类', budget: '预算耗尽',
  max_legs: '调用次数上限', error: '连续异常', interrupted: '已中断',
};
export const ROLE_ICON = {
  injected: '↳', executor: '▌', supervisor: '◆', human: '☺', memory: '⌸', handoff: '⇄',
  alert: '!', tool: '·', system: '—', thinking: '✳', toolout: '←', say: '▎', decided: '◈',
};
export const INJECT_PHASE = { waiting: '等工具间隙…', sent: '已发中断，等它收尾', applied: '已注入，续跑中' };
/** 过程明细：默认折叠成一行，可整体隐藏 */
export const TRACE_ROLES = new Set(['thinking', 'tool', 'toolout']);

/** 暂停时发给执行者的安全措辞：暂停不是终止，写"停下别干了"会留在会话历史里与继续指令矛盾 */
export const PAUSE_TEMPLATE = '先停一下，把当前在做的这一步收个尾、记下进度。我看完就让你接着做，不要写"任务终止"之类的结论。';

export function fmtDur(s) {
  const n = Math.round(s || 0);
  if (n < 60) return `${n}s`;
  return `${Math.floor(n / 60)}m${String(n % 60).padStart(2, '0')}s`;
}

export function firstLine(s) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > 90 ? `${one.slice(0, 90)}…` : one;
}

export const clockOf = (at) => new Date(at * 1000).toLocaleTimeString('zh-CN', { hour12: false });

const pushCap = (arr, item, max) => {
  const next = [...arr, item];
  return next.length > max ? next.slice(next.length - max) : next;
};
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

/** 快照入场：补齐数组；清掉已被后续发送消化的注入卡片（修正 2）。 */
export function normalizeSnapshot(snap) {
  if (!snap) return null;
  const s = { ...snap, logs: snap.logs || [], timeline: snap.timeline || [], trace: snap.trace || [] };
  if (s.inject?.phase === 'applied'
    && s.timeline.some((e) => e.role === 'injected' && e.at >= (s.inject.at || 0))) {
    s.inject = null;
  }
  return s;
}

/** 增量应用一条事件，返回新状态（不改原对象）。 */
export function applyEvent(state, ev) {
  if (!state || !ev) return state;
  const s = { ...state };
  const k = ev.kind;
  if (ev._entry) {
    if (ev._entry.stream === 'trace') s.trace = pushCap(s.trace, ev._entry, MAX_TRACE);
    else s.timeline = pushCap(s.timeline, ev._entry, MAX_TIMELINE);
  }
  if (k === 'need_human') s.need_human = { node: ev.node ?? null, question: ev.question, needs: ev.needs, reason: ev.reason };
  else if (k === 'need_human.done') s.need_human = null;
  if (k === 'exec.inject.waiting' || k === 'exec.inject.sent' || k === 'inject.applied') {
    s.inject = { phase: k.split('.').pop(), text: ev.text ?? '', at: ev.at ?? 0 };
  } else if (k === 'send' && s.inject?.phase === 'applied') {
    s.inject = null;                       // 注入已发出去，卡片收起
  }
  switch (k) {
    case 'log': s.logs = pushCap(s.logs, { at: ev.at, message: ev.message ?? '' }, MAX_LOG); break;
    case 'send':
      s.current_label = ev.label ?? '';
      s.legs = has(ev, 'leg') ? ev.leg : s.legs;
      s.last_tool = []; s.context = {}; s.supervisor = null;
      break;
    case 'result':
      s.spent_usd = (s.spent_usd || 0) + (ev.cost_usd || 0);
      s.running_cost = 0;
      s.session_id = ev.session_id || s.session_id;
      break;
    case 'handoff.done': s.handoffs = has(ev, 'count') ? ev.count : s.handoffs; break;
    case 'maintenance.done': s.maintenances = has(ev, 'count') ? ev.count : s.maintenances; break;
    case 'exec.context':
      s.context = { occupied: ev.occupied ?? 0, peak: ev.peak ?? 0, limit: ev.limit ?? 0 };
      s.running_cost = ev.cost_estimate || 0;        // "本发至今"的全量，直接赋不累加
      break;
    case 'exec.tool': s.last_tool = ev.names || []; break;
    case 'supervisor':
      s.supervisor = { phase: ev.phase ?? null, verdict: ev.verdict ?? null, confidence: ev.confidence ?? null,
        reason: ev.reason ?? null, reply: ev.reply ?? null, needs_from_human: ev.needs_from_human ?? null, question: ev.question ?? null };
      break;
    case 'supervisor.decided': s.decisions = (s.decisions || 0) + 1; break;
    case 'paused': s.paused = { label: ev.label ?? '', path: ev.path ?? '', at: ev.at ?? 0 }; break;
    case 'resumed': s.paused = null; break;
    case 'finished':
      s.finished = { stop: ev.stop ?? null, legs: ev.legs ?? null, handoffs: ev.handoffs ?? null, maintenances: ev.maintenances ?? null,
        decisions: ev.decisions ?? null, elapsed_s: ev.elapsed_s ?? null, cost_usd: ev.cost_usd ?? null, needs_from_human: ev.needs_from_human ?? null };
      break;
    default: break;
  }
  return s;
}

// ── 显示辅助 ─────────────────────────────────────────────────

/** 对话与过程明细按时间戳合并；隐藏过程明细时只给主流。 */
export function mergedEntries(state, showTrace) {
  const main = state?.timeline || [];
  if (!showTrace) return main;
  return [...main, ...(state.trace || [])].sort((a, b) => (a.at - b.at) || (a.id - b.id));
}

/** 计数文案（修正 3：隐藏过程明细时不再说"含过程 N"）。 */
export function timelineCount(state, showTrace) {
  const n = mergedEntries(state, showTrace).length;
  const nTrace = showTrace ? (state?.trace || []).length : 0;
  return n ? `${n} 条${nTrace ? `（含过程 ${nTrace}）` : ''}` : '';
}

/**
 * 一条条目的显示方式。
 * 过程明细一律默认折叠成一行（篇幅最大，多数时候扫一眼就够）；旁白是过程主线，阈值放宽到 900 字。
 * @returns {{open, collapsible, head, len, isTrace}}
 */
export function entryView(e, { fold, expanded }) {
  const isTrace = TRACE_ROLES.has(e.role);
  const len = (e.body || '').length;
  const limit = e.role === 'say' ? 900 : 260;
  // 修正 4：不折叠时非过程条目本来就常开，不给「收起」
  const collapsible = isTrace || (fold && len > limit);
  const open = expanded.has(e.id) || !collapsible;
  return { open, collapsible, head: e.head || firstLine(e.body), len, isTrace };
}

/** 水位条：分母是硬上限（runner 的 context_limit），超过 80% 变红。 */
export function ctxView(context) {
  const c = context || {};
  if (!c.limit) return { pct: 0, hot: false, text: '水位 —' };
  const pct = Math.min(100, (c.occupied / c.limit) * 100);
  return { pct, hot: pct > 80,
    text: `水位 ${Number(c.occupied).toLocaleString()} / ${Number(c.limit).toLocaleString()} (峰值 ${Number(c.peak).toLocaleString()})` };
}

/** 监督者判定徽章配色：decide 独立配色 —— 有个决定替你做了，需要人扫到时能停一下。 */
export function verdictClass(verdict) {
  if (verdict === 'continue' || verdict === 'project_done') return 'ok';
  return verdict === 'decide' ? 'decide' : 'wait';
}

/** 左侧列表里一条任务的徽标：等人 > 已暂停 > 暂停闸已挂 > 运行中；结束的按停机原因。 */
export function taskBadge(t) {
  if (t.state === 'running') {
    if (t.awaitingHuman) return ['wait', '✋ 等你回答'];
    if (t.halted) return ['wait', '⏸ 已暂停'];
    if (t.pauseArmed) return ['wait', '⏳ 暂停闸已挂'];
    return ['run', '运行中'];
  }
  const stop = t.report?.stop;
  return [stop === 'project_done' ? 'ok' : 'bad', STOP_LABEL[stop] || '已停机'];
}

/** 列表第二行：第 N 发 · 交接 N · $x.xx */
export function taskLine(t) {
  return `第 ${t.legs || 0} 发 · 交接 ${t.handoffs || 0} · $${Number(t.costUsd || 0).toFixed(2)}`;
}
