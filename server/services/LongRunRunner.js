/**
 * 长程编排：执行层 —— 单次 `claude -p` 调用的生命周期管理
 *
 * 逐函数移植自长程编排器 orchestrator/runner.py。职责边界与原版一致，只做确定性的事：
 *   · 实时累计上下文水位，达阈值后在安全缝隙 kill
 *   · 双计时器 hang 检测（区分"工具在飞"与"真静默"）
 *   · 结构化解析 stream-json，落盘原始事件（.run/events/）供事后复盘
 * 语义判断属于监督者，不在这里。
 *
 * 与原版的差异（均有意为之）：
 *   · 判定逻辑抽成纯函数（watchdogDecide / handleEvent / trackTasks / waitTasks），可离线单测
 *   · 进程连坐：原版靠 Windows Job Object，macOS/Linux 上原版不可用；这里用进程组 + 看门进程补上
 *   · 修原版一处缺陷：非立即注入在工具在飞时会被取走后丢掉，这里暂存到下个间隙再发
 */

import { spawn } from 'child_process';
import { mkdirSync, openSync, writeSync, closeSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { adoptProcessGroup, killProcessGroup } from './LongRunJobGuard.js';

/** `-p` + stream-json 的必需组合。缺 `--verbose` 会直接报错退出（实测）。 */
export const BASE_FLAGS = [
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-prompts', 'none',   // 会触发提示的操作自动拒绝，不挂起
  // 流级活性信号：生成长输出期间 delta 持续到达，据此把"正在生成"与"真挂死"分开
  '--include-partial-messages',
  // 人工打断的前提：往 stdin 写 control_request，CLI 回 control_response 后以
  // error_during_execution 收尾；之后 --resume 同一 session id 可注入新指令。
  // ⚠ 带上它后 `-p <文本>` 会被完全忽略 —— 提示词必须经 stdin 送（见 run）
  '--input-format', 'stream-json',
];

/** 执行者默认可用的工具（原版 session_loop.DEFAULT_TOOLS） */
export const DEFAULT_TOOLS = 'Read,Write,Edit,Glob,Grep,Bash,WebFetch,TodoWrite';

/** stream_event 里代表"模型还在吐字"的子类型。不认 message_start 之类一次性事件 */
const LIVE_DELTAS = new Set(['content_block_delta', 'message_delta']);

/** Bash 在飞（测试/构建可能很久） */
export const SILENCE_TOOL_BASH = 900.0;
/** 其它工具在飞 */
export const SILENCE_TOOL_OTHER = 120.0;
/**
 * 无工具在飞。这一档同时覆盖"模型正在生成下一段输出"。实测误杀（qingming，
 * 2026-09-06）：写完 palette.js 后静默 92 秒被当时的 90s 阈值杀掉，240 秒算力钱花了
 * 却连 result 都没拿到（费用记成 $0.0000）。配合 partial delta 后只在连流都停了才走到。
 */
export const SILENCE_IDLE = 300.0;
/**
 * 送出 interrupt 后等它收尾的宽容期。**这个上限必须存在**：早先见 interrupt_sent
 * 就无条件放行，与读取循环一起把逃生口全堵死，收尾卡住即永久挂死（tafang 2026-09-08）。
 */
export const SETTLE_GRACE = 120.0;
/**
 * 主线说完之后最多再等多久让后台 subagent 收尾。0 = 不等。
 * 实测 30 分钟偏紧（diablo 六个子系统级 agent 等满后仍有 4 个没收尾），子系统级并行建议 5400。
 */
export const TASK_WAIT = 1800.0;
/** 看门狗采样间隔。提成常量是为了让 hang 路径可以被快速测到 */
export const WATCHDOG_INTERVAL = 5.0;
/** 默认墙钟上限（原版 ClaudeRunner.wall_timeout） */
export const WALL_TIMEOUT = 3600.0;

/**
 * 只等这类后台任务：local_agent 会干完并交付，必须等；local_bash 多是
 * dev server 这类长驻服务，永远不会"完成"，等它们等于每发白挂到上限。
 */
const WAITED_TASK_TYPES = new Set(['local_agent']);

/** 推给监控的过程明细上限。Write 的 content、Read 的返回都可能上万字 */
export const DETAIL_CHARS = 2000;
/** 一次 tool_use 里最能说明问题的入参，按此顺序取一个做单行摘要 */
import pricingTable from './usage/PricingTable.js';
import { priceUsage } from './usage/costMath.js';

const SALIENT_KEYS = ['file_path', 'command', 'path', 'pattern', 'url', 'notebook_path',
  'prompt', 'description', 'query'];

// ── 运行中费用估算 ────────────────────────────────────────────
// 首选按**模型单价 × 实际用量**折算（CC Switch 的 model_pricing）。事件流里 usage 四项俱全，
// 折算口径与计费一致。2026-09-18 实测：固定常数在本机模型上估 $30.56 而实收 $9.81（偏高 212%），
// 而长程的「费用刹车」正是拿这个估算值去比预算的 —— 估高了就会在没花到预算时提前停机（jsonfmt2 那次就是）。
// 常数只作为兜底：读不到价格表、或模型不在表里时用，它由已结算的 18 个发次反推（2026-09-06 最小二乘）。
export const COST_PER_CALL = 0.2351;
export const COST_PER_INPUT_TOKEN = 2.70e-6;

/** 单次调用的退出原因（与原版 ExitReason 取值逐一对应） */
export const ExitReason = {
  COMPLETED: 'completed',                       // 正常结束，水位也不高
  /** 自然结束但水位已过交接阈值：按交接处理，与被 kill 同路 */
  COMPLETED_HIGH_CONTEXT: 'completed_high_context',
  BUDGET_KILLED: 'budget_killed',               // 触及水位阈值被主动终止
  /** 运行中估算花费触及刹车线。与水位分开：水位触顶要交接，钱花超了该停机等人 */
  COST_KILLED: 'cost_killed',
  /**
   * 人主动打断。**必须与 ERROR 分开**：CLI 收到 interrupt 后 result 是
   * error_during_execution + is_error:true（实测），照原样归类三次就误判故障停机。
   */
  INTERRUPTED_BY_HUMAN: 'interrupted_by_human',
  HANG_KILLED: 'hang_killed',                   // 静默超时被终止
  WALL_TIMEOUT: 'wall_timeout',                 // 总时长超限被终止
  MAX_TURNS: 'max_turns',                       // 撞 --max-turns 上限
  /**
   * CLI 回了 success 但一个 turn 都没跑。**必须与 COMPLETED 分开**：提示词进了黑洞。
   * 实测（tiantan）：跑满墙钟被 kill 后续那个会话，CLI 209ms 回空 success。
   */
  EMPTY_RESULT: 'empty_result',
  ERROR: 'error',                               // 进程异常
  ASKED_HUMAN: 'asked_human',                   // 疑似停下来等人（由监督者复核）
};

/**
 * 上下文水位计，兼运行中费用估算。
 * 当前占用 ≈ input + cache_read + cache_creation（cache 也占窗口），每个 assistant 事件都更新。
 */
export class ContextMeter {
  constructor({ pricing = pricingTable } = {}) {
    this.pricing = pricing;
    this.peak = 0;
    this.latest = 0;
    this.outputTotal = 0;
    /**
     * message id → input_tokens。**必须按 id 去重**：同一条 assistant 消息按 content
     * block 多次上报同一个 usage（实测连续三条都是 75977），累加会让费用成倍偏高。
     */
    this._calls = new Map();
    /** message id → 完整用量（按模型单价折算用）。与 _calls 同一套去重 */
    this._usage = new Map();
    this._model = '';
  }

  /** 事件流里的模型名（result/assistant 事件都带），后续调用按它查价 */
  setModel(model) { if (model) this._model = String(model); }

  observe(usage, messageId = null, model = '') {
    if (model) this._model = String(model);
    // 空 usage 保持上一次的水位（原版 `if not usage`）—— 不能把水位清成 0
    if (!usage || (typeof usage === 'object' && Object.keys(usage).length === 0)) return this.latest;
    const inp = Number(usage.input_tokens) || 0;
    const occupied = inp
      + (Number(usage.cache_read_input_tokens) || 0)
      + (Number(usage.cache_creation_input_tokens) || 0);
    this.latest = occupied;
    this.peak = Math.max(this.peak, occupied);
    this.outputTotal += Number(usage.output_tokens) || 0;
    if (messageId && !this._calls.has(messageId)) {
      this._calls.set(messageId, inp);
      this._usage.set(messageId, {
        model: usage.model || this._model,
        input: inp,
        output: Number(usage.output_tokens) || 0,
        cacheRead: Number(usage.cache_read_input_tokens) || 0,
        cacheWrite: Number(usage.cache_creation_input_tokens) || 0,
      });
    }
    return occupied;
  }

  get calls() { return this._calls.size; }

  /** 本发至今的估算花费（美元）：优先按模型单价折算，查不到价再回落常数 */
  get costEstimate() {
    let priced = 0, ok = this._usage.size > 0;
    for (const u of this._usage.values()) {
      const { price } = this.pricing?.get?.(u.model || this._model) || {};
      const usd = priceUsage(u, price);
      if (usd === null) { ok = false; break; }
      priced += usd;
    }
    if (ok) return priced;
    let sum = 0;
    for (const v of this._calls.values()) sum += v;
    return this._calls.size * COST_PER_CALL + sum * COST_PER_INPUT_TOKEN;
  }
}

/** 裁剪推给监控的副本。全文在 .run/events/ 里。 */
export function clip(text, limit = DETAIL_CHARS) {
  const s = String(text ?? '');
  return s.length <= limit ? s : `${s.slice(0, limit)}…（共 ${s.length.toLocaleString('en-US')} 字，全文见 .run/events/）`;
}

/** 把工具入参渲染成可读多行文本。 */
export function fmtToolInput(inp) {
  if (!inp || typeof inp !== 'object' || Array.isArray(inp)) return clip(inp);
  return Object.entries(inp)
    .map(([k, v]) => `${k}: ${clip(typeof v === 'string' ? v : JSON.stringify(v))}`)
    .join('\n');
}

/** 单行摘要用的关键入参值。取不到就空着，不硬凑。 */
export function toolBrief(inp) {
  if (!inp || typeof inp !== 'object' || Array.isArray(inp)) return '';
  for (const key of SALIENT_KEYS) {
    const v = inp[key];
    if (typeof v === 'string' && v.trim()) {
      const one = v.split(/\s+/).filter(Boolean).join(' ');
      return one.slice(0, 80) + (one.length > 80 ? '…' : '');
    }
  }
  return '';
}

/** tool_result 的 content 可能是字符串，也可能是块数组。 */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' ? (b.text || `[${b.type}]`) : String(b))).join('\n');
  }
  return content == null ? '' : String(content);
}

