/**
 * 长程编排：监督者通道（CC Switch）
 *
 * 原版从 .env 读 SUPERVISOR_API_KEY；WebTmux 禁止硬编码 Key，一律从 CC Switch 取。两条通道：
 *   1. 默认：经 claude CLI（LongRunSupervisorCli）—— 用的就是 CC Switch 当前的 Claude 配置，与执行者同一套地址、登录与代理
 *   2. 面板上明确选了供应商：按该供应商的地址与密钥直接调 HTTP；没有凭据就报不可用，**不偷偷换成别家**
 *
 * 历史：v1.4.14 起全局无密钥（OAuth）时借用带凭据的第三方供应商并轮换。2026-09-17 实测连续 5 家 fetch failed
 * （域名在本机 DNS 被污染，AIEngine 直连不走代理），用户明确"能用的是 CC Switch 当前的 API 地址和设置"，改为走 CLI。
 */

import { CliSupervisorClient } from './LongRunSupervisorCli.js';

/** 原版默认用最强的 Opus 做判定（判定出错的代价是烧钱或越界代答）；与原版同名的环境变量可覆盖 */
export const SUPERVISOR_DEFAULT_MODEL = 'claude-opus-5';
export const supervisorModel = (env = process.env) => env.SUPERVISOR_MODEL || SUPERVISOR_DEFAULT_MODEL;

const usable = (st) => !!(st?.claude?.apiUrl && st.claude.apiKey);

/** CC Switch 当前 Claude 配置的展示信息（只给人看；CLI 自己读配置，这里不参与调用）。供应商名由面板按 AI 面板同一口径另取 */
export function currentClaudeInfo(engine) {
  const st = engine?.getSettings?.() || {};
  return { providerName: 'CC Switch 当前 Claude 配置', baseUrl: st.claude?.apiUrl || 'Anthropic 官方（OAuth 登录）' };
}

/**
 * 组装监督者的 complete(system, user) 与自检信息。
 * @param {object} o
 * @param {object} o.engine        AIEngine（明确选定供应商时用它解析与调用）
 * @param {string} [o.providerId]  面板上明确选的供应商
 * @param {(model: string) => {complete: Function}} [o.cliFactory]  测试钩子
 * @returns {{complete?: Function, info: object}}
 */
export function makeSupervisorChannel({ engine, providerId = null, model = supervisorModel(),
  cliFactory = (m) => new CliSupervisorClient({ model: m }) } = {}) {
  if (providerId) {
    const st = engine?.resolveSessionSettings?.('claude', providerId);
    if (!usable(st)) {
      return { info: { status: 'unavailable', error: '所选供应商没有可用的地址与密钥（明确选定的供应商不会被自动换掉）' } };
    }
    const config = { ...st.claude, model };
    return {
      complete: (system, user) => engine.callClaudeMessages({ config, system, user, maxTokens: 4000 }),
      info: { status: 'on', via: 'http', model, baseUrl: config.apiUrl, providerName: st._providerName || providerId },
    };
  }
  const client = cliFactory(model);
  return {
    complete: (system, user) => client.complete(system, user),
    info: { status: 'on', via: 'cli', model, ...currentClaudeInfo(engine) },
  };
}
