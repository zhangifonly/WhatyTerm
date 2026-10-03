/**
 * 长程编排：Kiro CLI 执行者 —— 单次 `kiro-cli chat --output-format stream-json` 调用。
 * 起进程、看门狗、插话、收尾都在公共骨架 LongRunCliRunner 里；这里只有 Kiro 的参数与事件格式。
 *
 * 事件流（2026-10-03 用 kiro-cli 2.26.0 实抓，ACP 协议 v1，V2 引擎）：
 *   runStarted     {engine}
 *   metadata       {sessionId, contextUsagePercentage, meteringUsage?:[{value, unit:'credit'}]}
 *                  —— 上下文占用是**百分比**，乘模型窗口（--list-models 的 context_window_tokens）得 token；
 *                     本发的 credits 在最后一条 metadata 里（每次模型调用一项）
 *   sessionUpdate  {update:{sessionUpdate: agent_message_chunk | tool_call | tool_call_update, …}}
 *                  tool_call 带 toolCallId、kind（edit / execute / read…）、rawInput、_meta.kiro.toolName；
 *                  tool_call_update 的 status 到 completed / failed 才算收回，rawOutput 是结果
 *   runFinished    {status:'success', stopReason, finalText}
 *
 * 实测的坑：
 *   · 新对话第一条 metadata 的占用是个启动前的估计值（4.48%），之后才是真实读数 —— 只影响峰值，比交接线低得多
 *   · --model 填了不存在的模型只在 stderr 打一行 warn，照常用默认模型跑 —— 模型要在开跑前对照清单校验（LongRunService）
 *   · --resume-id 给了不存在的 id 会悄悄开一个新对话 —— 这里只续 Kiro 自己报回来的 id
 *   · stderr 混着大量 [INFO] 日志，报错时只取 ERROR / WARN 行
 * 权限：-a（--trust-all-tools），与 Claude 执行者放行 Bash 同一档；按 credits 计费，不记美元。
 */

import { execFile } from 'child_process';
import { clip, toolBrief, fmtToolInput } from './LongRunRunner.js';
import { LongRunCliRunner } from './LongRunCliRunner.js';

export const KIRO_BIN = 'kiro-cli';

export function buildKiroArgs({ prompt, sessionId = '', resume = false, model = '' } = {}) {
  const args = ['chat', '--output-format', 'stream-json', '--trust-all-tools'];
  if (resume && sessionId) args.push('--resume-id', String(sessionId));
  if (model) args.push('--model', String(model));
  args.push(String(prompt ?? ''));
  return args;
}

/** 工具结果正文：rawOutput.items 里的 Text 或 Json（shell 是 {stdout, stderr, exit_status}），或 content 里的文字 */
function kiroToolText(u) {
  const items = u.rawOutput?.items || [];
  const parts = items.map((it) => {
    if (it?.Text != null) return String(it.Text);
    const j = it?.Json;
    if (j && typeof j === 'object') return [j.stdout, j.stderr].filter(Boolean).join('\n') || JSON.stringify(j);
    return '';
  }).filter(Boolean);
  if (parts.length) return parts.join('\n');
  return (u.content || []).map((c) => c?.content?.text || c?.text || '').filter(Boolean).join('\n');
}

const failedShell = (u) => (u.rawOutput?.items || []).some((it) => /exit status: (?!0\b)\d+/.test(String(it?.Json?.exit_status || '')));

/**
 * 处理一条 Kiro 事件（纯函数，测试与 run() 共用）。
 * @param {{contextWindow?: number}} cfg 当前模型的上下文窗口（token），用来把占用百分比换成 token
 */