/** 从在飞任务里挑出值得等的（subagent），忽略长驻服务。 */
export function agentTasks(tasks) {
  return Object.values(tasks || {}).filter((t) => WAITED_TASK_TYPES.has(t?.task_type || ''));
}

/**
 * 这一发是不是"一个 turn 都没跑"。四条同时成立才算，缺一不可 —— 判宽了会误伤
 * 正常短发次（比漏判更糟：正常收尾被当故障，白扔一次交接）。
 * 实测：正常发次 num_turns 3–139、费用 $0.7 起；86 个发次里只有 tiantan 那次命中。
 */
export function isEmptyResult(resultEv, meter) {
  return (Number(resultEv?.num_turns) || 0) === 0
    && !String(resultEv?.result ?? '').trim()
    && (Number(resultEv?.total_cost_usd) || 0) === 0
    && (meter?.calls ?? 0) === 0;
}

/**
 * 从 result 事件里取「人能看懂的错误正文」。
 *
 * CLI 报 API 错误的形态实测是：`result` 事件带 `is_error:true`、`terminal_reason:"api_error"`，
 * 错误全文在 `result` 字段里（例：`API Error: 503 分组 X 下模型 claude-fable-5-1 无可用渠道`），
 * 而 **stderr 是空的**。原先只读 stderr，导致停机原因只剩「连续 3 次进程异常」这种无信息量的话。
 *
 * @param {object} ev result 事件
 * @param {string} stderr 进程 stderr（兜底）
 * @returns {string} 错误正文，取不到则空串
 */
