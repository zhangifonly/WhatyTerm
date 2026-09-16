/**
 * 长程编排：单次 `claude -p` 调用的启动与监管
 *
 * 移植自长程编排器 orchestrator/runner.py（969 行）。**这是整套里最难的一块**：
 * 不只是解析 stream-json，还有双计时器 hang 检测、费用刹车、subagent 追踪与等待、
 * 工具间隙打断。每个常量都带实测案例，照抄数值同时必须照抄判据。
 */

import { spawn } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';

/**
 * `-p` + stream-json 的必需组合。缺 `--verbose` 会直接报错退出（实测）。
 */
export const BASE_FLAGS = [
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-prompts', 'none',   // 会触发提示的操作自动拒绝，不挂起
  // 流级活性信号。生成长输出期间 delta 持续到达，据此把"正在生成"与"真挂死"
  // 分开 —— 少了它，两者在事件流上完全一样（都是没有新的 assistant 事件）。
  '--include-partial-messages',
  // 人工打断的前提。协议：往 stdin 写
  //   {"type":"control_request","request_id":"r1","request":{"subtype":"interrupt"}}
  // CLI 回 control_response·success 后当前进程以 error_during_execution 退出，
  // 之后 --resume 同一 session id 可注入新指令。
  '--input-format', 'stream-json',
];

/** stream_event 里代表"模型还在吐字"的子类型。 */
// ⚠ 只认这些，不认 message_start 之类一次性事件 —— 那些即使卡死也可能已经到过。
const LIVE_DELTAS = new Set(['content_block_delta', 'message_delta']);

// ── 静默容忍：取决于当前有没有工具在飞 ─────────────────────────
/** Bash 在飞（测试/构建可能很久） */
export const SILENCE_TOOL_BASH = 900.0;
/** 其它工具在飞 */
export const SILENCE_TOOL_OTHER = 120.0;
/**
 * 无工具在飞。**这一档不等于"什么都不做"** —— 它同时覆盖"模型正在生成下一段
 * 输出"，而写一个上千行的文件本来就要几分钟，端点繁忙或并行跑时更久。
 * 实测误杀（qingming，2026-09-06）：写完 palette.js 后静默 92 秒被当时的 90s
 * 阈值杀掉，那 240 秒的算力钱花了却连 result 事件都没拿到（费用记成 $0.0000）。
 * 配合 --include-partial-messages 后，生成期间有 delta 持续刷新计时器，
 * 这个值只在**连流都停了**时才会真正走到，所以给得宽。
 */
export const SILENCE_IDLE = 300.0;
/**
 * 送出 interrupt 后等它收尾的宽容期。收尾只是把已生成的文本落盘 + 吐 result，
 * 实测几秒内完成，给 120s 是为了容忍它正好在写一个大文件。
 * **这个上限必须存在**：早先 watchdog 见 interrupt_sent 就无条件放行，与读取
 * 循环那个 `not interrupt_sent` 一起把逃生口全堵死，收尾卡住即永久挂死
 * （tafang 2026-09-08 实测卡了 10 分钟以上才被人发现）。
 */
export const SETTLE_GRACE = 120.0;
/**
 * 主线说完之后，最多再等多久让后台 subagent 收尾。
 * 给得宽是刻意的：并行开发正是要靠 subagent，而一个 agent 建模/跑构建十几分钟
 * 很正常。等待期间事件流一直有 task_progress 到达，watchdog 的静默检测不会误杀；
 * 兜底仍是 wall_timeout。设 0 关掉这个行为。
 */
export const TASK_WAIT = 1800.0;
/** 看门狗采样间隔。提成常量是为了让 hang 路径可以被快速测到。 */
export const WATCHDOG_INTERVAL = 5.0;

/**
 * 只等这类后台任务。实测 task_type 干净地分开了两件事：
 *   local_agent —— 并行开发的 subagent，会干完并交付，**必须等**；
 *   local_bash  —— 绝大多数是 dev server/静态服务器这类**长驻服务**，
 *                  永远不会"完成"，等它们等于每发白挂到上限。
 */
