/**
 * 长程编排：OpenCode 执行者 —— 单次 `opencode run --format json` 调用。
 * 起进程、看门狗、插话、收尾都在公共骨架 LongRunCliRunner 里；这里只有 OpenCode 的参数与事件格式。
 *
 * 供应商：与 OpenCode 终端会话一样用 CC Switch 里 claude 类的供应商，配置文件由 LongRunService 写好、
 * 经 OPENCODE_CONFIG 传进来（文件在 ~/.webtmux 下，不进项目目录：里面有密钥）。
 *
 * 事件流（2026-10-03 用 opencode 1.18.34 实抓）：
 *   step_start   一次模型调用开始
 *   text         {part.text}                                         一段回复
 *   tool_use     {part.tool, part.state:{status, input, output, metadata}}  **只在工具跑完后发一次**
 *   step_finish  {part.reason: tool-calls | stop, part.tokens:{input, output, reasoning, cache:{read, write}}, part.cost}
 *   error        {error:{name, data:{message}}}                       供应商报错（503 无可用渠道等）、模型不存在
 * 每个事件顶层都有 sessionID，续接用 `-s <sessionID>`。
 *
 * 由此而来的取舍：
 *   · 工具开跑时没有事件 → 不知道哪个工具在飞。一次模型调用（step）期间一律按「Bash 在飞」容忍静默，
 *     插话也只在两次调用之间（step_finish 那一刻）动手
 *   · 每次调用都报 token → 上下文水位与 Claude 执行者同一口径（input + cache），水位交接照常；
 *     自定义供应商的 cost 恒为 0，按价格表 × token 估算（ContextMeter，与 Claude 执行者同一套），预算刹车照常
 *   · 权限：--auto 放行所有没被显式拒绝的操作，与 Claude 执行者放行 Bash 同一档
 */

import { ContextMeter, clip, toolBrief, fmtToolInput } from './LongRunRunner.js';
import { LongRunCliRunner } from './LongRunCliRunner.js';
import { OC_PROVIDER_ID } from './opencodeCli.js';

export const OPENCODE_BIN = 'opencode';

export function buildOpencodeArgs({ prompt, sessionId = '', resume = false, model = '' } = {}) {
  const args = ['run', '--format', 'json', '--auto'];
  if (resume && sessionId) args.push('-s', String(sessionId));
  if (model) args.push('-m', model.includes('/') ? model : `${OC_PROVIDER_ID}/${model}`);
  args.push(String(prompt ?? ''));
  return args;
}

/**
 * 处理一条 OpenCode 事件（纯函数，测试与 run() 共用）。
 * @param {{meter: ContextMeter, model?: string}} cfg 水位与费用按每次调用的 token 记在 meter 上
 */
export function handleOpencodeEvent(ev, state, emit = () => {}, cfg = {}) {
  const p = ev?.part || {};
  if (ev?.sessionID) state.sessionId = ev.sessionID;
  if (ev?.type === 'step_start') {
    state.toolInFlight = 'bash';                       // 见文件头：调用期间工具不报开始，按最宽的一档容忍
  } else if (ev?.type === 'text') {
    const text = String(p.text || '');
    if (text.trim()) { state.texts.push(text); state.finalText = text; emit('text', { text: clip(text, 8000) }); }
  } else if (ev?.type === 'reasoning') {
    state.sawDelta = true;
  } else if (ev?.type === 'tool_use') {
    const st = p.state || {};
    const id = String(p.callID || p.id || '');
    const name = String(p.tool || 'tool');
    state.toolCalls += 1;
    emit('tool', { names: [name], calls: [{ id, name, brief: toolBrief(st.input) || clip(st.title || '', 80), detail: fmtToolInput(st.input) }] });
    const exit = st.metadata?.exit;
    emit('tool_result', { id, name, is_error: st.status === 'error' || (typeof exit === 'number' && exit !== 0),
      text: clip(typeof st.output === 'string' ? st.output : JSON.stringify(st.output ?? st.error ?? '')) });
  } else if (ev?.type === 'step_finish') {
    state.toolInFlight = null;
    const t = p.tokens || {};
    const meter = cfg.meter;
    if (meter) {
      meter.observe({ input_tokens: t.input, output_tokens: (t.output || 0) + (t.reasoning || 0),
        cache_read_input_tokens: t.cache?.read, cache_creation_input_tokens: t.cache?.write }, p.id || p.messageID, cfg.model || '');
      state.contextNow = meter.latest;
      state.reportedCost = (state.reportedCost || 0) + (Number(p.cost) || 0);
      // 内置供应商自己报了价就用它；自定义供应商 cost 恒为 0，用价格表估
      state.costEstimate = state.reportedCost || meter.costEstimate;
    }
    state.usage.input += t.input || 0;
    state.usage.output += (t.output || 0) + (t.reasoning || 0);
    state.usage.cacheRead += t.cache?.read || 0;
    state.usage.cacheWrite += t.cache?.write || 0;
    if (p.reason && p.reason !== 'tool-calls') { state.done = true; state.stopReason = p.reason; }
  } else if (ev?.type === 'error') {
    const e = ev.error || {};
    state.errorText = String(e.data?.message || e.message || e.name || 'OpenCode 报错但没有正文');
    state.done = true;
  }
}

/** 一次 opencode run 调用 */
export class LongRunOpencodeRunner extends LongRunCliRunner {
  get bin() { return this.opts.opencodeBin || OPENCODE_BIN; }
  get executor() { return 'opencode'; }
  args({ prompt, sessionId, resume }) { return buildOpencodeArgs({ prompt, sessionId, resume, model: this.model }); }
  childEnv() { const env = super.childEnv(); return this.opts.opencodeConfig ? { ...env, OPENCODE_CONFIG: this.opts.opencodeConfig } : env; }
  handle(ev, state, emit) {
    if (!this._meter) this._meter = new ContextMeter();
    handleOpencodeEvent(ev, state, emit, { meter: this._meter, model: this.model || this.opts.defaultModel || '' });
  }
  async run(...a) { this._meter = new ContextMeter(); return super.run(...a); }
  outcome(state) {
    return { error: state.errorText || '', empty: !state.errorText && !state.toolCalls && !state.texts.length, terminalReason: state.stopReason || null };
  }
}