export function errorDetail(ev, stderr = '') {
  const body = String(ev?.result ?? '').trim();
  // 正常完成时 result 字段装的是执行者的成果文本，不能当错误报出去
  if (body && (ev?.is_error || ev?.terminal_reason === 'api_error')) return body.slice(-2000);
  const err = String(ev?.error ?? '').trim();
  if (err) return err.slice(-2000);
  return String(stderr || '').trim().slice(-2000);
}

/** 构造 `claude -p` 的参数。⚠ 提示词不作为参数传（见 BASE_FLAGS 注释）。 */
export function buildArgs({
  sessionId, resume = false, allowedTools = DEFAULT_TOOLS, extraDirs = [],
  model = '', maxTurns = 0, extraFlags = [], settingsFile = '',
} = {}) {
  const args = ['-p', ...BASE_FLAGS];
  args.push(resume ? '--resume' : '--session-id', sessionId);
  if (settingsFile) args.push('--settings', String(settingsFile));
  if (allowedTools) args.push('--allowedTools', allowedTools);
  for (const d of extraDirs) args.push('--add-dir', String(d));   // ⚠ --add-dir 是读写权限
  if (model) args.push('--model', model);
  if (maxTurns) args.push('--max-turns', String(maxTurns));
  args.push(...extraFlags);
  return args;
}

/** 当前该用哪档静默容忍度（秒）。over 仅供测试把档位调小。 */
export function silenceTolerance(state, over = {}) {
  const bash = over.bash ?? SILENCE_TOOL_BASH;
  const other = over.other ?? SILENCE_TOOL_OTHER;
  const idle = over.idle ?? SILENCE_IDLE;
  let tolerance = state.toolInFlight === 'bash' ? bash : state.toolInFlight ? other : idle;
  // 正在等后台 subagent：放到 Bash 档。agent 自己跑长 Bash 时可以几分钟不发进度，
  // 那不是挂死；整体上限由 taskWait 管
  if (state.taskWaitStarted != null && agentTasks(state.tasks).length) tolerance = Math.max(tolerance, bash);
  return tolerance;
}

