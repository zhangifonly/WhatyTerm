/**
 * 长程编排：看板状态（原版 orchestrator/web.py RunState 的逐行移植）
 *
 * 事件 → 看板状态 + 时间线条目。**归类规则与条目文案只在这里维护一份**，条目随事件推给前端 ——
 * 前后端各写一份会慢慢走偏（原版踩过：runner 新增事件忘了加规则，被静默丢弃两次）。
 *
 * 文案按 Python f-string 的格式化行为输出（千分位、浮点 repr、.Nf 的银行家舍入），
 * 由 tests/test-longrun-board.mjs 与原版 RunState 逐条对拍。
 */

export const MAX_LOG = 500;
// 对话时间线容量。全量事件已落盘，页面只留最近若干条 —— 旁白也走这条流，一次长跑几百条很正常
export const MAX_TIMELINE = 1000;
export const MAX_ENTRY_CHARS = 12000;
// 过程明细（思考、工具入参、工具返回）密度高一个量级，与对话分开存，免得把提示词原文与判定挤掉
export const MAX_TRACE = 600;
export const MAX_TRACE_CHARS = 4000;

// ── Python 格式化行为 ───────────────────────────────────────

const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
/** dict.get(k, d)：键存在就返回其值（哪怕是 null），不存在才用默认值。 */
const get = (o, k, d = null) => (has(o, k) ? o[k] : d);

/** f"{x}"：None/True/False 与 float repr（1.0 而非 1）。floatish 表示原版这里一定是 float。 */
export function pyStr(v, floatish = false) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return floatish && Number.isInteger(v) ? `${v}.0` : String(v);
  return String(v);
}

/**
 * 精确判断 x·10^digits 是否恰好是 .5（按 double 的真实二进制值，不按浮点乘法的结果）。
 * 例：0.12345 的真实值略大于 0.12345，×10000 在浮点里算出 1234.5，但它不是真正的 tie。
 */
function exactHalf(x, digits) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const hi = view.getUint32(0), lo = view.getUint32(4);
  const bexp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp;
  if (bexp === 0) exp = -1074;                         // 次正规数
  else { mant |= 1n << 52n; exp = bexp - 1075; }
  if (mant === 0n || exp >= 0) return false;           // 整数不会落在 .5 上
  const num = mant * 10n ** BigInt(digits);            // x·10^d = num / 2^k
  const den = 1n << BigInt(-exp);
  return (num * 2n) % den === 0n && num % den !== 0n;
}

/** f"{x:.Nf}"：真正落在 .5 上时按银行家舍入（Python round-half-even，JS toFixed 进位），其余两者一致。 */
export function pyFixed(v, digits) {
  const x = Number(v ?? 0);
  if (!Number.isFinite(x) || !exactHalf(x, digits)) return x.toFixed(digits);
  const scaled = Math.abs(x) * 10 ** digits;           // 真 tie 时这个乘法是精确的（.5 可表示）
  const down = Math.floor(scaled);
  const n = down % 2 === 0 ? down : down + 1;
  return (x < 0 ? '-' : '') + (n / 10 ** digits).toFixed(digits);
}

/** f"{x:,}"：整数千分位；浮点保留 repr 小数部分。 */
export function pyComma(v) {
  const x = Number(v ?? 0);
  const [i, f] = String(Math.abs(x)).split('.');
  return (x < 0 ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? `.${f}` : '');
}

/** " ".join(str(x).split())：压成单行。 */
const oneLine = (v) => pyStr(v).split(/\s+/).filter(Boolean).join(' ');
/** s[:n] 按码点截（Python 切片不会切开代理对）。 */
const cut = (s, n) => { const a = Array.from(s); return a.length > n ? a.slice(0, n).join('') : s; };

// ── 归类规则：事件 → 时间线条目。role 决定配色与图标 ─────────────

