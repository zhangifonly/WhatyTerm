/**
 * 经 Cursor / Kiro / OpenCode 自己的 CLI 做一次纯文本 LLM 调用 —— 与 ClaudeCliText 接口相同：complete(system, user, {jsonSchema})。
 * 用途：长程监督者、终端会话的状态分析，都跟着「会话 / 执行者用的那个 CLI」走，用它自己的登录与配置。
 *
 * 2026-10-03 实测：
 *   cursor-agent -p --mode ask --output-format json   只读问答模式，约 10 秒；结果在 result
 *   kiro-cli chat --no-interactive --output-format stream-json   不给 --trust-all-tools 就不会动工具，约 5 秒；结果在 runFinished.finalText
 *   opencode run --format json --agent plan          只读的 plan 代理；结果是 text 事件
 * 三家都没有「替换系统提示词」的参数，系统提示词拼在用户消息前面。
 * ⚠ 它们都带读文件的工具：Cursor 实测会先去翻工作目录「核实」执行者的话，在空的临时目录里找不到文件就判「没做完」。
 *   所以开头明说「没有工作区、不要用工具」，加上之后直接按材料作答（同一段材料前后两次结论相反，就差这一句）。
 * 每次调用用独立临时目录（PWD 也指过去：OpenCode 按 PWD 认目录），调用完把各家记下的那段对话删掉，不留在历史项目里。
 */