/**
 * 看门狗的一次判定（纯函数）。对应原版 _watchdog 循环体，判定顺序完全一致。
 * @returns {{action:'continue'} | {action:'kill', reason?:string, hangDetail?:string,
 *           taskTimeout?:boolean, waited?:number, count?:number}}
 */
export function watchdogDecide(state, now, cfg) {
  const { wallTimeout = WALL_TIMEOUT, taskWait = TASK_WAIT, silence } = cfg;
  // 墙钟到点**无条件** terminate，不看工具是否在飞 —— 代价是会话留在脏状态，恢复即空返回
  if (now - state.started > wallTimeout) return { action: 'kill', reason: ExitReason.WALL_TIMEOUT };

  // 等 subagent 的上限**必须由看门狗执行**：读取循环只在有新事件时才跑，
  // 而 agent 卡死的表现正是没有新事件。到点 terminate 让读取循环解开。
  // 不设退出原因：主线已正常给过 result，这一发算正常完成
  const still = agentTasks(state.tasks);
  if (state.taskWaitStarted != null && still.length && now - state.taskWaitStarted > taskWait) {
    return { action: 'kill', taskTimeout: true, waited: now - state.taskWaitStarted, count: still.length };
  }

  const tolerance = silenceTolerance(state, silence);
  // 中断已送出、正在等它收尾：静默是预期的，硬 kill 会丢掉"我被打断了"的落盘记录。
  // ⚠ 但宽容期必须**有限**
  if (state.interruptSent) {
    const waited = now - (state.interruptAt || now);
    if (waited <= SETTLE_GRACE) return { action: 'continue' };
    return {
      action: 'kill', reason: ExitReason.INTERRUPTED_BY_HUMAN,
      hangDetail: `已送出中断但 ${waited.toFixed(0)}s 内未收到 result（宽容期 ${SETTLE_GRACE.toFixed(0)}s）`,
    };
  }

  const silent = now - state.lastEvent;
  if (silent > tolerance) {
    // 判据三样都记下：静默多久、哪一档、当时是否在生成 —— 上次误杀就因为日志只有三个字
    const who = state.toolInFlight ? `工具 ${state.toolInFlight} 在飞` : '无工具在飞';
    return {
      action: 'kill', reason: ExitReason.HANG_KILLED,
      hangDetail: `静默 ${silent.toFixed(0)}s 超过 ${tolerance.toFixed(0)}s（${who}，${state.sawDelta ? '流已断' : '本轮未见过流'}）`,
    };
  }
  return { action: 'continue' };
}

/**
 * 跟踪后台任务（原版 _track_tasks）。字段都在事件顶层。
 *   task_started：只认 is_backgrounded 为真 —— 前台工具调用也发它，算进来会让每一发都"有任务在飞"
 *   task_notification：终局（completed / stopped 都算不在飞）。**不是** task_completed
 *   background_tasks_changed：当前完整列表，权威
 */
export function trackTasks(event, state) {
  const sub = event?.subtype;
  const pick = (t) => ({ task_id: t.task_id, task_type: t.task_type || '', description: t.description || '' });
  if (sub === 'task_started') {
    if (event.is_backgrounded) state.tasks[event.task_id] = pick(event);
  } else if (sub === 'task_notification') {
    delete state.tasks[event.task_id];
  } else if (sub === 'background_tasks_changed') {
    state.tasks = {};
    for (const t of event.tasks || []) {
      if (t && typeof t === 'object') state.tasks[t.task_id] = pick(t);
    }
  }
}

/**
 * result 已到，还该不该继续读流等后台任务？返回 true 表示继续等（原版 _wait_tasks）。
 *
 * **每个事件后都要调**：任务收完就返回 false、正常收尾。只在 result 那一刻判一次的话，
 * 进入等待后任务全部完成也不会结束，300 秒后被判 hang_killed 走交接 —— qingming 那次
 * "连续 6 发被误判，白烧 $50+" 的回归（审计 G7）。
 * ⚠ 超时不在这里判（见 watchdogDecide）。
 */
export function waitTasks(state, taskWait, emit, now) {
  const waited = agentTasks(state.tasks);
  if (!waited.length || !taskWait) return false;
  if (state.taskWaitTimeout) return false;          // 看门狗已判超时，别再等
  if (state.taskWaitStarted == null) {
    state.taskWaitStarted = now;
    const names = waited.slice(0, 4).map((t) => t.description || t.task_id || '?').join('、');
    emit('tasks.waiting', { count: waited.length, names, limit: taskWait });
  }
  return true;
}

/**
 * 处理一条已解析的事件（stream_event 已在读取循环里处理掉）。对应原版 _handle_event。
 * 通过设置 state.killReason / state.costDetail 表达"该终止"，与原版一致。
 */