export function handleKiroEvent(ev, state, emit = () => {}, cfg = {}) {
  const d = ev?.data || {};
  const flushText = () => {
    const text = state.msgBuf || '';
    state.msgBuf = '';
    if (text.trim()) { state.texts.push(text); state.finalText = text; emit('text', { text: clip(text, 8000) }); }
  };
  if (d.sessionId) state.sessionId = d.sessionId;
  if (ev?.type === 'metadata') {
    if (typeof d.contextUsagePercentage === 'number' && cfg.contextWindow) state.contextNow = d.contextUsagePercentage / 100 * cfg.contextWindow;
    if (Array.isArray(d.meteringUsage)) {
      // 每条 metadata 里的 meteringUsage 是本发到此为止的全部调用，取最后一次看到的，不累加
      state.credits = d.meteringUsage.filter((m) => m?.unit === 'credit').reduce((a, m) => a + (Number(m.value) || 0), 0);
    }
  } else if (ev?.type === 'sessionUpdate') {
    const u = d.update || {};
    const id = String(u.toolCallId || '');
    if (u.sessionUpdate === 'agent_message_chunk') {
      state.sawDelta = true;
      state.msgBuf = (state.msgBuf || '') + (u.content?.text || '');
    } else if (u.sessionUpdate === 'agent_thought_chunk') {
      state.sawDelta = true;
    } else if (u.sessionUpdate === 'tool_call') {
      flushText();
      const name = u._meta?.kiro?.toolName || u.kind || 'tool';
      state.toolCalls += 1;
      state.inFlight[id] = u.kind === 'execute' ? 'bash' : 'other';
      state.toolNames[id] = name;
      const input = { ...(u.rawInput || {}) };
      delete input.__tool_use_purpose;
      emit('tool', { names: [name], calls: [{ id, name, brief: toolBrief(input) || clip(u.title || '', 80), detail: fmtToolInput(input) }] });
    } else if (u.sessionUpdate === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed')) {
      delete state.inFlight[id];
      emit('tool_result', { id, name: state.toolNames[id] || '', is_error: u.status === 'failed' || failedShell(u), text: clip(kiroToolText(u)) });
    }
    const kinds = Object.values(state.inFlight);
    state.toolInFlight = kinds.includes('bash') ? 'bash' : kinds.length ? 'other' : null;
  } else if (ev?.type === 'runFinished') {
    flushText();
    state.done = true;
    state.result = d;
    if (d.finalText) state.finalText = String(d.finalText);
  }
}

/** 本账号可用的模型：[{id, contextWindow}]（`kiro-cli chat --list-models --format json`） */
export function listKiroModels() {
  return new Promise((resolve) => {
    execFile(KIRO_BIN, ['chat', '--list-models', '--format', 'json'], { timeout: 30000, encoding: 'utf-8' }, (err, out) => {
      try {
        const models = (JSON.parse(String(out)).models || []).map((m) => ({ id: m.model_id, contextWindow: Number(m.context_window_tokens) || 0 }));
        if (models.length) return resolve({ ok: true, models: models.map((m) => m.id), windows: Object.fromEntries(models.map((m) => [m.id, m.contextWindow])), configured: '' });
      } catch { /* 下面统一报错 */ }
      resolve({ ok: false, models: [], windows: {}, error: err ? err.message : '清单是空的（Kiro CLI 没登录？先 kiro-cli login）' });
    });
  });
}

/** 一次 kiro-cli chat 调用 */
export class LongRunKiroRunner extends LongRunCliRunner {
  get bin() { return this.opts.kiroBin || KIRO_BIN; }
  get executor() { return 'kiro'; }
  args({ prompt, sessionId, resume }) { return buildKiroArgs({ prompt, sessionId, resume, model: this.model }); }
  handle(ev, state, emit) { handleKiroEvent(ev, state, emit, { contextWindow: this.opts.contextWindow || 0 }); }
  outcome(state) {
    const r = state.result;
    const error = r && r.status !== 'success' ? `Kiro 本发结束状态 ${r.status}${r.stopReason ? `（${r.stopReason}）` : ''}` : '';
    return { error, empty: !!r && !state.toolCalls && !String(r.finalText || '').trim(), terminalReason: r?.stopReason || null };
  }
  /** 被中途结束的一发拿不到 credits：Kiro 只在一轮正常结束时才报，连它自己的会话记录里也没有这一轮（实测） */
  _assemble(proc, state, ...rest) {
    const out = super._assemble(proc, state, ...rest);
    if (state.killReason && !state.credits) out.creditsUnknown = true;
    return out;
  }
    stderrBrief(stderr) {
    const lines = String(stderr || '').split('\n').filter((l) => /^\[(ERROR|WARN)\]|error/i.test(l) && !/^\[INFO\]/.test(l));
    return (lines.length ? lines.slice(-8).join('\n') : String(stderr || '').trim().slice(-500)).slice(-2000);
  }
}