const WAITED_TASK_TYPE = 'local_agent';

// ── 运行中费用估算 ────────────────────────────────────────────
// result 里的 total_cost_usd 是网关算好的权威值，但它只在一发结束时才到。
// 一发能跑一两个小时，期间"已花多少"必须能估，否则预算只能在下一次派发前才拦。
//
// 单价由已结算的 18 个发次反推（2026-09-06，跨 6 个沙箱最小二乘）。
// **不抄公开价目表**：这是中转网关，计费口径未知，且实测它只上报 input_tokens
// —— output_tokens 与两个 cache 字段恒为 0，照价目表算会严重偏低。
// 两参数而非单一费率：实测误差有结构（调用少约 $8-9/Mtok、调用多约 $3.7-4.7），
// 单一费率最大偏差 66%，两参数后中位 8.8%。
export const COST_PER_CALL = 0.2351;
export const COST_PER_INPUT_TOKEN = 2.70e-6;

/** 单次调用的退出原因。 */
export const ExitReason = {
  COMPLETED: 'completed',                       // 正常结束，水位也不高
  /**
   * 自然结束但水位已过交接阈值。此时不该急着继续对话 —— 上下文已经很长，
   * 继续追问只会在质量衰减的窗口里干活。按交接处理，与被 kill 同路。
   */
  COMPLETED_HIGH_CONTEXT: 'completed_high_context',
  BUDGET_KILLED: 'budget_killed',               // 触及水位阈值被主动终止
  /**
   * 运行中估算花费触及刹车线被终止。与 BUDGET_KILLED 分开命名，因为处置不同：
   * 水位触顶要交接换窗口，钱花超了应当直接停机等人。
   */
  COST_KILLED: 'cost_killed',
  /**
   * 人主动打断。**必须与 ERROR 分开**：CLI 收到 interrupt 后 result 是
   * error_during_execution + is_error:true（实测），照原样归类会让每次人工打断
   * 都往"连续异常"计数器里加一，三次就误判成故障停机。
   */
  INTERRUPTED_BY_HUMAN: 'interrupted_by_human',
  HANG_KILLED: 'hang_killed',                   // 静默超时被终止
  WALL_TIMEOUT: 'wall_timeout',                 // 总时长超限被终止
  MAX_TURNS: 'max_turns',                       // 撞 --max-turns 上限
  /**
   * CLI 回了 success，但一个 turn 都没跑：num_turns=0 + 空 result + 零费用。
   * **必须与 COMPLETED 分开**：这一发发出去的提示词等于进了黑洞，而调用方会把它
   * 当成"做完了"继续往下走。实测只在续一个被 wall_timeout 杀掉的会话时出现。
   */
  EMPTY_RESULT: 'empty_result',
  ERROR: 'error',                               // 进程异常
};

/**
 * 上下文水位计，兼运行中费用估算。
 *
 * 实测：每个 assistant 事件的 message.usage 都带 input_tokens 与
 * cache_read_input_tokens，两者之和约等于当前上下文占用（cache_read 也占窗口）。
 * 因此运行中即可实时监控，无需等 result。
 */
export class ContextMeter {
  constructor() {
    this.peak = 0;
    this.latest = 0;
    this.outputTotal = 0;
    /**
     * message id → input_tokens。**必须按 id 去重**：同一条 assistant 消息会按
     * content block 多次上报同一个 usage（实测连续三条都是 75977），累加等于把
     * 一次 API 调用算成两三次，费用估算会成倍偏高。
     */
    this._calls = new Map();
  }

  observe(usage, messageId = null) {
    if (!usage) return this.latest;
    const inp = Number(usage.input_tokens) || 0;
    const occupied = inp
      + (Number(usage.cache_read_input_tokens) || 0)
      + (Number(usage.cache_creation_input_tokens) || 0);
    this.latest = occupied;
    this.peak = Math.max(this.peak, occupied);
    this.outputTotal += Number(usage.output_tokens) || 0;
    if (messageId && !this._calls.has(messageId)) this._calls.set(messageId, inp);
    return occupied;
  }

