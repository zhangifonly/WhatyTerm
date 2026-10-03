/**
 * 长程编排：Cursor CLI 执行者 —— 单次 `cursor-agent -p` 调用的生命周期管理。
 *
 * 与 LongRunRunner（claude -p）同一套接口：run(prompt, sessionId, resume) → 同形状的结果；loop、监督者、看板都不用改。
 * 判定纯函数（watchdogDecide 等）直接复用；只有「起什么进程、怎么读事件」是 Cursor 自己的。
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

import { spawn, execFile } from 'child_process';
import { mkdirSync, openSync, writeSync, closeSync } from 'fs';
import path from 'path';
import { adoptProcessGroup, killProcessGroup } from './LongRunJobGuard.js';
import { ExitReason, watchdogDecide, clip, toolBrief, fmtToolInput, looksLikeQuestion, WALL_TIMEOUT, WATCHDOG_INTERVAL } from './LongRunRunner.js';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 启动并监管一次 cursor-agent -p 调用。构造参数与 LongRunRunner 相同，Claude 专有的（settingsFile、allowedTools…）忽略 */
export class LongRunCursorRunner {
  constructor(o = {}) {
    this.cwd = o.cwd;
    this.env = o.env || process.env;
    this.model = o.model || '';
    this.extraDirs = o.extraDirs || [];
    this.wallTimeout = o.wallTimeout ?? WALL_TIMEOUT;
    this.eventsDir = o.eventsDir || null;
    this.onStream = o.onStream || null;
    this.checkInject = o.checkInject || null;
    this.bin = o.cursorBin || CURSOR_BIN;
    this.watchdogInterval = o.watchdogInterval ?? WATCHDOG_INTERVAL;
    this.silence = o.silence || undefined;
  }

  _emit(kind, data = {}) {
    if (!this.onStream) return;
    try { this.onStream({ kind, ...data }); } catch { /* 监控挂了不影响任务 */ }
  }

  async _terminate(proc) {
    if (proc.exitCode !== null || proc.signalCode) return;
    killProcessGroup(proc, 'SIGTERM');
    for (let i = 0; i < 100 && proc.exitCode === null && !proc.signalCode; i++) await sleep(100);
    if (proc.exitCode === null && !proc.signalCode) killProcessGroup(proc, 'SIGKILL');
  }

  /**
   * 人工插话：没有 stdin 控制通道，只能结束本发、下一发 --resume 把话发进去。
   * 只在工具间隙动手（立即模式除外）：工具跑到一半被杀，磁盘状态可能半截
   */
  _maybeInject(state) {
    if (!this.checkInject || state.injectText) return false;
    let pending = state.injectPending;
    if (!pending) { try { pending = this.checkInject(); } catch { return false; } }
    if (!pending) return false;
    const [text, immediate] = pending;
    if (state.toolInFlight && !immediate) {
      if (!state.injectWaiting) { state.injectWaiting = true; this._emit('inject.waiting', { text: clip(text, 500) }); }
      state.injectPending = pending;
      return false;
    }
    state.injectPending = null;
    state.injectText = text;
    state.killReason = ExitReason.INTERRUPTED_BY_HUMAN;
    this._emit('inject.sent', { text: clip(text, 500), immediate: !!immediate });
    return true;
  }

