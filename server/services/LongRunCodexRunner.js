/**
 * 长程编排：Codex 执行者 —— 单次 `codex exec --json` 调用。
 * 起进程、看门狗、插话、收尾都在公共骨架 LongRunCliRunner 里；这里只有 Codex 的参数与事件格式。
 * 用的是 Codex 自己的 config.toml（供应商、模型、登录），与终端里的 codex 同一套。
 *
 * 事件流（2026-10-03 用 codex-cli 0.160.0 实抓）：
 *   thread.started   {thread_id}                     续接用 `codex exec resume <thread_id>`
 *   item.started / item.completed  {item:{type, status, …}}
 *       agent_message {text}  ·  reasoning {text}  ·  command_execution {command, aggregated_output, exit_code}
 *       file_change {changes:[{path, kind}]}  ·  mcp_tool_call  ·  web_search
 *       error {message}  —— ⚠ 不是失败：config.toml 里有过时配置项时开头会有两条这样的警告
 *   turn.completed   {usage:{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}}  本轮累计
 *   turn.failed {error:{message}} / error {message}   真失败（供应商报错等）
 *
 * 水位：事件里只有本轮累计 token，不是当前占用。占用从 Codex 的 rollout 记录读
 *   （~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl 的 token_count：last_token_usage 与 model_context_window），
 *   每次工具收回时读一次。花费也从 rollout 的累计用量算（被中途结束的一发照样算得出），按价格表估美元。
 * 权限：workspace-write 沙箱（只能写项目目录，开网络）、approval_policy=never（没人能点确认，被拦的命令直接失败）。
 *   比 Claude 执行者「放行 Bash」更紧：写不到项目外。
 * 提示词走标准输入（参数里的 "-"），长需求不受命令行长度限制。
 */

import { readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import os from 'os';
import path from 'path';
import { clip, toolBrief, fmtToolInput } from './LongRunRunner.js';
import { LongRunCliRunner } from './LongRunCliRunner.js';
import { codexBillable, priceUsage } from './usage/costMath.js';
import pricingTable from './usage/PricingTable.js';

export const CODEX_BIN = 'codex';
// project_doc_fallback_filenames：没有 AGENTS.md 的项目读 CLAUDE.md —— Claude 开发过的项目换给 Codex 时规则不丢
// （只在这次调用里生效，不改用户的 config.toml）
const COMMON = ['--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"',
  '-c', 'sandbox_workspace_write.network_access=true', '-c', 'approval_policy="never"',
  '-c', 'project_doc_fallback_filenames=["CLAUDE.md"]'];

export function buildCodexArgs({ sessionId = '', resume = false, model = '', extraDirs = [] } = {}) {
  const m = model ? ['-m', model] : [];
  if (resume && sessionId) return ['exec', 'resume', ...COMMON, ...m, String(sessionId), '-'];
  return ['exec', ...COMMON, ...m, ...extraDirs.flatMap((d) => ['--add-dir', String(d)]), '-'];
}

const TOOL_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

/** 工具项的名字与入参（给看板显示） */
function toolOf(it) {
  if (it.type === 'command_execution') return { name: 'shell', input: { command: it.command } };
  if (it.type === 'file_change') return { name: 'edit', input: { path: (it.changes || []).map((c) => `${c.kind} ${c.path}`).join('\n') } };
  if (it.type === 'mcp_tool_call') return { name: `${it.server || 'mcp'}.${it.tool || ''}`, input: it.arguments || {} };
  return { name: it.type, input: { query: it.query || '' } };
}

/** 处理一条 Codex 事件（纯函数，测试与 run() 共用） */
export function handleCodexEvent(ev, state, emit = () => {}) {
  const it = ev?.item || {};
  if (ev?.type === 'thread.started') {
    if (ev.thread_id) state.sessionId = ev.thread_id;
  } else if (ev?.type === 'item.started' && TOOL_ITEMS.has(it.type)) {
    const { name, input } = toolOf(it);
    state.toolCalls += 1;
    state.inFlight[it.id] = it.type === 'command_execution' ? 'bash' : 'other';
    state.toolNames[it.id] = name;
    emit('tool', { names: [name], calls: [{ id: it.id, name, brief: toolBrief(input), detail: fmtToolInput(input) }] });
  } else if (ev?.type === 'item.completed') {
    if (TOOL_ITEMS.has(it.type)) {
      if (!state.inFlight[it.id]) { state.toolCalls += 1; state.toolNames[it.id] = toolOf(it).name; }   // 没发过 started 的工具
      delete state.inFlight[it.id];
      const failed = it.status === 'failed' || (typeof it.exit_code === 'number' && it.exit_code !== 0);
      emit('tool_result', { id: it.id, name: state.toolNames[it.id] || it.type, is_error: failed,
        text: clip(it.aggregated_output ?? (it.changes ? it.changes.map((c) => `${c.kind} ${c.path}`).join('\n') : JSON.stringify(it.result ?? it.error ?? ''))) });
      state.rolloutDue = true;
    } else if (it.type === 'agent_message' && String(it.text || '').trim()) {
      state.texts.push(it.text); state.finalText = it.text;
      emit('text', { text: clip(it.text, 8000) });
    } else if (it.type === 'reasoning' && String(it.text || '').trim()) {
      state.sawDelta = true;
      emit('thinking', { text: clip(it.text) });
    } else if (it.type === 'error') {
      state.warnings.push(String(it.message || ''));     // 配置警告之类，不算失败
    }
  } else if (ev?.type === 'turn.completed') {
    state.done = true;
    state.errorText = '';     // 中途的 error 事件可能只是重连（「Reconnecting… 1/5」），本轮正常结束就不算失败
    state.rolloutDue = true;
    const u = ev.usage || {};
    state.usage = { input: (u.input_tokens || 0) - (u.cached_input_tokens || 0), output: u.output_tokens || 0,
      cacheRead: u.cached_input_tokens || 0, cacheWrite: u.cache_write_input_tokens || 0 };
  } else if (ev?.type === 'turn.failed' || ev?.type === 'error') {
    state.errorText = String(ev.error?.message || ev.message || state.errorText || 'Codex 报错但没有正文');
    if (ev.type === 'turn.failed') state.done = true;
  }
  const kinds = Object.values(state.inFlight);
  state.toolInFlight = kinds.includes('bash') ? 'bash' : kinds.length ? 'other' : null;
}

// ── rollout 记录 ──────────────────────────────────────────
export const codexHome = (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), '.codex');

