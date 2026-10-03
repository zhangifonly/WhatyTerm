/**
 * 长程编排：Cursor CLI 执行者 —— 单次 `cursor-agent -p` 调用的生命周期管理。
 *
 * 起进程、看门狗、插话、收尾都在公共骨架 LongRunCliRunner 里；这里只有 Cursor 的参数与事件格式。
 *
 * 事件流（2026-10-03 用 cursor-agent 2026.10.01 实抓，`--output-format stream-json`）：
 *   system/init      {session_id, model, cwd}            —— 新对话的 id 只能从这里拿（也可先 create-chat）
 *   thinking/delta   模型在想                             —— 活性信号
 *   assistant        {message.content:[{type:'text'}]}    —— 一段文字（不带 usage）
 *   tool_call/started|completed  {call_id, tool_call:{shellToolCall|editToolCall|…:{args, result}}}
 *   result/success   {result, is_error, session_id, usage:{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}}
 *
 * 与 Claude 执行者的差别（都是 Cursor CLI 本身的限制，不是没做）：
 *   · 没有逐次调用的 usage，只有整发结束时的累计 → 拿不到运行中水位，不做水位交接；Cursor 自己管上下文
 *   · 没有 stdin 控制通道 → 人工插话只能在工具间隙结束进程，再 --resume 同一对话把话发进去（同样不丢上下文）
 *   · 按订阅计费，事件里没有费用 → 不按美元记账，预算刹车对它不生效
 *   · 权限：-p 模式下没有人能点确认，用 --force（与 Claude 执行者放行 Bash 同一档）；--trust 跳过目录信任框
 */

import { execFile } from 'child_process';
import { clip, toolBrief, fmtToolInput } from './LongRunRunner.js';
import { LongRunCliRunner } from './LongRunCliRunner.js';

export const CURSOR_BIN = 'cursor-agent';

/** `cursor-agent -p` 的参数。提示词作为最后一个参数传（-p 模式没有 stdin 输入通道） */
export function buildCursorArgs({ prompt, sessionId = '', resume = false, model = '', extraDirs = [] } = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--force', '--trust'];
  if (resume && sessionId) args.push('--resume', String(sessionId));
  if (model) args.push('--model', String(model));
  for (const d of extraDirs) args.push('--add-dir', String(d));
  args.push(String(prompt ?? ''));
  return args;
}

/** tool_call 里那一个 xxxToolCall 键 → {name, args, result} */
export function unwrapToolCall(tc) {
  const key = Object.keys(tc || {}).find((k) => /ToolCall$/.test(k));
  if (!key) return { name: 'tool', args: {}, result: undefined };
  const body = tc[key] || {};
  return { name: key.replace(/ToolCall$/, ''), args: body.args || {}, result: body.result };
}

/** 工具结果的正文：shell 取输出，其它取 message / 整个 JSON 摘一段 */
function toolResultText(result) {
  if (result == null) return '';
  // 实测：成功在 success 下，失败（命令退出码非 0 也算）在 failure 下；shell 的完整输出在 interleavedOutput
  const r = result.success ?? result.failure ?? result.error ?? result;
  if (typeof r === 'string') return r;
  return r.interleavedOutput ?? r.stdout ?? r.message ?? r.output ?? JSON.stringify(r);
}

/**
 * 处理一条已解析的 Cursor 事件（纯函数，测试与 run() 共用）。
 * state.inFlight：在飞工具 call_id → 'bash' | 'other'；toolInFlight 由它派生（看门狗按它选静默容忍度）
 */
export function handleCursorEvent(ev, state, emit = () => {}) {
  const t = ev?.type;
  if (t === 'system' && ev.subtype === 'init') {
    if (ev.session_id) state.sessionId = ev.session_id;
    if (ev.model) state.model = ev.model;
  } else if (t === 'thinking') {
    if (ev.subtype === 'delta') { state.sawDelta = true; state.thinking += ev.text || ''; }
    else if (ev.subtype === 'completed' && state.thinking.trim()) { emit('thinking', { text: clip(state.thinking) }); state.thinking = ''; }
  } else if (t === 'assistant') {
    const text = (ev.message?.content || []).filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
    if (text.trim()) { state.texts.push(text); state.finalText = text; emit('text', { text: clip(text, 8000) }); }
  } else if (t === 'tool_call') {
    const id = String(ev.call_id || '');
    const { name, args, result } = unwrapToolCall(ev.tool_call);
    if (ev.subtype === 'started') {
      state.toolCalls += 1;
      state.inFlight[id] = name === 'shell' ? 'bash' : 'other';
      state.toolNames[id] = name;
      emit('tool', { names: [name], calls: [{ id, name, brief: toolBrief(args), detail: fmtToolInput(args) }] });
    } else if (ev.subtype === 'completed') {
      delete state.inFlight[id];
      const isError = !!(result && (result.error || result.failure || result.rejected));
      emit('tool_result', { id, name: state.toolNames[id] || name, is_error: isError, text: clip(toolResultText(result)) });
    }
    const kinds = Object.values(state.inFlight);
    state.toolInFlight = kinds.includes('bash') ? 'bash' : kinds.length ? 'other' : null;
  } else if (t === 'result') {
    state.result = ev;
    if (ev.session_id) state.sessionId = ev.session_id;
    if (ev.result) state.finalText = String(ev.result);
  }
}

/** 一个 turn 都没跑：没有文字、没有工具、result 也是空的（与 Claude 执行者的 EMPTY_RESULT 同义） */
export function isCursorEmpty(state) {
  return !state.toolCalls && !state.texts.length && !String(state.result?.result ?? '').trim();
}

/** 列出本账号可用的模型（`cursor-agent --list-models`，每行「id - 名称」） */
export function listCursorModels() {
  return new Promise((resolve) => {
    execFile(CURSOR_BIN, ['--list-models'], { timeout: 30000, encoding: 'utf-8' }, (err, out) => {
      if (err) return resolve({ ok: false, models: [], error: /not logged in|login/i.test(String(out) + err.message) ? 'Cursor CLI 没登录（cursor-agent login）' : err.message });
      const models = String(out).split('\n').map((l) => l.match(/^(\S+) - /)?.[1]).filter(Boolean);
      resolve(models.length ? { ok: true, models, configured: '' } : { ok: false, models: [], error: '清单是空的' });
    });
  });
}

/** 一次 cursor-agent -p 调用 */
export class LongRunCursorRunner extends LongRunCliRunner {
  get bin() { return this.opts.cursorBin || CURSOR_BIN; }
  get executor() { return 'cursor'; }
  args({ prompt, sessionId, resume }) {
    return buildCursorArgs({ prompt, sessionId, resume, model: this.model, extraDirs: this.extraDirs });
  }
  handle(ev, state, emit) {
    handleCursorEvent(ev, state, emit);
    if (!state.result) return;
    state.done = true;
    const u = state.result.usage || {};
    state.usage = { input: Number(u.inputTokens) || 0, output: Number(u.outputTokens) || 0,
      cacheRead: Number(u.cacheReadTokens) || 0, cacheWrite: Number(u.cacheWriteTokens) || 0 };
  }
  outcome(state) {
    const ev = state.result;
    const error = ev && (ev.is_error || ev.subtype === 'error') ? String(ev.result || ev.error || '').trim() || 'Cursor 返回错误但没有正文' : '';
    return { error, empty: !!ev && isCursorEmpty(state), terminalReason: ev?.subtype || null };
  }
}
