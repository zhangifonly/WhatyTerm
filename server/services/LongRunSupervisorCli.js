/**
 * 长程编排：监督者经 claude CLI 调用（默认通道）
 *
 * 为什么不直接调 HTTP：CC Switch 当前的 Claude 配置多为官方 OAuth 登录，没有可直接调 Messages API 的密钥；
 * 借第三方供应商实测大多不可用（2026-09-17 连续 5 家 fetch failed —— 域名在本机 DNS 被污染，而 AIEngine 直连不走代理）。
 * 执行者 claude -p 一直能用：它读的就是 CC Switch 写好的当前配置，并且遵守 HTTPS_PROXY。
 * 监督者走同一个 CLI，就与执行者永远同一套地址、登录与代理，CC Switch 切到哪它跟到哪。
 *
 * 只把 CLI 当作一次纯文本调用：替换系统提示词、不给工具、不加载 MCP、不写会话记录、不读任何 CLAUDE.md 与自动记忆。
 * 探针：一次约 3–7 秒、$0.02 左右（除系统提示词外只剩约 0.5k tokens 的系统上下文）。
 */

import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

/** 一次判定的上限。Opus 读完一整发的输出再判，一两分钟正常；卡死的 CLI 不能把整个长程挂住 */
export const SUPERVISOR_CLI_TIMEOUT_MS = 300_000;

/** 与执行者隔开的空工作目录：CLI 会自动读取工作目录里的 CLAUDE.md，监督者不该带着任何项目的规矩判案 */
export const supervisorCwd = () => path.join(os.tmpdir(), 'webtmux-longrun-supervisor');

export function buildSupervisorArgs({ model, system }) {
  return ['-p', '--model', model, '--system-prompt', system, '--tools', '', '--strict-mcp-config',
    '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json'];
}

/** 解析 --output-format json 的结果；CLI 报错（is_error）要抛出，交给监督者按"调用失败"叫人 */
export function parseCliResult(stdout) {
  let d;
  try { d = JSON.parse(String(stdout).trim()); } catch { throw new Error(`claude CLI 输出不是 JSON: ${String(stdout).slice(0, 200)}`); }
  if (d.is_error || d.subtype !== 'success') throw new Error(`claude CLI 调用失败: ${String(d.result || d.subtype || '未知错误').slice(0, 300)}`);
  const u = d.usage || {};
  return {
    text: String(d.result ?? ''),
    stopReason: d.stop_reason ?? null,
    inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
    outputTokens: u.output_tokens || 0,
    costUsd: d.total_cost_usd || 0,
  };
}

export class CliSupervisorClient {
  /**
   * @param {object} o
   * @param {string} o.model
   * @param {string} [o.claudeBin]  测试钩子
   * @param {string[]} [o.binPrefixArgs]  测试钩子（node 假 CLI）
   * @param {number} [o.timeoutMs]
   */
  constructor({ model, claudeBin = 'claude', binPrefixArgs = [], timeoutMs = SUPERVISOR_CLI_TIMEOUT_MS, env = process.env } = {}) {
    Object.assign(this, { model, claudeBin, binPrefixArgs, timeoutMs, env });
  }

  childEnv() {
    const env = {
      ...this.env,
      WEBTMUX_LONGRUN: '1',                  // hook 带长程头，WebTmux 丢弃，不串到同目录会话上
      // 空目录挡不住用户级 ~/.claude/CLAUDE.md：实测监督者会拿"单次编辑不超过 100 行"之类的个人编码规矩去判执行者
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    };
    for (const k of ['CLAUDECODE', 'TMUX', 'TMUX_PANE']) delete env[k];
    return env;
  }

  /** 与 AIEngine.callClaudeMessages 同形的返回：{text, stopReason, inputTokens, outputTokens} */
  complete(system, user) {
    const cwd = supervisorCwd();
    mkdirSync(cwd, { recursive: true });
    return new Promise((resolve, reject) => {
      const proc = spawn(this.claudeBin, [...this.binPrefixArgs, ...buildSupervisorArgs({ model: this.model, system })],
        { cwd, env: this.childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '', done = false;
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
      const timer = setTimeout(() => { proc.kill('SIGKILL'); finish(reject, new Error(`claude CLI 超过 ${Math.round(this.timeoutMs / 1000)} 秒没有返回`)); }, this.timeoutMs);
      proc.stdout.on('data', (b) => { out += b; });
      proc.stderr.on('data', (b) => { err += b; });
      proc.on('error', (e) => finish(reject, new Error(`无法启动 claude CLI: ${e.message}`)));
      proc.on('close', (code) => {
        if (done) return;
        try { finish(resolve, parseCliResult(out)); } catch (e) {
          finish(reject, code ? new Error(`claude CLI 退出码 ${code}: ${(err || out).trim().slice(0, 300)}`) : e);
        }
      });
      // 用户消息走标准输入：执行者一整发的输出可能很长，不放进命令行参数
      proc.stdin.on('error', () => {});
      proc.stdin.end(user);
    });
  }
}
