/**
 * 会话级 Codex 供应商：写进会话专属 CODEX_HOME 的 config.toml，以及启动 / 续接 codex 的命令（纯函数）。
 *
 * 由来（2026-09-26）：给会话切 Codex 供应商后请求一律 401，两个问题叠加：
 * ① 密钥写错地方：CC Switch 把第三方供应商的密钥放在 auth.json 的 OPENAI_API_KEY，但 `requires_openai_auth = false`
 *    的自定义供应商**不读 auth.json**，请求不带密钥 → `401 API_KEY_REQUIRED`（用会话自己的配置实测）。
 *    全局 ~/.codex/config.toml 能用，是因为那边手写了 `experimental_bearer_token`。
 * ② Codex 0.157 起所有 TUI 默认连一个共享的后台服务（app-server daemon），它按**自己启动时**的配置发请求；
 *    接回旧对话时还沿用对话记录里的供应商（iSpring 那段记的是 openai）→ 请求发到 api.openai.com。
 *
 * 做法：密钥写成当前供应商表里的 `experimental_bearer_token`；启动带 `--no-daemon`（各会话用自己的进程和
 * CODEX_HOME）；续接带 `-c model_provider=<当前供应商>`，按现在选的供应商接回。
 */

import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

/** TOML 基本字符串：只需转义反斜杠、双引号与控制字符 */
export const tomlString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;

/** 顶层 model_provider 的值（没写就是 Codex 默认的 openai） */
export function topProvider(toml) {
  const top = String(toml || '').split(/^\s*\[/m)[0];
  return (top.match(/^\s*model_provider\s*=\s*"([^"]+)"/m) || [])[1] || 'openai';
}

/**
 * 把密钥写进 `[model_providers.<当前供应商>]` 表的 experimental_bearer_token。
 * 表里已有密钥（手工配好的）不动；供应商是官方 openai 或要求 OpenAI 登录的，也不动（它们本来就读 auth.json）。
 * @returns {{toml: string, injected: boolean, reason: string}}
 */
export function withBearerToken(toml, apiKey) {
  const src = String(toml || '');
  const name = topProvider(src);
  if (!apiKey) return { toml: src, injected: false, reason: 'CC Switch 里这个供应商没有密钥' };
  if (name === 'openai') return { toml: src, injected: false, reason: '官方 openai 供应商读 auth.json' };
  const lines = src.split('\n');
  const header = lines.findIndex((l) => l.trim() === `[model_providers.${name}]` || l.trim() === `[model_providers."${name}"]`);
  if (header < 0) return { toml: src, injected: false, reason: `配置里没有 [model_providers.${name}] 表` };
  let end = lines.findIndex((l, i) => i > header && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(header + 1, end);
  if (body.some((l) => /^\s*requires_openai_auth\s*=\s*true\b/.test(l))) return { toml: src, injected: false, reason: '该供应商要求 OpenAI 登录，读 auth.json' };
  if (body.some((l) => /^\s*(experimental_bearer_token|env_key)\s*=/.test(l))) return { toml: src, injected: false, reason: '已有密钥配置' };
  // 插在表内最后一个非空行之后，不跑到下一张表里
  let at = end;
  while (at > header + 1 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, `experimental_bearer_token = ${tomlString(apiKey)}`);
  return { toml: lines.join('\n'), injected: true, reason: '' };
}

/** 会话专属 CODEX_HOME（与 index.js applySessionProviderInfo 写入的位置一致） */
export const sessionCodexHome = (sessionId, home = os.homedir()) => path.join(home, '.webtmux', 'sessions', String(sessionId), 'codex');

/**
 * 启动 / 续接 codex 的命令。
 *
 * ⚠ CODEX_HOME 必须写在命令里：tmux set-environment 只对**之后新建的窗格**生效，
 * 窗格里早已在跑的 shell 看不到 —— 实测 3 个会话都设了 tmux 环境，从 shell 起的 codex 进程里一个都没有 CODEX_HOME，
 * 全走全局配置（2026-09-26）。所以会话级供应商以前从 shell 里起 codex 时根本不生效。
 *
 * @param {{id?: string, codexProvider?: {providerKey?: string}}} session
 * @param {{resume?: boolean, exists?: (p:string)=>boolean, home?: string}} [o]  resume=true 续接上次对话
 */
export function codexStartCommand(session, { resume = false, exists = existsSync, home } = {}) {
  const key = session?.codexProvider?.providerKey;
  // 供应商名只允许安全字符：它会原样进 shell 命令
  const override = typeof key === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(key) ? ` -c 'model_provider="${key}"'` : '';
  const dir = session?.id && /^[A-Za-z0-9_-]{1,80}$/.test(String(session.id)) ? sessionCodexHome(session.id, home) : '';
  // 会话没单独选过供应商（目录不存在）就跟随全局，不硬塞一个空目录
  const envPrefix = dir && exists(path.join(dir, 'config.toml')) ? `CODEX_HOME='${dir.replace(/'/g, "'\\''")}' ` : '';
  return `${envPrefix}${resume ? `codex --no-daemon resume --last${override}` : `codex --no-daemon${override}`}`;
}
