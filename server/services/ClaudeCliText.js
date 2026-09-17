/**
 * 经 claude CLI（claude -p）做一次纯文本 LLM 调用 —— 长程监督者与 AI 监控共用
 *
 * 为什么不直接调 HTTP：CC Switch 当前的 Claude 配置多为官方 OAuth 登录，没有可直接调 Messages API 的密钥；
 * 借第三方供应商实测大多不可用（2026-09-17 连续 5 家 fetch failed —— 域名在本机 DNS 被污染，而 AIEngine 直连不走代理）。
 * claude -p 一直能用：它读的就是 CC Switch 写好的当前配置，并且遵守 HTTPS_PROXY。
 * 走同一个 CLI，就与会话里的 claude 永远同一套地址、登录与代理，CC Switch 切到哪它跟到哪。
 *
 * 只把 CLI 当作一次纯文本调用：替换系统提示词、不给工具、不加载 MCP、不写会话记录、不读任何 CLAUDE.md 与自动记忆。
 * 探针：一次约 3–7 秒、$0.02 左右（除系统提示词外只剩约 0.5k tokens 的系统上下文）。
 */

import { mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { runCli, internalCliEnv } from './cliProcess.js';

/** 缺省超时。监督者读完一整发的输出再判，一两分钟正常；卡死的 CLI 不能把调用方挂住 */
export const CLI_TEXT_TIMEOUT_MS = 300_000;

/** 专用空工作目录：CLI 会自动读取工作目录里的 CLAUDE.md，判案不该带着任何项目的规矩 */
export const cliTextCwd = () => path.join(os.tmpdir(), 'webtmux-claude-text');

export function buildCliTextArgs({ model, system, jsonSchema = null, effort = null }) {
  return ['-p', '--model', model, '--system-prompt', system, '--tools', '', '--strict-mcp-config',
    // 不指定就继承用户全局 effortLevel（常为 high）；读屏判状态用 low 实测快 2.5 秒、判定不变
    ...(effort ? ['--effort', effort] : []),
    '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json',
    // 结构化输出：CLI 按 schema 校验，结果另放 structured_output（与 HTTP 路径的 tool_use 强制 schema 等价）
    ...(jsonSchema ? ['--json-schema', JSON.stringify(jsonSchema)] : [])];
}

/** 解析 --output-format json 的结果；CLI 报错（is_error）要抛出，交给监督者按"调用失败"叫人 */
export function parseCliResult(stdout) {
  let d;
  try { d = JSON.parse(String(stdout).trim()); } catch { throw new Error(`claude CLI 输出不是 JSON: ${String(stdout).slice(0, 200)}`); }
  if (d.is_error || d.subtype !== 'success') throw new Error(`claude CLI 调用失败: ${String(d.result || d.subtype || '未知错误').slice(0, 300)}`);
  const u = d.usage || {};
  return {
    // 带 --json-schema 时以校验过的 structured_output 为准
    text: d.structured_output ? JSON.stringify(d.structured_output) : String(d.result ?? ''),
    stopReason: d.stop_reason ?? null,
    inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
    outputTokens: u.output_tokens || 0,
    costUsd: d.total_cost_usd || 0,
  };
}

export class ClaudeCliTextClient {
  /**
   * @param {object} o
   * @param {string} o.model
   * @param {string} [o.claudeBin]  测试钩子
   * @param {string[]} [o.binPrefixArgs]  测试钩子（node 假 CLI）
   * @param {string} [o.effort]  推理强度（low/medium/high）；不给就继承用户全局设置
   * @param {number} [o.timeoutMs]
   */
  constructor({ model, effort = null, claudeBin = 'claude', binPrefixArgs = [], timeoutMs = CLI_TEXT_TIMEOUT_MS, env = process.env } = {}) {
    Object.assign(this, { model, effort, claudeBin, binPrefixArgs, timeoutMs, env });
  }

  childEnv() {
    return internalCliEnv(this.env, {
      // 空目录挡不住用户级 ~/.claude/CLAUDE.md：实测监督者会拿"单次编辑不超过 100 行"之类的个人编码规矩去判案
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    });
  }

  /**
   * 与 AIEngine.callClaudeMessages 同形的返回：{text, stopReason, inputTokens, outputTokens, costUsd}
   * @param {object} [o.jsonSchema]  要求结构化输出时的 JSON Schema
   */
  async complete(system, user, { jsonSchema = null } = {}) {
    const cwd = cliTextCwd();
    mkdirSync(cwd, { recursive: true });
    // 用户消息走标准输入：执行者一整发的输出可能很长，不放进命令行参数
    const { code, out, err } = await runCli({ label: 'claude CLI', bin: this.claudeBin, cwd, env: this.childEnv(), stdin: user,
      args: [...this.binPrefixArgs, ...buildCliTextArgs({ model: this.model, system, jsonSchema, effort: this.effort })], timeoutMs: this.timeoutMs });
    try { return parseCliResult(out); } catch (e) {
      throw code ? new Error(`claude CLI 退出码 ${code}: ${(err || out).trim().slice(0, 300)}`) : e;
    }
  }
}