  get calls() { return this._calls.size; }

  /** 本发至今的估算花费（美元）。中位误差约 9%，仅供运行中参考。 */
  get costEstimate() {
    let sum = 0;
    for (const v of this._calls.values()) sum += v;
    return this._calls.size * COST_PER_CALL + sum * COST_PER_INPUT_TOKEN;
  }
}

/** 截断长文本，避免事件流里塞进整个文件内容。 */
const DETAIL_CHARS = 2000;
function clip(text, limit = DETAIL_CHARS) {
  const s = String(text ?? '');
  return s.length <= limit ? s : s.slice(0, limit) + `…（省略 ${s.length - limit} 字）`;
}

/** tool_result 的 content 可能是字符串，也可能是块数组。 */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (b && typeof b === 'object') return b.text || `[${b.type}]`;
      return String(b);
    }).join('\n');
  }
  return content == null ? '' : String(content);
}

/**
 * 从任务表里挑出**需要等**的后台任务。
 * 只等 local_agent —— local_bash 多是长驻服务，永远不会完成。
 */
export function agentTasks(tasks) {
  const out = [];
  for (const t of Object.values(tasks || {})) {
    if (t && t.task_type === WAITED_TASK_TYPE) out.push(t);
  }
  return out;
}

/** 是否"一个 turn 都没跑"的空 result（发出去的提示词进了黑洞）。 */
export function isEmptyResult(resultEv, meter) {
  if (!resultEv) return false;
  if (resultEv.is_error) return false;
  const turns = Number(resultEv.num_turns) || 0;
  const cost = Number(resultEv.total_cost_usd) || 0;
  const text = String(resultEv.result ?? '').trim();
  // 三个条件同时成立才算：没跑 turn、没花钱、没产出文本，且水位计没观察到任何调用
  return turns === 0 && cost === 0 && !text && (!meter || meter.calls === 0);
}

/**
 * 构造 `claude -p` 的参数数组。
 *
 * ⚠ **提示词不作为 `-p` 的参数**，而是开跑后经 stdin 送。
 *   实测：带 `--input-format stream-json` 时 `-p <文本>` 会被完全忽略，CLI 转而
 *   等 stdin 上的 user 消息 —— 照旧写法会静默挂到超时（301 秒零输出、水位 0、
 *   费用 0，看起来像挂死而非配置错）。
 */
export function buildArgs({
  sessionId, resume = false, allowedTools = '', extraDirs = [],
  model = '', maxTurns = 0, extraFlags = [],
} = {}) {
  const args = ['-p', ...BASE_FLAGS];
  if (resume) args.push('--resume', sessionId);
  else args.push('--session-id', sessionId);
  if (allowedTools) args.push('--allowedTools', allowedTools);
  for (const d of extraDirs) {
    // ⚠ --add-dir 是读写权限，不是只读
    args.push('--add-dir', String(d));
  }
  if (model) args.push('--model', model);
  if (maxTurns) args.push('--max-turns', String(maxTurns));
  args.push(...extraFlags);
  return args;
}

/**
 * 当前该用哪档静默容忍度（秒）。
 *
 * @param {object} state 运行态：{ toolInFlight, taskWaitStarted, tasks }
 */
export function silenceTolerance(state) {
  const inFlight = state.toolInFlight;
  let tolerance = inFlight === 'bash' ? SILENCE_TOOL_BASH
    : inFlight ? SILENCE_TOOL_OTHER
    : SILENCE_IDLE;
  // 正在等后台 subagent：容忍度放到 Bash 档。等待期间事件流通常是活的
  // （实测 task_progress 每个工具调用一条，间隔 5-30 秒），但 agent 自己在跑一个
  // 长 Bash（建模、构建）时可以几分钟不发进度，那不是挂死。
  // 整体上限由 taskWait 管，这里只是别让 idle 档误杀。
  if (state.taskWaitStarted != null && agentTasks(state.tasks).length > 0) {
    tolerance = Math.max(tolerance, SILENCE_TOOL_BASH);
  }
  return tolerance;
}