  async run(prompt, sessionId = null, resume = false) {
    const now = () => Date.now() / 1000;
    const started = now();
    const state = {
      started, lastEvent: started, toolInFlight: null, inFlight: {}, toolNames: {}, toolCalls: 0,
      killReason: null, finalText: '', texts: [], thinking: '', result: null, sessionId: resume ? sessionId : null,
      model: '', sawDelta: false, injectText: '', injectWaiting: false, injectPending: null,
      interruptSent: false, tasks: {}, taskWaitStarted: null, hangDetail: '',
    };
    const args = buildCursorArgs({ prompt, sessionId, resume, model: this.model, extraDirs: this.extraDirs });
    let eventsPath = null, eventsFd = null;
    if (this.eventsDir) {
      mkdirSync(this.eventsDir, { recursive: true });
      eventsPath = path.join(this.eventsDir, `cursor-${sessionId || 'new'}-${Math.floor(started)}.jsonl`);
      eventsFd = openSync(eventsPath, 'w');
    }
    const proc = spawn(this.bin, args, { cwd: this.cwd, env: this.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    adoptProcessGroup(proc);
    this._proc = proc;
    let stderr = '';
    proc.stderr.on('data', (b) => { stderr = (stderr + b).slice(-20000); });
    const emit = (k, d) => this._emit(k, d);

    await new Promise((resolve) => {
      let buf = '', stop = false;
      const finish = () => { if (stop) return; stop = true; clearInterval(dog); resolve(); };
      const onLine = (raw) => {
        const line = String(raw).trim();
        if (stop || !line) return;
        state.lastEvent = now();
        let ev; try { ev = JSON.parse(line); } catch { return; }
        if (eventsFd != null) { try { writeSync(eventsFd, line + '\n'); } catch { /* 落盘失败不影响任务 */ } }
        handleCursorEvent(ev, state, emit);
        if (this._maybeInject(state) || state.result) finish();
      };
      proc.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while (!stop && (nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); onLine(l); }
      });
      proc.stdout.on('end', () => { if (buf) onLine(buf); finish(); });
      proc.on('error', (e) => { stderr += `\n${e.message}`; finish(); });
      const dog = setInterval(() => {
        if (proc.exitCode !== null || proc.signalCode) return;
        // 静默期间也要能插话（模型长时间思考时没有事件进来，onLine 不会跑）
        if (this._maybeInject(state)) { finish(); return; }
        const d = watchdogDecide(state, now(), { wallTimeout: this.wallTimeout, taskWait: 0, silence: this.silence });
        if (d.action !== 'kill') return;
        state.killReason = d.reason;
        if (d.hangDetail) state.hangDetail = d.hangDetail;
        finish();
      }, this.watchdogInterval * 1000);
    });

    // 收到 result 后 CLI 会自己退出；被判 kill 的整组结束
    if (state.killReason) await this._terminate(proc);
    for (let i = 0; i < 300 && proc.exitCode === null && !proc.signalCode; i++) await sleep(100);
    if (proc.exitCode === null && !proc.signalCode) killProcessGroup(proc, 'SIGKILL');
    if (eventsFd != null) { try { closeSync(eventsFd); } catch { /* 忽略 */ } }
    return this._assemble(proc, state, started, eventsPath, stderr);
  }

  /** 面板「终止」：立刻整组杀掉 */
  abort() {
    const proc = this._proc;
    if (!proc || proc.exitCode !== null || proc.signalCode) return;
    killProcessGroup(proc, 'SIGTERM');
    setTimeout(() => { if (proc.exitCode === null && !proc.signalCode) killProcessGroup(proc, 'SIGKILL'); }, 3000).unref();
  }

  /** 组装成与 LongRunRunner 同形状的结果 */
  _assemble(proc, state, started, eventsPath, stderr) {
    const ev = state.result;
    let reason = state.killReason;
    if (reason == null) {
      if (!ev) reason = ExitReason.ERROR;
      else if (ev.is_error || ev.subtype === 'error') reason = ExitReason.ERROR;
      else if (isCursorEmpty(state)) reason = ExitReason.EMPTY_RESULT;
      else reason = ExitReason.COMPLETED;
    }
    const u = ev?.usage || {};
    const errText = reason === ExitReason.ERROR
      ? (String(ev?.is_error ? ev.result || '' : '').trim() || stderr.trim() || `cursor-agent 退出码 ${proc.exitCode}，没有返回结果`).slice(-2000)
      : (reason === ExitReason.HANG_KILLED ? state.hangDetail : '');
    const out = {
      sessionId: state.sessionId || '',
      exitReason: reason,
      exitCode: proc.exitCode,
      // 拿不到逐次调用的水位（见文件头），记 0：loop 不会因水位交接
      contextPeak: 0,
      totalTokens: (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0) + (Number(u.cacheReadTokens) || 0),
      usage: { input: Number(u.inputTokens) || 0, output: Number(u.outputTokens) || 0, cacheRead: Number(u.cacheReadTokens) || 0, cacheWrite: Number(u.cacheWriteTokens) || 0 },
      // 订阅计费：不按美元记账
      costUsd: 0,
      costEstimate: 0,
      injectText: state.injectText || '',
      pendingTasks: [],
      numTurns: state.toolCalls,
      stopReason: null,
      terminalReason: ev?.subtype || null,
      permissionDenials: [],
      finalText: state.finalText,
      eventsPath,
      durationS: Date.now() / 1000 - started,
      error: errText,
      executor: 'cursor',
      model: state.model,
    };
    if (out.exitReason === ExitReason.COMPLETED && looksLikeQuestion(out)) out.exitReason = ExitReason.ASKED_HUMAN;
    return out;
  }
}
