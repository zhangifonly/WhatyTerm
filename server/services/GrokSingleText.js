/**
 * 经 grok -p（--prompt-file）做一次纯文本 LLM 调用 —— Grok 版的 ClaudeCliText（接口相同：complete(system, user, {jsonSchema})）
 *
 * 用的是 grok 自己的当前登录与配置（~/.grok），与会话里的 grok 同一套。
 * 只当纯文本调用：替换系统提示词、不给工具、不开子智能体与计划模式、关网页搜索、单轮、低推理强度。
 *
 * 实测（grok 1.0.30 / grok-4.6-build，2026-09-17）：
 *   · 默认推理强度 28 秒，--reasoning-effort low 降到 12 秒；约 $0.015；输入约 2 万 tokens，关工具压不下去
 *   · --json-schema 可用（非严格模式），结果在 structuredOutput
 *   · 没有"不保存会话"的参数：会话写到 ~/.grok/sessions/<URL 编码的工作目录>/<id>。
 *     所以每次调用用独立临时工作目录，调用完连同它的会话目录一起删
 *   · 工作目录会被模型当成终端工作目录报上来，调用方据目录名前缀剔除
 */

import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'fs';
import os from 'os';
import path from 'path';
import { runCli, internalCliEnv } from './cliProcess.js';

export const GROK_TEXT_TIMEOUT_MS = 180_000;
export const GROK_CWD_PREFIX = 'webtmux-grok-text-';

export function buildGrokArgs({ cwd, promptFile, system, jsonSchema = null }) {
  return ['--prompt-file', promptFile, '--system-prompt-override', system, '--tools', '', '--no-subagents', '--no-plan',
    '--disable-web-search', '--max-turns', '1', '--reasoning-effort', 'low', '--cwd', cwd, '--output-format', 'json',
    ...(jsonSchema ? ['--json-schema', JSON.stringify(jsonSchema)] : [])];
}

/** --output-format json 的结果；带 schema 时以 structuredOutput 为准 */
export function parseGrokResult(stdout) {
  let d;
  try { d = JSON.parse(String(stdout).trim()); } catch { throw new Error(`grok 输出不是 JSON: ${String(stdout).slice(0, 200)}`); }
  const text = d.structuredOutput ? JSON.stringify(d.structuredOutput) : String(d.text ?? '');
  if (d.is_error || d.error || !text) throw new Error(`grok 调用失败: ${String(d.error?.message || d.error || d.text || '没有输出').slice(0, 300)}`);
  const u = d.usage || {};
  return { text, stopReason: d.stopReason ?? null, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0,
    costUsd: d.total_cost_usd || 0, sessionId: d.sessionId || null };
}

export class GrokSingleTextClient {
  constructor({ grokBin = 'grok', binPrefixArgs = [], timeoutMs = GROK_TEXT_TIMEOUT_MS, env = process.env,
    grokHome = path.join(os.homedir(), '.grok') } = {}) {
    Object.assign(this, { grokBin, binPrefixArgs, timeoutMs, env, grokHome });
  }

  async complete(system, user, { jsonSchema = null } = {}) {
    const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), GROK_CWD_PREFIX)));
    try {
      const promptFile = path.join(cwd, 'prompt.txt');   // 终端全文不进命令行参数
      writeFileSync(promptFile, user);
      const { code, out, err } = await runCli({ label: 'grok', bin: this.grokBin, cwd, env: internalCliEnv(this.env),
        args: [...this.binPrefixArgs, ...buildGrokArgs({ cwd, promptFile, system, jsonSchema })], timeoutMs: this.timeoutMs });
      try { return parseGrokResult(out); } catch (e) {
        throw code ? new Error(`grok 退出码 ${code}: ${(err || out).trim().slice(0, 300)}`) : e;
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      // grok 按工作目录建会话目录（URL 编码的绝对路径），每次调用独立目录，整个删掉不影响别的会话
      rmSync(path.join(this.grokHome, 'sessions', encodeURIComponent(cwd)), { recursive: true, force: true });
    }
  }
}