export const TIMELINE_RULES = [
  ['send', 'injected', '发送给执行者'],
  ['result', 'executor', '执行者输出'],
  ['exec.thinking', 'thinking', '执行者思考'],
  // 每轮的过程性旁白。不收的话看板上只剩最后一条文本（final_text 逐轮覆盖），中间叙述全丢
  ['exec.text', 'say', '执行者说'],
  ['exec.tool', 'tool', '调用工具'],
  ['exec.tool_result', 'toolout', '工具返回'],
  ['supervisor', 'supervisor', '监督者判定'],
  // 代答以委托人口吻原样发出、不带来源标注 —— 看板是事后发现"这个决定不是我做的"的唯一地方
  ['supervisor.decided', 'decided', '监督者代你作答'],
  // 收尾发进了黑洞：交接的全部价值在收尾，失败时原本只有一行"水位 0 · $0.0000"
  ['wrapup.empty', 'alert', '收尾返回空'],
  // 后台 subagent 的等待：主线一句话不说，不标出来分不清在等 agent 还是挂死
  ['exec.tasks.waiting', 'system', '等后台任务'],
  ['exec.tasks.timeout', 'alert', '后台任务等超时'],
  // 暂停/继续：人回来看时要能分辨"停着"和"挂死"，两者在看板上都表现为不动
  ['paused', 'alert', '已暂停'],
  ['resumed', 'system', '已继续'],
  ['need_human', 'alert', '等待人类'],
  ['need_human.done', 'human', '人类回复'],
  ['maintenance.start', 'memory', '记忆维护开始'],
  ['maintenance.done', 'memory', '记忆维护完成'],
  ['handoff.start', 'handoff', '上下文交接开始'],
  ['handoff.done', 'handoff', '上下文交接完成'],
  ['finished', 'system', '运行结束'],
];

/** 归入过程明细（可整体隐藏、默认折叠）的角色 */
export const TRACE_ROLES = new Set(['thinking', 'tool', 'toolout']);

/** 折叠态的单行摘要 —— 要能一眼看出这步在动什么。空串时前端退回正文首行。 */
export function entryHead(kind, ev) {
  if (kind === 'exec.tool') {
    const calls = get(ev, 'calls') || [];
    if (calls.length) {
      return calls.map((c) => pyStr(get(c, 'name', '')) + (get(c, 'brief') ? `(${c.brief})` : '')).join(' · ');
    }
    return (get(ev, 'names') || []).join(', ');
  }
  if (kind === 'exec.tool_result') {
    const mark = get(ev, 'is_error') ? '✗ 出错' : '✓';
    return `${mark} ${get(ev, 'name', '') || '工具'} → ${cut(oneLine(get(ev, 'text', '')), 70)}`;
  }
  if (kind === 'exec.thinking') return cut(oneLine(get(ev, 'text', '')), 90);
  return '';
}

