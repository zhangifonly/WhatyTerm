/**
 * 长程编排：非 Claude 执行者（Cursor / Kiro / OpenCode）的公共骨架。
 *
 * 与 LongRunRunner（claude -p）同一套接口：run(prompt, sessionId, resume) → 同形状的结果；loop、监督者、看板都不用改。
 * 这几个 CLI 的共同点（都实测过）：一次调用 = 一个子进程，提示词放命令行参数，stdout 一行一个 JSON 事件，
 * 没有 Claude 那种 stdin 控制通道。所以起进程、看门狗、插话、结束收尾都一样，差别只在参数与事件格式 ——
 * 子类实现 args / handle / outcome 三个方法，其余全在这里。
 *
 * 子类在 handle() 里维护的 state 字段（骨架据此判定）：
 *   sessionId      对话 id（续接要用）            toolInFlight  null | 'bash' | 'other'（看门狗与插话时机）
 *   done           收到了本发的终局事件           finalText     最后的回复正文
 *   contextNow     当前上下文占用（token，拿不到就 0） costEstimate 本发估算花费（美元，订阅制就 0）
 *   credits        本发 credits（Kiro）           usage         {input, output, cacheRead, cacheWrite}
 *   toolCalls / texts  有没有真干活（判空返回）
 */

import { spawn } from 'child_process';
import { mkdirSync, openSync, writeSync, closeSync } from 'fs';
import path from 'path';
import { adoptProcessGroup, killProcessGroup } from './LongRunJobGuard.js';
import { ExitReason, watchdogDecide, clip, looksLikeQuestion, WALL_TIMEOUT, WATCHDOG_INTERVAL } from './LongRunRunner.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LongRunCliRunner {
  /** 构造参数与 LongRunRunner 相同；Claude 专有的（settingsFile、allowedTools…）忽略 */
  constructor(o = {}) {
    this.cwd = o.cwd;
    this.env = o.env || process.env;
    this.model = o.model || '';
    this.extraDirs = o.extraDirs || [];
    this.wallTimeout = o.wallTimeout ?? WALL_TIMEOUT;
    this.contextLimit = o.contextLimit ?? 0;          // 运行中水位到此在工具间隙结束本发（拿不到水位的 CLI 永远到不了）
    this.costCeiling = o.costCeiling ?? null;
    this.eventsDir = o.eventsDir || null;
    this.onStream = o.onStream || null;
    this.checkInject = o.checkInject || null;
    this.watchdogInterval = o.watchdogInterval ?? WATCHDOG_INTERVAL;
    this.silence = o.silence || undefined;
    this.opts = o;
  }

  // ── 子类实现 ──
  get bin() { throw new Error('子类必须给出 bin'); }
  /** @returns {string[]} 命令行参数 */
  args() { throw new Error('子类必须实现 args'); }
  /** 处理一条已解析的事件，更新 state */
  handle() { throw new Error('子类必须实现 handle'); }
  /** 收尾时的结论：{error: 错误正文（没有就空串）, empty: 一个 turn 都没跑, terminalReason} */
  outcome() { return { error: '', empty: false, terminalReason: null }; }
  /**
   * 子进程环境。⚠ PWD 必须改成项目目录：OpenCode 按 PWD 环境变量认工作目录，不看进程实际所在目录。
   * WebTmux 服务的 PWD 是它自己的仓库，不改的话执行者在 WebTmux 仓库里建记忆、写代码（2026-10-03 长程 E2E 实测）。
   * 子类在此基础上加自己的变量（OpenCode 的 OPENCODE_CONFIG）
   */
  childEnv() { return { ...this.env, PWD: this.cwd }; }
  /** stderr 里人能看懂的那一截（Kiro 的 stderr 混着大量 INFO 日志，子类可过滤） */
  stderrBrief(stderr) { return String(stderr || '').trim().slice(-2000); }

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
   * 人工插话：没有 stdin 控制通道，只能结束本发、下一发续同一对话把话发进去。
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

  /** 水位与费用刹车：都只在工具间隙动手（与 Claude 执行者同一规则） */
  _checkLimits(state) {
    if (state.toolInFlight || state.killReason) return;
    if (this.contextLimit && state.contextNow >= this.contextLimit) state.killReason = ExitReason.BUDGET_KILLED;
    else if (this.costCeiling && state.costEstimate >= this.costCeiling) {
      state.costDetail = `估算已花 $${state.costEstimate.toFixed(2)} 超过刹车线 $${this.costCeiling.toFixed(2)}`;
      state.killReason = ExitReason.COST_KILLED;
    }
  }

  async run(prompt, sessionId = null, resume = false) {
    const now = () => Date.now() / 1000;
    const started = now();
    const state = {
      started, lastEvent: started, toolInFlight: null, inFlight: {}, toolNames: {}, toolCalls: 0, texts: [], thinking: '',
      finalText: '', done: false, result: null,
      sessionId: resume ? sessionId : null, model: '', contextNow: 0, contextPeak: 0, costEstimate: 0, credits: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      killReason: null, hangDetail: '', costDetail: '', sawDelta: false,
      injectText: '', injectWaiting: false, injectPending: null, interruptSent: false, tasks: {}, taskWaitStarted: null,
    };
    // 提示词放在命令行参数里：以「-」开头（需求文档常以列表开头）会被 CLI 当成选项解析，前面垫一个换行
    const text = String(prompt ?? '');
    const args = this.args({ prompt: /^-/.test(text) ? `\n${text}` : text, sessionId, resume });
    let eventsPath = null, eventsFd = null;
    if (this.eventsDir) {
      mkdirSync(this.eventsDir, { recursive: true });
      eventsPath = path.join(this.eventsDir, `${path.basename(this.bin)}-${sessionId || 'new'}-${Math.floor(started)}.jsonl`);
      eventsFd = openSync(eventsPath, 'w');
    }
    // 子类把 promptViaStdin 设为 true 时提示词走标准输入（Codex：参数里放 "-"），长需求不受命令行长度限制
    const proc = spawn(this.bin, args, { cwd: this.cwd, env: this.childEnv(), stdio: [this.promptViaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    if (this.promptViaStdin) { proc.stdin.on('error', () => {}); proc.stdin.end(text); }
    adoptProcessGroup(proc);
    this._proc = proc;
    let stderr = '';
    proc.stderr.on('data', (b) => { stderr = (stderr + b).slice(-40000); });
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
        // ⚠ 必须兜住：这里跑在子进程 stdout 的回调里，抛出去就是未捕获异常，整个 WebTmux 跟着崩
        try { this.handle(ev, state, emit); } catch (e) { emit('parse_error', { error: e.message, line: clip(line, 300) }); }
        state.contextPeak = Math.max(state.contextPeak, state.contextNow || 0);
        this._checkLimits(state);
        if (state.killReason || this._maybeInject(state) || state.done) finish();
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

    // 正常收到终局事件后 CLI 会自己退出；被判 kill 的整组结束
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
    const oc = this.outcome(state);
    let reason = state.killReason;
    if (reason == null) {
      if (oc.error || !state.done) reason = ExitReason.ERROR;
      else if (oc.empty) reason = ExitReason.EMPTY_RESULT;
      else reason = ExitReason.COMPLETED;
    }
    const err = reason === ExitReason.ERROR
      ? (oc.error || this.stderrBrief(stderr) || `${this.bin} 退出码 ${proc.exitCode}，没有返回结果`).slice(-2000)
      : reason === ExitReason.HANG_KILLED ? state.hangDetail
        : reason === ExitReason.COST_KILLED ? state.costDetail : '';
    const u = state.usage;
    const out = {
      sessionId: state.sessionId || '',
      exitReason: reason,
      exitCode: proc.exitCode,
      contextPeak: Math.round(state.contextPeak),
      totalTokens: u.input + u.output + u.cacheRead,
      usage: { ...u },
      // 只有自己报了价的才算「已结算」；按单价估的走 costEstimate（loop 两者取其一记账）
      costUsd: 0,
      costEstimate: Math.round((state.costEstimate || 0) * 1e4) / 1e4,
      credits: Math.round((state.credits || 0) * 1e4) / 1e4,
      injectText: state.injectText || '',
      pendingTasks: [],
      numTurns: state.toolCalls,
      stopReason: null,
      terminalReason: oc.terminalReason ?? null,
      permissionDenials: [],
      finalText: state.finalText,
      eventsPath,
      durationS: Date.now() / 1000 - started,
      error: err,
      executor: this.executor,
      model: state.model,
    };
    if (out.exitReason === ExitReason.COMPLETED && looksLikeQuestion(out)) out.exitReason = ExitReason.ASKED_HUMAN;
    return out;
  }
}