export function handleEvent(event, state, meter, cfg, emit = () => {}) {
  const etype = event?.type;

  if (etype === 'assistant') {
    const msg = event.message || {};
    const occupied = meter.observe(msg.usage || {}, msg.id, msg.model || '');
    emit('context', {
      occupied, peak: meter.peak, limit: cfg.contextLimit,
      cost_estimate: Math.round(meter.costEstimate * 1e4) / 1e4, calls: meter.calls,
    });
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    // 思考块与 tool_use 可以同轮出现，独立处理（放 else 里会丢掉带工具那轮的思考）
    for (const b of blocks) {
      if (b?.type === 'thinking') {
        const thought = b.thinking || b.text || '';
        if (String(thought).trim()) emit('thinking', { text: clip(thought) });
      }
    }
    const toolUses = blocks.filter((b) => b?.type === 'tool_use');
    if (toolUses.length) {
      const names = [...new Set(toolUses.map((b) => String(b.name || '').toLowerCase()))];
      state.toolInFlight = names.some((n) => n.includes('bash')) ? 'bash' : 'other';
      const calls = toolUses.map((b) => {
        const call = { id: b.id || '', name: String(b.name || ''), brief: toolBrief(b.input), detail: fmtToolInput(b.input) };
        state.toolNames[call.id] = call.name;
        return call;
      });
      emit('tool', { names: names.sort(), calls });
    } else {
      state.toolInFlight = null;
      const texts = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '');
      if (texts.length) {
        state.finalText = texts.join('\n');
        // 裁剪只作用于推给监控的副本；finalText 保持完整，监督者要靠它判断
        emit('text', { text: clip(state.finalText, 8000) });
      }
    }
    // 水位交接与费用刹车：都只在工具间隙动手，保证磁盘状态自洽
    if (occupied >= cfg.contextLimit && !state.toolInFlight) {
      state.killReason = ExitReason.BUDGET_KILLED;
    } else if (cfg.costCeiling && meter.costEstimate >= cfg.costCeiling && !state.toolInFlight) {
      state.costDetail = `估算已花 $${meter.costEstimate.toFixed(2)}（${meter.calls} 次调用）`
        + `超过刹车线 $${cfg.costCeiling.toFixed(2)}`;
      state.killReason = ExitReason.COST_KILLED;
    }
  } else if (etype === 'user') {
    state.toolInFlight = null;                       // tool_result 回来了
    for (const b of event.message?.content || []) {
      if (b?.type !== 'tool_result') continue;
      const tid = b.tool_use_id || '';
      emit('tool_result', {
        id: tid, name: state.toolNames[tid] || '', is_error: !!b.is_error, text: clip(resultText(b.content)),
      });
    }
  } else if (etype === 'system') {
    trackTasks(event, state);
  } else if (etype === 'result') {
    state.result = event;
    if (event.result) state.finalText = String(event.result);
  }
}

/**
 * 读取循环里的逐行摄入（纯函数，run() 与测试共用）。
 * 任何非空行都刷新活性计时器 —— 含 partial delta，这就是流级活性检测的全部。
 * @returns {object|null} 需要继续处理的事件；空行、非 JSON、stream_event 返回 null
 */
export function ingestLine(raw, state, now) {
  const line = String(raw ?? '').trim();
  if (!line) return null;
  state.lastEvent = now;
  let ev;
  try { ev = JSON.parse(line); } catch { return null; }
  if (ev?.type === 'stream_event') {
    // delta 只用于刷新活性，不落盘也不转发：一次长输出有成百上千个 delta
    if (LIVE_DELTAS.has(ev.event?.type)) state.sawDelta = true;
    return null;
  }
  return ev;
}

/**
 * 粗判是否停下来等人。仅作信号，最终由监督者判定。
 * 提问退出时 stop_reason 的确切取值未确认，用组合信号。
 */