/**
 * 看门狗的一次判定（纯函数，便于离线测 26 条 hang 用例）。
 *
 * @returns {{action:'continue'|'kill', reason?:string, detail?:string, taskTimeout?:boolean}}
 */
export function watchdogDecide(state, now, cfg) {
  const { wallTimeout, taskWait } = cfg;

  if (now - state.started > wallTimeout) {
    // 墙钟到点是**无条件** terminate，不看工具是否在飞。代价是会话被留在工具
    // 执行中途的脏状态，恢复即空返回（EMPTY_RESULT 的唯一已知来源）。
    return { action: 'kill', reason: ExitReason.WALL_TIMEOUT,
      detail: `总时长超过 ${wallTimeout.toFixed(0)}s` };
  }

  // 等后台 subagent 的上限。**必须由看门狗执行**：读取循环只在有新事件时才跑，
  // 而 agent 卡死的表现就是没有新事件，那时它自己判不了超时。
  const still = agentTasks(state.tasks);
  if (taskWait && state.taskWaitStarted != null && still.length
      && now - state.taskWaitStarted > taskWait) {
    // 不设 kill_reason：主线已经正常给过 result，这一发该记成正常完成，
    // 只是有任务没收尾（靠 pendingTasks 带出去）。
    return { action: 'kill', taskTimeout: true, waited: now - state.taskWaitStarted,
      count: still.length };
  }

  // 中断已送出，正在等它收尾 —— 这段静默是预期的，不是挂死，此时硬 kill 会丢掉
  // CLI 落盘"我被打断了"的记录。⚠ 但宽容期必须**有限**（见 SETTLE_GRACE 注释）。
  if (state.interruptSent) {
    const waited = now - (state.interruptAt ?? now);
    if (waited <= SETTLE_GRACE) return { action: 'continue' };
    return {
      action: 'kill',
      // 归类成"被人打断"而非 HANG_KILLED：人确实按了打断，注入内容也已存进 state，
      // 上层照样能在下一发送出去。
      reason: ExitReason.INTERRUPTED_BY_HUMAN,
      detail: `已送出中断但 ${waited.toFixed(0)}s 内未收到 result（宽容期 ${SETTLE_GRACE.toFixed(0)}s）`,
    };
  }

  const tolerance = silenceTolerance(state);
  const silent = now - state.lastEvent;
  if (silent > tolerance) {
    // 把判据本身记下来。上一次误杀之所以要翻事件文件才查清，就是因为日志只说了
    // hang_killed，没说静默多久、哪一档、当时是不是在生成 —— 这三样才是全部依据。
    const who = state.toolInFlight ? `工具 ${state.toolInFlight} 在飞` : '无工具在飞';
    const flow = state.sawDelta ? '流已断' : '本轮未见过流';
    return {
      action: 'kill', reason: ExitReason.HANG_KILLED,
      detail: `静默 ${silent.toFixed(0)}s 超过 ${tolerance.toFixed(0)}s（${who}，${flow}）`,
    };
  }
  return { action: 'continue' };
}

/**
 * 追踪后台任务。
 *
 * ⚠ `background_tasks_changed` 直接给**当前完整列表**，是权威来源；
 *   而 task_started/task_progress 是增量。两者混用时以完整列表为准。
 *   那些没进 background_tasks_changed 的（is_backgrounded:false）是前台任务，
 *   不该计入"要等的后台任务"。
 */
export function trackTasks(event, state) {
  const sub = event?.subtype;
  if (sub === 'background_tasks_changed') {
    // 权威快照：整表替换
    const list = event.background_tasks || event.tasks || [];
    state.tasks = {};
    for (const t of list) {
      if (t && t.task_id) state.tasks[t.task_id] = t;
    }
    return;
  }
  const t = event?.task || event;
  const id = t?.task_id;
  if (!id) return;
  if (sub === 'task_started') {
    // 前台任务不计入：它们在本轮内就会结束，不需要跨会话等待
    if (t.is_backgrounded === false) return;
    state.tasks[id] = { ...t };
  } else if (sub === 'task_progress') {
    if (state.tasks[id]) Object.assign(state.tasks[id], t);
  } else if (sub === 'task_completed' || sub === 'task_stopped') {
    delete state.tasks[id];
  }
}

