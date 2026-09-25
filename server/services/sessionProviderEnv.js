/**
 * 会话级供应商：写进项目 .claude/settings.local.json 的 env（纯函数，便于单测）。
 *
 * 直连：真实地址与密钥直接写 env，Claude Code 热加载生效，不经任何本地转发。
 *
 * 为什么有迁移（2026-09-25）：v1.2.26 起会话级切换写的是 `http://127.0.0.1:<port>/relay/<会话id>`
 * 占位地址 + `webtmux-relay-<id>` 占位密钥，由 WebTmux 转发。用户明确否定这种做法，
 * v1.4.55 删除了 relay；已经写成 relay 的项目配置、以及用 relay 环境启动还在跑的 CLI，
 * 启动时迁成直连（热加载让在跑的 CLI 当场切过去），否则删掉转发后它们的请求全部失败。
 */

export const CLAUDE_ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'];
/** 会话显式选「官方登录」时的供应商描述（没有 CC Switch 供应商 id：迁移旧配置、转回终端恢复时用） */
export const OAUTH_PROVIDER_INFO = Object.freeze({ isOAuth: true, env: {}, provider: { id: 'oauth', name: 'Claude 官方登录' } });

/** 旧 relay 地址形态（只用于识别并迁走旧配置，不再生成） */
export const LEGACY_RELAY_URL = /^https?:\/\/127\.0\.0\.1:\d+\/relay\/([^/\s]+)/;

/**
 * 供应商 → 四个 env 的值。没有的键给 ""：热加载时删键不会清掉进程里已有的值，只有 "" 会覆盖。
 * @param {{isOAuth?:boolean, env?:object}} info resolveProviderInfo 的结果
 */
export function sessionClaudeEnv(info) {
  const env = info?.isOAuth ? {} : (info?.env || {});
  return Object.fromEntries(CLAUDE_ENV_KEYS.map((k) => [k, String(env[k] || '')]));
}

/** 这份项目配置是不是旧 relay 写出来的 */
export function isLegacyRelayConfig(ls) {
  return ls?._localProvider === 'relay-proxy' || LEGACY_RELAY_URL.test(String(ls?.env?.ANTHROPIC_BASE_URL || ''));
}

/**
 * 迁移计划：该会话要改成什么。
 * @param {object} ls         项目 settings.local.json（可为 {}）
 * @param {string} procUrl    在跑 CLI 进程/会话 tmux 环境里的 ANTHROPIC_BASE_URL（取不到给 ''）
 * @param {object} relayMap   旧 ~/.webtmux/session-relay.json 的内容 {sessionId: {providerId,...}}
 * @param {string} sessionId
 * @returns {{action:'none'}|{action:'provider', providerId:string, why:string}|{action:'oauth', why:string}|{action:'unknown', why:string}}
 */
export function relayMigrationPlan(ls, procUrl, relayMap, sessionId) {
  const inConfig = isLegacyRelayConfig(ls);
  const inProcess = LEGACY_RELAY_URL.test(String(procUrl || ''));
  if (!inConfig && !inProcess) return { action: 'none' };
  // 进程启动环境是 relay，但项目配置已显式写出全部四个键：settings 的 env 覆盖启动环境，已经不走 relay了
  //（ps 读到的永远是**启动时**的环境，热加载改不了它，不这样判断每次启动都会重复迁移）
  if (!inConfig && CLAUDE_ENV_KEYS.every((k) => typeof ls?.env?.[k] === 'string')) return { action: 'none' };
  const why = inConfig ? '项目配置是 relay' : '配置已改但 CLI 仍以 relay 环境在跑';
  // 配置已改回官方登录、只是进程没重启（实测 phyviz）：按配置的意图，写空值把进程里的 relay 覆盖掉
  if (!inConfig && ls?._localProvider === 'oauth') return { action: 'oauth', why };
  // 配置已是直连、进程还没热加载：按配置里的供应商重写一次即可
  if (!inConfig && ls?._localProvider === 'session' && ls?._localProviderId) {
    return { action: 'provider', providerId: ls._localProviderId, why };
  }
  if (inConfig) {
    const providerId = ls?._localProviderId || relayMap?.[sessionId]?.providerId || '';
    if (providerId) return { action: 'provider', providerId, why };
  }
  // 配置是「跟随全局」而进程在 relay 上：该迁成什么是猜测，不替用户决定，只报出来
  return { action: 'unknown', why };
}