/** 按 thread_id 找 rollout 文件：sessions/YYYY/MM/DD/ 下，从最近的日期往前找（最多 31 天） */
export function findRollout(threadId, home = codexHome()) {
  if (!threadId || !/^[\w-]+$/.test(threadId)) return null;
  const root = path.join(home, 'sessions');
  const desc = (d) => { try { return readdirSync(d).filter((x) => /^\d+$/.test(x)).sort().reverse(); } catch { return []; } };
  let days = 0;
  for (const y of desc(root)) for (const m of desc(path.join(root, y))) for (const d of desc(path.join(root, y, m))) {
    if (++days > 31) return null;
    const dir = path.join(root, y, m, d);
    const f = (() => { try { return readdirSync(dir).find((x) => x.endsWith(`-${threadId}.jsonl`)); } catch { return null; } })();
    if (f) return path.join(dir, f);
  }
  return null;
}

/**
 * rollout 末尾的最新读数：{occupied, window, total, model}。只读文件尾部（长会话的 rollout 有几十 MB）。
 * occupied = 最近一次模型调用的输入（含缓存）+ 输出，与 Claude 执行者的水位同一口径
 */
export function readRolloutTail(file, bytes = 512 * 1024) {
  let text = '';
  let fd = null;
  try {
    const size = statSync(file).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, len, size - len);
    text = buf.toString('utf8');       // 头一行可能是半截，解析不了就跳过
  } catch { return null; } finally { if (fd != null) try { closeSync(fd); } catch { /* 忽略 */ } }
  const out = { occupied: 0, window: 0, total: null, model: '' };
  for (const line of text.split('\n')) {
    if (!/"type":"(?:turn_context|token_count)"/.test(line)) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    if (d.type === 'turn_context' && p.model) out.model = p.model;
    else if (p.type === 'token_count' && p.info) {
      const last = p.info.last_token_usage || {};
      out.occupied = (last.input_tokens || 0) + (last.output_tokens || 0);
      out.window = p.info.model_context_window || out.window;
      out.total = p.info.total_token_usage || out.total;
    }
  }
  return out;
}

const diffTotal = (a, b) => Object.fromEntries(Object.keys(a || {}).map((k) => [k, Math.max(0, (a[k] || 0) - ((b || {})[k] || 0))]));

/** 一次 codex exec 调用 */
export class LongRunCodexRunner extends LongRunCliRunner {
  get bin() { return this.opts.codexBin || CODEX_BIN; }
  get executor() { return 'codex'; }
  get promptViaStdin() { return true; }
  args({ sessionId, resume }) { return buildCodexArgs({ sessionId, resume, model: this.model, extraDirs: this.extraDirs }); }
  get pricing() { return this.opts.pricing || pricingTable; }

  async run(prompt, sessionId = null, resume = false) {
    // 续接时先记下这段对话已有的累计用量：本发的花费 = 结束时累计 − 开始时累计
    this._rollout = null;
    this._base = null;
    if (resume && sessionId) {
      this._rollout = findRollout(sessionId, codexHome(this.env));
      this._base = this._rollout ? readRolloutTail(this._rollout)?.total || null : null;
    }
    return super.run(prompt, sessionId, resume);
  }

  /** 从 rollout 刷新水位与花费（工具收回、本轮结束时） */
  _refresh(state) {
    state.rolloutDue = false;
    if (!this._rollout) this._rollout = findRollout(state.sessionId, codexHome(this.env));
    const r = this._rollout && readRolloutTail(this._rollout);
    if (!r) return;
    if (r.occupied) state.contextNow = r.occupied;
    if (r.model) state.model = r.model;
    state.contextWindow = r.window || state.contextWindow;
    if (r.total) {
      const spent = diffTotal(r.total, this._base);
      const { price } = this.pricing.get(state.model || this.model) || {};
      const usd = priceUsage(codexBillable(spent), price);
      state.costEstimate = usd ?? state.costEstimate;
      state.priceMissing = usd === null;
    }
  }

  handle(ev, state, emit) {
    if (!state.warnings) state.warnings = [];
    handleCodexEvent(ev, state, emit);
    if (state.rolloutDue) this._refresh(state);
  }

  outcome(state) {
    return { error: state.errorText || '', empty: !state.errorText && !state.toolCalls && !state.texts.length, terminalReason: null };
  }
}