/** 条目正文。与原版逐字一致；返回空串表示这条不上时间线。 */
export function entryBody(kind, ev) {
  const s = (k, d = '') => pyStr(get(ev, k, d));
  switch (kind) {
    case 'send':
      return `【${s('label')}】（${get(ev, 'resume') ? '续同一会话' : '新会话'}）\n\n${s('text')}`;
    case 'result':
      return `${s('exit_reason')} · 水位 ${pyComma(get(ev, 'context_peak', 0))} · ${pyStr(get(ev, 'duration_s', 0), true)}s `
        + `· $${pyFixed(get(ev, 'cost_usd', 0), 4)}\n\n${s('text')}`;
    case 'exec.thinking':
    case 'exec.text':
      return get(ev, 'text', '') ?? '';            // 原版为 None 时条目不上时间线
    case 'exec.tool': {
      const calls = get(ev, 'calls') || [];
      if (!calls.length) return `→ ${(get(ev, 'names') || []).join(', ')}`;   // 旧格式事件（无 calls）仍要能显示
      return calls.map((c) => `→ ${pyStr(get(c, 'name', ''))}\n${pyStr(get(c, 'detail', ''))}`).join('\n\n');
    }
    case 'exec.tool_result':
      return `${(get(ev, 'is_error') ? '✗ ' : '') + (get(ev, 'name') || '工具')} 返回:\n${s('text')}`;
    case 'supervisor': {
      const parts = [`判定: ${s('verdict')}（置信度 ${pyFixed(get(ev, 'confidence', 0), 2)}）`, `依据: ${s('reason')}`];
      if (get(ev, 'reply')) parts.push(`代你答复: ${ev.reply}`);
      if (get(ev, 'needs_from_human')) parts.push(`需人类提供: ${ev.needs_from_human}`);
      return parts.join('\n');
    }
    case 'supervisor.decided':
      return `监督者依需求文档代你答复（置信度 ${pyFixed(get(ev, 'confidence', 0), 2)}），已原样发给执行者:\n`
        + `${s('text')}\n\n依据: ${s('reason')}`;
    case 'exec.tasks.waiting':
      return `主线已说完，但还有 ${s('count', 0)} 个后台任务在跑，等它们收尾（上限 ${pyFixed((get(ev, 'limit') || 0) / 60, 0)} 分钟）。\n`
        + `${s('names')}\n\n不等的话进程一关，这些 subagent 会连坐死掉，产出全丢。`;
    case 'exec.tasks.timeout':
      return `等了 ${pyFixed((get(ev, 'waited') || 0) / 60, 1)} 分钟，仍有 ${s('count', 0)} 个后台任务没收尾，按上限收工。\n`
        + '这些任务会随进程退出而中止，它们的产出可能不完整。\n若这是常态，把 --task-wait 调大。';
    case 'wrapup.empty':
      return `第 ${s('count', 0)} 次交接的收尾提示词发出后，CLI 一个 turn 都没跑就回了 success（水位 0、费用 $0）。\n`
        + '原因：上一发是墙钟超时被无条件终止的，会话留在工具执行中途，恢复即空返回。\n'
        + '处置：开新会话补做一次收尾——它读记忆与工作树复述，内容会比正常收尾薄。';
    case 'paused':
      return `已暂停，下一发「${s('label')}」暂不派发。\n删掉 ${s('path')} 即继续。\n执行者停在上一发结束处，暂停期间不烧钱。`;
    case 'resumed':
      return `已继续，暂停了 ${pyFixed((get(ev, 'paused_s') || 0) / 60, 1)} 分钟，正在派发「${s('label')}」`;
    case 'need_human':
      return `需要人类的意见: ${s('needs')}\n\n执行者说:\n${s('question')}`;
    case 'need_human.done':
      return get(ev, 'text', '') || '(未回复，已停机)';
    case 'maintenance.start': return `第 ${s('count', 0)} 轮记忆维护开始（维护提示词 1、2 依次执行）`;
    case 'maintenance.done': return `第 ${s('count', 0)} 轮记忆维护完成`;
    case 'handoff.start': return `第 ${s('count', 0)} 次交接 —— ${s('reason')}`;
    case 'handoff.done':
      return `第 ${s('count', 0)} 次交接完成${get(ev, 'commit') ? `，快照 commit ${ev.commit}` : ''}`;
    case 'finished':
      return `停机原因: ${s('stop')}\n调用 ${s('legs', 0)} 次 · 交接 ${s('handoffs', 0)} 次 · `
        + `维护 ${s('maintenances', 0)} 次 · 监督者代答 ${s('decisions', 0)} 次\n`
        + `耗时 ${pyStr(get(ev, 'elapsed_s', 0), true)}s · 费用 $${pyFixed(get(ev, 'cost_usd', 0), 4)}`
        + (get(ev, 'needs_from_human') ? `\n需人类提供: ${ev.needs_from_human}` : '');
    default: return '';
  }
}