/**
 * 处理一条 stream-json 事件，更新运行态。
 *
 * @returns {{kill?:string, detail?:string}} 需要终止时返回原因
 */
export function handleEvent(event, state, meter, cfg, emit = () => {}) {
  const etype = event?.type;
  state.lastEvent = cfg.now();

  // ── 流级活性信号：把"正在生成"与"真挂死"分开 ──
  if (etype === 'stream_event') {
    const sub = event.event?.type;
    if (LIVE_DELTAS.has(sub)) state.sawDelta = true;
    // ⚠ delta 只用于刷新计时器，**不落盘**：一发能有几十万条，写进事件文件会
    //   让它涨到几百 MB，而回放时没人看逐字增量。
    return {};
  }

  if (etype === 'system') {
    if (event.subtype === 'init') {
      state.sessionId = event.session_id || state.sessionId;
      // memory_paths 可用于启动时校验记忆目录是否真指向沙箱（隔离层的运行期复核点）
      if (event.memory_paths) state.memoryPaths = event.memory_paths;
      emit('init', { sessionId: state.sessionId, model: event.model, cwd: event.cwd });
    } else {
      trackTasks(event, state);
    }
    return {};
  }

  if (etype === 'assistant') {
    const msg = event.message || {};
    const occupied = meter.observe(msg.usage || {}, msg.id);
    emit('context', {
      occupied, peak: meter.peak,
      costEstimate: Math.round(meter.costEstimate * 1e4) / 1e4,
      calls: meter.calls,
    });

    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const b of blocks) {
      if (b?.type === 'thinking' && String(b.thinking || '').trim()) {
        emit('thinking', { text: clip(b.thinking) });
      }
    }
    const toolUses = blocks.filter((b) => b?.type === 'tool_use');
    if (toolUses.length) {
      const names = toolUses.map((b) => String(b.name || '').toLowerCase());
      // Bash 在飞时容忍度放到 900s —— 测试/构建可能很久
      state.toolInFlight = names.some((n) => n.includes('bash')) ? 'bash' : 'other';
      for (const b of toolUses) {
        if (b.id) state.toolNames[b.id] = b.name;
      }
      emit('tool', { names: [...new Set(names)].sort() });
    } else {
      state.toolInFlight = null;
      const texts = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '');
      if (texts.length) {
        state.finalText = texts.join('\n');
        emit('text', { text: clip(state.finalText, 8000) });
      }
    }

    // ── 水位与费用刹车：都**只在工具间隙**动手 ──
    // 工具在飞时 kill 会把会话留在脏状态，恢复即空返回（EMPTY_RESULT）。
    if (!state.toolInFlight) {
      if (cfg.contextLimit && occupied >= cfg.contextLimit) {
        return { kill: ExitReason.BUDGET_KILLED,
          detail: `水位 ${occupied.toLocaleString()} 触及上限 ${cfg.contextLimit.toLocaleString()}` };
      }
      if (cfg.costCeiling && meter.costEstimate >= cfg.costCeiling) {
        return { kill: ExitReason.COST_KILLED,
          detail: `估算已花 $${meter.costEstimate.toFixed(2)}（${meter.calls} 次调用）`
            + `超过刹车线 $${cfg.costCeiling.toFixed(2)}` };
      }
    }
    return {};
  }

  if (etype === 'user') {
    // 工具返回：工具不再在飞
    state.toolInFlight = null;
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const b of blocks) {
      if (b?.type !== 'tool_result') continue;
      emit('tool_result', {
        name: state.toolNames[b.tool_use_id] || '',
        text: clip(resultText(b.content)),
      });
    }
    return {};
  }

  if (etype === 'result') {
    state.resultEvent = event;
    return {};
  }

  return {};
}
