/**
 * 经 codex exec 做一次纯文本 LLM 调用 —— Codex 版的 ClaudeCliText（接口相同：complete(system, user, {jsonSchema})）
 *
 * 用的是 CC Switch 写进 ~/.codex/config.toml 的当前配置（供应商、模型、密钥），与会话里的 codex 同一套。
 * 只当纯文本调用：不写会话文件、只读沙箱、关掉 shell/插件/多智能体/hooks 等工具能力、专用空目录、替换基础指令。
 *
 * 实测（codex-cli 0.154.0，2026-09-17）：
 *   · 一次 7–10 秒；输入约 1.1 万 tokens —— 替换基础指令后从 1.44 万降到 1.09 万，再关更多功能几乎不降，
 *     剩下的是中转站侧注入的指令，本地控制不了
 *   · --output-schema 走 OpenAI 严格模式：每层 object 必须 additionalProperties:false 且全部字段 required，
 *     否则 400 invalid_json_schema（见 toStrictSchema）
 *   · -C 的目录会被模型当成终端工作目录报上来，所以用固定目录，调用方据目录名剔除
 */

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { runCli, internalCliEnv } from './cliProcess.js';

export const CODEX_TEXT_TIMEOUT_MS = 180_000;
export const codexTextCwd = () => path.join(os.tmpdir(), 'webtmux-codex-text');

/** 关掉的能力：纯文本判断用不到，开着只会多塞工具定义、甚至真去执行命令 */
export const CODEX_DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'hooks',
  'browser_use', 'computer_use', 'image_generation', 'goals', 'view_image', 'tool_suggest', 'skill_search'];

/** OpenAI 严格模式的 schema：每层 object 关闭额外字段、全部字段必填 */
export function toStrictSchema(s) {
  if (!s || s.type !== 'object') return s;
  const props = Object.fromEntries(Object.entries(s.properties || {}).map(([k, v]) => [k, toStrictSchema(v)]));
  return { ...s, properties: props, required: Object.keys(props), additionalProperties: false };
}

export function buildCodexExecArgs({ cwd, instructionsFile, schemaFile = null, lastFile }) {
  return ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '--sandbox', 'read-only', '--color', 'never',
    '-C', cwd, ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    '-c', `model_instructions_file=${JSON.stringify(instructionsFile)}`, '-c', 'model_reasoning_effort="low"',
    ...(schemaFile ? ['--output-schema', schemaFile] : []), '-o', lastFile, '--json', '-'];
}

/** --json 事件流：取用量；error / turn.failed 转成异常信息 */
export function parseCodexEvents(stdout) {
  let usage = null, error = '', lastText = '';
  for (const line of String(stdout).split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'turn.completed') usage = e.usage || null;
    else if (e.type === 'turn.failed') error = e.error?.message || 'turn.failed';
    else if (e.type === 'error' && !error) error = e.message || 'error';
    else if (e.type === 'item.completed' && e.item?.type === 'agent_message') lastText = e.item.text || lastText;
  }
  return { usage, error, lastText };
}

export class CodexExecTextClient {
  constructor({ codexBin = 'codex', binPrefixArgs = [], timeoutMs = CODEX_TEXT_TIMEOUT_MS, env = process.env } = {}) {
    Object.assign(this, { codexBin, binPrefixArgs, timeoutMs, env });
  }

  /** 返回 {text, stopReason, inputTokens, outputTokens, costUsd}，与 ClaudeCliTextClient 同形 */
  async complete(system, user, { jsonSchema = null } = {}) {
    const cwd = codexTextCwd();
    mkdirSync(cwd, { recursive: true });
    const work = mkdtempSync(path.join(os.tmpdir(), 'webtmux-codex-call-'));   // 每次调用各自的指令/schema/输出文件，并发互不覆盖
    try {
      const instructionsFile = path.join(work, 'instructions.md');
      const lastFile = path.join(work, 'last.txt');
      writeFileSync(instructionsFile, system);
      const schemaFile = jsonSchema ? path.join(work, 'schema.json') : null;
      if (schemaFile) writeFileSync(schemaFile, JSON.stringify(toStrictSchema(jsonSchema)));
      // 提示词走标准输入（参数里的 "-"），终端全文不进命令行
      const { code, out, err } = await runCli({ label: 'codex exec', bin: this.codexBin, cwd, env: internalCliEnv(this.env), stdin: user,
        args: [...this.binPrefixArgs, ...buildCodexExecArgs({ cwd, instructionsFile, schemaFile, lastFile })], timeoutMs: this.timeoutMs });
      const ev = parseCodexEvents(out);
      const text = existsSync(lastFile) ? readFileSync(lastFile, 'utf8').trim() : ev.lastText;
      if (code || ev.error || !text) {
        throw new Error(`codex exec 调用失败${code ? `（退出码 ${code}）` : ''}: ${(ev.error || err || out).trim().slice(0, 300)}`);
      }
      const u = ev.usage || {};
      return { text, stopReason: null, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, costUsd: 0 };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