export function looksLikeQuestion(result) {
  if (result.exitReason !== ExitReason.COMPLETED) return false;
  const tail = String(result.finalText || '').trimEnd().slice(-200);
  return tail.endsWith('?') || tail.endsWith('？')
    || ['请确认', '是否', '要我', '需要我', '请问', '怎么处理'].some((k) => tail.includes(k));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 启动并监管一次 claude -p 调用（原版 ClaudeRunner）。 */
export class LongRunRunner {
  /**
   * @param {object} o 参数与原版 ClaudeRunner.__init__ 一一对应（驼峰）：
   *   cwd env allowedTools model contextLimit handoffLimit costCeiling extraDirs
   *   wallTimeout maxTurns taskWait eventsDir extraFlags onStream checkInject
   *   测试钩子：claudeBin binPrefixArgs watchdogInterval silence
   */
  constructor(o = {}) {
    this.cwd = o.cwd;
    this.env = o.env || process.env;
    this.allowedTools = o.allowedTools ?? DEFAULT_TOOLS;
    this.model = o.model || '';
    this.contextLimit = o.contextLimit ?? 300000;      // 达此水位在工具间隙 kill
    this.handoffLimit = o.handoffLimit ?? 200000;      // 自然结束时若已过此水位，也走交接
    this.costCeiling = o.costCeiling ?? null;          // null = 不刹车；由 loop 按剩余预算算
    this.extraDirs = o.extraDirs || [];
    this.wallTimeout = o.wallTimeout ?? WALL_TIMEOUT;
    this.maxTurns = o.maxTurns || 0;
    this.taskWait = o.taskWait ?? TASK_WAIT;
    this.eventsDir = o.eventsDir || null;
    this.extraFlags = o.extraFlags || [];
    this.settingsFile = o.settingsFile || '';          // 执行者专用配置，经 --settings 传入
    this.onStream = o.onStream || null;
    this.checkInject = o.checkInject || null;
    this.claudeBin = o.claudeBin || 'claude';
    this.binPrefixArgs = o.binPrefixArgs || [];
    this.watchdogInterval = o.watchdogInterval ?? WATCHDOG_INTERVAL;
    this.silence = o.silence || undefined;
    /** 写进 stdin 的控制消息，供测试核对 */
    this.sentToStdin = [];
  }

  /** 流式观察者。异常必须吞掉 —— 监控挂了不该影响任务执行。 */
  _emit(kind, data = {}) {
    if (!this.onStream) return;
    try { this.onStream({ kind, ...data }); } catch { /* 忽略 */ }
  }

  /**
   * 先 SIGTERM 给落盘机会，等 10 秒，再 SIGKILL。对整个进程组下手：
   * 执行者起的 vite、subagent 的 Bash 都在组里，只杀 claude 会留下孤儿。
   */
  async _terminate(proc) {
    if (proc.exitCode !== null || proc.signalCode) return;
    killProcessGroup(proc, 'SIGTERM');
    for (let i = 0; i < 100 && proc.exitCode === null && !proc.signalCode; i++) await sleep(100);
    if (proc.exitCode === null && !proc.signalCode) killProcessGroup(proc, 'SIGKILL');
  }

  /**
   * 往 stdin 送 interrupt 控制请求。成功发出返回 true。
   * 只发请求不 kill —— 硬 kill 会丢掉 CLI 对"我被打断了"的落盘记录，
   * 而那条记录让注入后的续跑能接上。
   */
  _sendInterrupt(proc, state) {
    const stdin = proc.stdin;
    if (proc.exitCode !== null || proc.signalCode || !stdin || stdin.destroyed || !stdin.writable) return false;
    const req = JSON.stringify({
      type: 'control_request', request_id: `intr-${Math.floor(Date.now() / 1000)}`,
      request: { subtype: 'interrupt' },
    }) + '\n';
    try { stdin.write(req); } catch { return false; }
    this.sentToStdin.push(req);
    // ⚠ 刻意**不设** killReason：让它自己走完 control_response → result 的收尾
    state.interruptSent = true;
    state.interruptAt = Date.now() / 1000;
    return true;
  }

  /**
   * 有人要打断就在**工具间隙**发中断请求；立即模式不等间隙（死循环里永远等不到）。
   *
   * 修正原版一处缺陷：原版取件即删文件，工具在飞时只发 inject.waiting 后返回，
   * 下个事件再取件已是空的 —— 这次投件实际丢了。这里暂存到 state.injectPending，
   * 到下一个工具间隙照发。
   */
  _maybeInterrupt(proc, state) {
    if (!this.checkInject || state.injectText) return;
    let pending = state.injectPending;
    if (!pending) {
      try { pending = this.checkInject(); } catch { return; }   // 取件通道坏了不该影响任务
    }
    if (!pending) return;
    const [text, immediate] = pending;
    if (state.toolInFlight && !immediate) {
      if (!state.injectWaiting) {
        state.injectWaiting = true;
        this._emit('inject.waiting', { text: clip(text, 500) });
      }
      state.injectPending = pending;
      return;
    }
    state.injectPending = null;
    // 文本先存下来再发中断：进程可能下一瞬就退出，之后 state 里必须已经有它
    state.injectText = text;
    state.injectImmediate = !!immediate;
    if (this._sendInterrupt(proc, state)) {
      this._emit('inject.sent', { text: clip(text, 500), immediate: !!immediate });
    } else {
      // stdin 送不进去，退回硬 kill —— 注入内容仍在 state 里，上层照样能下一发送出去
      state.killReason = ExitReason.INTERRUPTED_BY_HUMAN;
      this._terminate(proc);
    }
  }

  /**
   * 跑一发。
   * @param {string} prompt    提示词原文（经 stdin 送，**不作为 -p 的参数**）
   * @param {string|null} sessionId  续会话时必填；新建时缺省生成 uuid
   * @param {boolean} resume
   */
  async run(prompt, sessionId = null, resume = false) {
    const sid = sessionId || randomUUID();
    const args = [...this.binPrefixArgs, ...buildArgs({
      sessionId: sid, resume, allowedTools: this.allowedTools, extraDirs: this.extraDirs,
      model: this.model, maxTurns: this.maxTurns, extraFlags: this.extraFlags, settingsFile: this.settingsFile,
    })];
    const now = () => Date.now() / 1000;

    // 原始 CLI 事件落盘（stream_event 除外）：事后取证全靠它，transcript 里没有编排层视角
    let eventsPath = null, eventsFd = null;
    if (this.eventsDir) {
      mkdirSync(this.eventsDir, { recursive: true });
      eventsPath = path.join(this.eventsDir, `${sid}-${Math.floor(now())}.jsonl`);
      eventsFd = openSync(eventsPath, 'w');
    }

    const meter = new ContextMeter();
    const started = now();
    const state = {
      started, lastEvent: started, toolInFlight: null, killReason: null,
      finalText: '', result: null, toolNames: {}, sawDelta: false,
      injectText: '', injectImmediate: false, injectWaiting: false, injectPending: null,
      interruptSent: false, interruptAt: 0,
      tasks: {}, taskWaitStarted: null, taskWaitTimeout: false,
      hangDetail: '', costDetail: '',
    };

    // detached = 独立进程组，连坐时整组杀（Windows 不支持负 pid，由 JobGuard 报不可用）
    const proc = spawn(this.claudeBin, args, {
      cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    // ⚠ stdin 管道已关时写入会异步抛 'error'，不接住会变成未捕获异常把整个 WebTmux 弄崩（审计 G10）
    proc.stdin.on('error', () => {});
    adoptProcessGroup(proc);
    this._proc = proc;

    let stderr = '';
    proc.stderr.on('data', (b) => { stderr = (stderr + b).slice(-20000); });

    // 送提示词。stdin 保持打开 —— 关掉就没法再送 control_request
    const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n';
    if (!proc.stdin.writable) {
      await this._terminate(proc);
      throw new Error('提示词送不进子进程 stdin: 管道不可写');
    }
    proc.stdin.write(payload);

    const emit = (k, d) => this._emit(k, d);
    const cfg = { contextLimit: this.contextLimit, costCeiling: this.costCeiling };

    await new Promise((resolve) => {
      let buf = '', stop = false;
      const finish = () => { if (!stop) { stop = true; } clearInterval(dog); resolve(); };
      const onLine = (raw) => {
        if (stop) return;
        const ev = ingestLine(raw, state, now());
        if (!ev) return;
        if (eventsFd != null) { try { writeSync(eventsFd, String(raw).trim() + '\n'); } catch { /* 落盘失败不影响任务 */ } }
        handleEvent(ev, state, meter, cfg, emit);
        this._maybeInterrupt(proc, state);
        if (state.killReason) { finish(); return; }
        // ⚠ 收到 result 必须主动收尾，中断与否都一样（流输入模式下 CLI 吐完 result 不退出）。
        // 例外：后台 subagent 还在飞时继续读流等它们（每个事件后都重判）
        if (state.result && !waitTasks(state, this.taskWait, emit, now())) finish();
      };
      proc.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while (!stop && (nl = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          onLine(l);
        }
      });
      proc.stdout.on('end', () => { if (buf) onLine(buf); finish(); });
      proc.on('error', (e) => { stderr += `\n${e.message}`; finish(); });

      const dog = setInterval(() => {
        if (proc.exitCode !== null || proc.signalCode) return;
        const d = watchdogDecide(state, now(), { wallTimeout: this.wallTimeout, taskWait: this.taskWait, silence: this.silence });
        if (d.action !== 'kill') return;
        if (d.taskTimeout) {
          state.taskWaitTimeout = true;
          emit('tasks.timeout', { count: d.count, waited: Math.round(d.waited * 10) / 10, limit: this.taskWait });
        } else {
          state.killReason = d.reason;
          if (d.hangDetail) state.hangDetail = d.hangDetail;
        }
        clearInterval(dog);
        this._terminate(proc);                       // 进程退出 → stdout end → 读取循环解开
      }, this.watchdogInterval * 1000);
    });

    // ── 收尾（原版 finally）──
    if (state.killReason) await this._terminate(proc);
    // stdin 必须显式关闭：不关则 CLI 一直等输入不退出。关掉后让它自己正常收尾 ——
    // 被信号杀掉的发次末尾几条 assistant 可能没落进 transcript（CLI 正常收尾才 flush），
    // 会影响下一发 --resume（审计 G9）
    try { proc.stdin.end(); } catch { /* 忽略 */ }
    for (let i = 0; i < 300 && proc.exitCode === null && !proc.signalCode; i++) await sleep(100);
    if (proc.exitCode === null && !proc.signalCode) killProcessGroup(proc, 'SIGKILL');
    if (eventsFd != null) { try { closeSync(eventsFd); } catch { /* 忽略 */ } }

    return this._assemble(sid, proc, state, meter, started, eventsPath, stderr);
  }

  /**
   * 面板「终止」：立刻整组杀掉当前执行者（原版靠终端 Ctrl+C + 进程连坐）。
   * 不走 SIGTERM 宽容：人已明确要停，run() 随进程退出自然返回，由 loop 判定为人工终止。
   */
  abort() {
    const proc = this._proc;
    if (!proc || proc.exitCode !== null || proc.signalCode) return;
    killProcessGroup(proc, SIGTERM);
    setTimeout(() => { if (proc.exitCode === null && !proc.signalCode) killProcessGroup(proc, SIGKILL); }, 3000).unref();
  }

  /** 组装结果（原版 _assemble），判定顺序逐条一致。 */
  _assemble(sid, proc, state, meter, started, eventsPath, stderr) {
    const ev = state.result;
    const usage = ev?.usage || {};
    let reason = state.killReason;

    // 人工打断优先于一切分类，**包括已设好的 killReason**：
    // ① CLI 收到 interrupt 后 result 是 error_during_execution + is_error（实测），不特判会归成 ERROR；
    // ② 中断收尾期间事件流会停，看门狗可能先设了 HANG_KILLED —— 人的明确动作不该被推测盖掉，
    //    否则注入内容连带丢掉（审计 G6）
    if (state.interruptSent) reason = ExitReason.INTERRUPTED_BY_HUMAN;

    if (reason == null) {
      if (ev) {
        if (ev.is_error) reason = ExitReason.ERROR;
        // 放在 terminal=="completed" 之前：这种空返回带的正是 completed + success
        else if (isEmptyResult(ev, meter)) reason = ExitReason.EMPTY_RESULT;
        // 以 terminal_reason 为主：stop_reason 实测有 end_turn / tool_use 两种正常取值
        else if (ev.terminal_reason === 'completed') reason = ExitReason.COMPLETED;
        else if (this.maxTurns && (Number(ev.num_turns) || 0) >= this.maxTurns) reason = ExitReason.MAX_TURNS;
        else reason = ExitReason.COMPLETED;
      } else {
        reason = ExitReason.ERROR;
      }
    }

    const out = {
      sessionId: ev?.session_id || sid,
      exitReason: reason,
      exitCode: proc.exitCode,
      contextPeak: meter.peak,
      totalTokens: ((Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0))
        || (meter.peak + meter.outputTotal),
      costUsd: Number(ev?.total_cost_usd) || 0,
      // 被 kill 的发次拿不到 result，costUsd 是 0 —— 那笔钱确实花了，靠这个记账
      costEstimate: Math.round(meter.costEstimate * 1e4) / 1e4,
      injectText: state.injectText || '',
      // 本发结束时仍在飞的后台任务。**后台任务活不过会话边界**：这份清单是
      // "能不能续这个会话"的判据（diablo 实测四个 local_agent 连坐全灭）
      pendingTasks: agentTasks(state.tasks),
      numTurns: Number(ev?.num_turns) || 0,
      stopReason: ev?.stop_reason ?? null,
      terminalReason: ev?.terminal_reason ?? null,
      permissionDenials: ev?.permission_denials || [],
      finalText: state.finalText,
      eventsPath,
      durationS: Date.now() / 1000 - started,
      // 判据跟着结果走，否则日志上只剩 hang_killed 三个字
      // ⚠ CLI 把 API 错误写进 **result 事件的 result 字段**，stderr 往往是空的
      //（Hitech 2026-09-18 实测：503「无可用渠道」重试 10 次全败，stderr 一个字都没有，
      //  于是 error 是空串 → 停机原因只剩「连续 3 次进程异常」，人无从判断该修什么）。
      //  所以优先取事件里的错误正文，stderr 只作补充。
      error: reason === ExitReason.ERROR ? (errorDetail(ev, stderr) || stderr.slice(-2000))
        : (reason === ExitReason.HANG_KILLED || reason === ExitReason.INTERRUPTED_BY_HUMAN) ? state.hangDetail
          : reason === ExitReason.COST_KILLED ? state.costDetail : '',
    };
    if (out.exitReason === ExitReason.COMPLETED && looksLikeQuestion(out)) out.exitReason = ExitReason.ASKED_HUMAN;
    // 自然结束但水位已过交接阈值。放在提问判定之后：执行者在等业务决策时要先拿到答案
    if (out.exitReason === ExitReason.COMPLETED && this.handoffLimit && out.contextPeak >= this.handoffLimit) {
      out.exitReason = ExitReason.COMPLETED_HIGH_CONTEXT;
    }
    return out;
  }
}