import { mkdtempSync, rmSync, realpathSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { runCli, internalCliEnv } from './cliProcess.js';
import { chatsDirFor } from './cursorCli.js';
import { OC_PROVIDER_ID } from './opencodeCli.js';

export const OTHER_TEXT_TIMEOUT_MS = 180_000;
export const OTHER_CWD_PREFIX = 'webtmux-cli-text-';
/** 命令行参数有长度上限（macOS 约 1MB）：材料过长时截掉开头，保留最近的部分 */
const MAX_PROMPT_CHARS = 400_000;

export const NO_WORKSPACE = '（这是一次纯文本判断：你没有工作区，下面的材料就是全部输入。不要读文件、不要运行命令、不要调用任何工具，直接作答。）';

/** 拼成一段提示词：说明 + 系统提示词 + （要求的输出格式）+ 材料 */
export function composePrompt(system, user, jsonSchema = null) {
  const schema = jsonSchema ? `\n\n只输出一个符合下面 JSON Schema 的 JSON 对象，不要任何其他文字：\n${JSON.stringify(jsonSchema)}` : '';
  let body = String(user ?? '');
  const head = `${NO_WORKSPACE}\n\n${String(system ?? '')}${schema}\n\n---\n\n`;
  if (head.length + body.length > MAX_PROMPT_CHARS) body = `（前文过长已截去）\n${body.slice(-(MAX_PROMPT_CHARS - head.length - 20))}`;
  return head + body;
}

const lines = (out) => String(out || '').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
/** 输出里第一个对话 id（调用失败时也要拿到它去清理）。字段名各家不同 */
export const sessionIdOf = (out) => {
  for (const e of lines(out)) { const id = e.session_id || e.sessionID || e.data?.sessionId; if (id) return String(id); }
  return '';
};

/** 各家的参数、解析与清理（纯函数部分单测覆盖） */
export const CLI_TEXT = {
  cursor: {
    bin: 'cursor-agent', label: 'Cursor CLI',
    args: ({ prompt, model }) => ['-p', '--mode', 'ask', '--trust', '--output-format', 'json', ...(model ? ['--model', model] : []), prompt],
    parse(out) {
      let d;
      try { d = JSON.parse(String(out).trim()); } catch { throw new Error(`Cursor 输出不是 JSON: ${String(out).slice(0, 200)}`); }
      if (d.is_error || !String(d.result || '').trim()) throw new Error(`Cursor 调用失败: ${String(d.result || d.error || '没有输出').slice(0, 300)}`);
      const u = d.usage || {};
      return { text: String(d.result), sessionId: d.session_id || '', inputTokens: (u.inputTokens || 0) + (u.cacheReadTokens || 0), outputTokens: u.outputTokens || 0 };
    },
    cleanup({ cwd, home }) {
      rmSync(chatsDirFor(cwd, home), { recursive: true, force: true });
      rmSync(path.join(home, '.cursor', 'projects', cwd.replace(/^\//, '').replace(/[^A-Za-z0-9]/g, '-')), { recursive: true, force: true });
    },
  },
  kiro: {
    bin: 'kiro-cli', label: 'Kiro CLI',
    args: ({ prompt, model }) => ['chat', '--no-interactive', '--output-format', 'stream-json', ...(model ? ['--model', model] : []), prompt],
    parse(out) {
      const evs = lines(out);
      const fin = evs.find((e) => e.type === 'runFinished')?.data;
      const sessionId = evs.find((e) => e.data?.sessionId)?.data.sessionId || '';
      if (!fin || fin.status !== 'success' || !String(fin.finalText || '').trim()) throw new Error(`Kiro 调用失败: ${fin ? `状态 ${fin.status}` : '没有收到结束事件'}`);
      const meter = evs.filter((e) => e.type === 'metadata' && Array.isArray(e.data?.meteringUsage)).pop();
      const credits = (meter?.data.meteringUsage || []).reduce((a, m) => a + (Number(m.value) || 0), 0);
      return { text: String(fin.finalText), sessionId, inputTokens: 0, outputTokens: 0, credits };
    },
    cleanup({ home, sessionId }) {
      if (!sessionId || !/^[\w-]+$/.test(sessionId)) return;
      const dir = path.join(home, '.kiro', 'sessions', 'cli');
      for (const f of (() => { try { return readdirSync(dir); } catch { return []; } })()) if (f.startsWith(`${sessionId}.`)) rmSync(path.join(dir, f), { force: true });
    },
  },
  opencode: {
    bin: 'opencode', label: 'OpenCode',
    args: ({ prompt, model }) => ['run', '--format', 'json', '--agent', 'plan', ...(model ? ['-m', model.includes('/') ? model : `${OC_PROVIDER_ID}/${model}`] : []), prompt],
    parse(out) {
      const evs = lines(out);
      const err = evs.find((e) => e.type === 'error');
      if (err) throw new Error(`OpenCode 调用失败: ${String(err.error?.data?.message || err.error?.name || '').slice(0, 300)}`);
      const text = evs.filter((e) => e.type === 'text').map((e) => e.part?.text || '').join('');
      if (!text.trim()) throw new Error('OpenCode 没有输出');
      let input = 0, output = 0;
      for (const e of evs.filter((x) => x.type === 'step_finish')) { const t = e.part?.tokens || {}; input += (t.input || 0) + (t.cache?.read || 0); output += t.output || 0; }
      return { text, sessionId: evs.find((e) => e.sessionID)?.sessionID || '', inputTokens: input, outputTokens: output };
    },
    // OpenCode 的对话在它的 sqlite 库里，用它自己的命令删（不直接改它的库）
    cleanup({ sessionId, env }) {
      if (sessionId && /^ses_\w+$/.test(sessionId)) return runCli({ label: 'opencode', bin: 'opencode', args: ['session', 'delete', sessionId], cwd: os.tmpdir(), env, timeoutMs: 30000 }).catch(() => {});
      return null;
    },
  },
};

export class OtherCliTextClient {
  /**
   * @param {object} o
   * @param {'cursor'|'kiro'|'opencode'} o.cli
   * @param {string} [o.model]           不给就用 CLI 自己的默认模型
   * @param {string} [o.opencodeConfig]  OpenCode 的配置文件（会话 / 长程执行者专用的那份）；不给就用它自己的全局配置
   */
  constructor({ cli, model = '', opencodeConfig = '', bin = '', timeoutMs = OTHER_TEXT_TIMEOUT_MS, env = process.env, home = os.homedir() } = {}) {
    if (!CLI_TEXT[cli]) throw new Error(`不支持的 CLI：${cli}`);
    Object.assign(this, { cli, model, opencodeConfig, timeoutMs, env, home, spec: CLI_TEXT[cli] });
    this.bin = bin || this.spec.bin;
  }

  async complete(system, user, { jsonSchema = null } = {}) {
    const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), OTHER_CWD_PREFIX)));
    const env = internalCliEnv(this.env, { PWD: cwd, ...(this.cli === 'opencode' && this.opencodeConfig ? { OPENCODE_CONFIG: this.opencodeConfig } : {}) });
    let parsed = null, raw = '';
    try {
      const { code, out, err } = await runCli({ label: this.spec.label, bin: this.bin, cwd, env, timeoutMs: this.timeoutMs,
        args: this.spec.args({ prompt: composePrompt(system, user, jsonSchema), model: this.model }) });
      raw = out;
      try { parsed = this.spec.parse(out); } catch (e) {
        throw code ? new Error(`${this.spec.label} 退出码 ${code}: ${(err || out).trim().slice(-300)}`) : e;
      }
      return { text: parsed.text, stopReason: null, inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens, costUsd: 0, ...(parsed.credits ? { credits: parsed.credits } : {}) };
    } finally {
      try { await this.spec.cleanup({ cwd, home: this.home, sessionId: parsed?.sessionId || sessionIdOf(raw), env }); } catch { /* 清理失败不影响结果 */ }
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}