/** 有界队列（deque(maxlen)）：超出时丢最旧的。 */
function pushBounded(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

const pick = (ev, keys) => Object.fromEntries(keys.map((k) => [k, get(ev, k)]));

export class LongRunBoard {
  /**
   * @param {object} o  title requirement sandbox startedAt(秒) replay replayUntil(秒)
   */
  constructor(o = {}) {
    this.title = o.title || '';
    this.requirement = o.requirement || '';
    this.sandbox = o.sandbox || '';
    this.spent_usd = 0.0;
    // 进行中那一发的估算花费。与已结算分开：一发能跑一两小时，期间结算值一动不动，合成一个数会让人低估
    this.running_cost = 0.0;
    this.inject = null;          // 人工打断的当前阶段
    this.paused = null;          // 非空 = 停在派发口。与 inject 分开：暂停时执行者已经结束，不是"正在被打断"
    this.context = {};
    this.logs = [];
    this.last_tool = [];
    this.supervisor = null;
    this.finished = null;
    this.started_at = o.startedAt ?? Date.now() / 1000;
    // 回放：耗时按事件区间算，不按 now —— 否则翻前天那轮会显示跑了两天
    this.replay = !!o.replay;
    this.replay_until = o.replayUntil ?? null;
    this.legs = 0;
    this.handoffs = 0;
    this.maintenances = 0;
    // 代答次数摆在进度区：代答不标注来源，这是扫一眼就能发现"有 N 个决定不是我做的"的唯一入口
    this.decisions = 0;
    this.current_label = '';
    this.session_id = '';
    this.timeline = [];
    this.trace = [];
    this.need_human = null;      // 非空时页面响铃
    this._seq = 0;               // 条目自增 id：前端折叠状态的键，用下标会在条目被挤出时整体错位
  }

  _toEntry(ev) {
    const kind = get(ev, 'kind', '');
    const rule = TIMELINE_RULES.find(([match]) => match === kind);
    if (!rule) return null;
    const [, role, label] = rule;
    const body = entryBody(kind, ev);
    if (!body) return null;
    const isTrace = TRACE_ROLES.has(role);
    this._seq += 1;
    return {
      id: this._seq,
      at: get(ev, 'at', Date.now() / 1000),
      role,
      label,
      node: get(ev, 'node', ''),
      stream: isTrace ? 'trace' : 'main',
      head: entryHead(kind, ev),
      body: cut(body, isTrace ? MAX_TRACE_CHARS : MAX_ENTRY_CHARS),
    };
  }

  /** 吃一条事件，更新状态。返回要推给前端的事件（带 _entry 时附上时间线条目）。 */
  handle(ev) {
    const kind = get(ev, 'kind', '');
    const entry = this._toEntry(ev);
    if (entry) {
      pushBounded(entry.stream === 'trace' ? this.trace : this.timeline, entry,
        entry.stream === 'trace' ? MAX_TRACE : MAX_TIMELINE);
      ev = { ...ev, _entry: entry };
    }
    switch (kind) {
      case 'log': pushBounded(this.logs, { at: ev.at, message: get(ev, 'message', '') }, MAX_LOG); break;
      case 'send':                          // 新一段开始，清掉上一段的瞬时状态
        this.current_label = get(ev, 'label', '');
        this.legs = get(ev, 'leg', this.legs);
        this.last_tool = [];
        this.context = {};
        this.supervisor = null;
        break;
      case 'result':
        this.spent_usd += get(ev, 'cost_usd') || 0.0;
        this.running_cost = 0.0;            // 已结算，进行中那笔归零
        this.session_id = get(ev, 'session_id') || this.session_id;
        break;
      case 'exec.inject.waiting':
      case 'exec.inject.sent':
      case 'inject.applied':                // 三阶段：等间隙 → 已发中断 → 已注入。让人看得见那句话到哪一步了
        this.inject = { phase: kind.split('.').pop(), text: get(ev, 'text', ''), at: get(ev, 'at', 0) };
        break;
      case 'handoff.done': this.handoffs = get(ev, 'count', this.handoffs); break;
      case 'maintenance.done': this.maintenances = get(ev, 'count', this.maintenances); break;
      case 'exec.context':
        this.context = { occupied: get(ev, 'occupied', 0), peak: get(ev, 'peak', 0), limit: get(ev, 'limit', 0) };
        this.running_cost = get(ev, 'cost_estimate') || 0.0;   // "本发至今"的全量，直接赋值不累加
        break;
      case 'exec.tool': this.last_tool = get(ev, 'names') || []; break;
      case 'supervisor':
        this.supervisor = pick(ev, ['phase', 'verdict', 'confidence', 'reason', 'reply', 'needs_from_human', 'question']);
        break;
      case 'supervisor.decided': this.decisions += 1; break;
      case 'paused': this.paused = { label: get(ev, 'label', ''), path: get(ev, 'path', ''), at: get(ev, 'at', 0) }; break;
      case 'resumed': this.paused = null; break;
      case 'need_human': this.need_human = pick(ev, ['node', 'question', 'needs', 'reason']); break;
      case 'need_human.done': this.need_human = null; break;
      case 'finished':
        this.finished = pick(ev, ['stop', 'legs', 'handoffs', 'maintenances', 'decisions', 'elapsed_s', 'cost_usd', 'needs_from_human']);
        break;
      default: break;
    }
    return ev;
  }

  snapshot() {
    const clone = (o) => (o ? { ...o } : null);
    return {
      title: this.title, requirement: this.requirement, sandbox: this.sandbox,
      spent_usd: this.spent_usd, running_cost: this.running_cost,
      inject: clone(this.inject), paused: clone(this.paused), context: { ...this.context },
      logs: this.logs.slice(), last_tool: this.last_tool.slice(),
      supervisor: this.supervisor, finished: this.finished,
      timeline: this.timeline.slice(), trace: this.trace.slice(), need_human: this.need_human,
      legs: this.legs, handoffs: this.handoffs, maintenances: this.maintenances, decisions: this.decisions,
      current_label: this.current_label, session_id: this.session_id, replay: this.replay,
      elapsed_s: Math.round(((this.replay_until ?? Date.now() / 1000) - this.started_at) * 10) / 10,
    };
  }
}
