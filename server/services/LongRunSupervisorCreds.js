/**
 * 长程编排：监督者凭据（CC Switch）
 *
 * 原版从 .env 读 SUPERVISOR_API_KEY；WebTmux 禁止硬编码 Key，一律从 CC Switch 取。来源顺序：
 *   1. 面板上明确选的供应商 —— 用户的选择，没有凭据就报不可用，**不偷偷换成别家**
 *   2. 当前全局 Claude 供应商（有 URL + Key 时）
 *   3. 借一个带凭据的第三方供应商 —— 与 AI 监控同一机制（AIEngine.getProxyMonitorSettings）
 *
 * 为什么要借：本机 Claude 多为 OAuth 登录，全局配置结构上就没有 Key（2026-09-17 首次真实运行时监督者因此不可用）。
 * 为什么要轮换：CC Switch 里带凭据的供应商大多不可用（实测 32 个里只有 2 个能用；有的域名在本机解析被污染、连接超时）。
 * 借来的调不通就拉黑换下一个；黑名单与"上次调通"记在同一个 AIEngine 上，监督者与监控互相受益。
 */

/** 原版默认用最强的 Opus 做判定（判定出错的代价是烧钱或越界代答）；与原版同名的环境变量可覆盖 */
export const SUPERVISOR_DEFAULT_MODEL = 'claude-opus-5';
export const supervisorModel = (env = process.env) => env.SUPERVISOR_MODEL || SUPERVISOR_DEFAULT_MODEL;

/** 一次判定里最多换几家。每家死供应商要等连接超时才能判死，不设上限一次判定可能拖十几分钟 */
export const MAX_PROVIDER_SWITCHES = 5;

const usable = (st) => !!(st?.claude?.apiUrl && st.claude.apiKey);

export class SupervisorCredentials {
  /**
   * @param {object} o
   * @param {object} o.engine        AIEngine
   * @param {string} [o.providerId]  面板上明确选的供应商
   * @param {() => string[]} [o.priority]  借用时的名称优先级（与监控共用 CLAUDE_PROVIDER_PRIORITY）
   * @param {string} [o.model]
   * @param {(info) => void} [o.onSwitch]  换供应商时回调（记日志）
   */
  constructor({ engine, providerId = null, priority = () => [], model = supervisorModel(), onSwitch = null } = {}) {
    Object.assign(this, { engine, providerId, priority, model, onSwitch });
    this.current = null;
    this.switches = 0;
  }

  /** 按来源顺序解析一份凭据，不调网络。返回 {config, name, borrowed, key} 或 null。 */
  resolve() {
    const e = this.engine;
    if (!e) return null;
    const pack = (st, name, borrowed) => ({
      config: { ...st.claude, model: this.model }, name, borrowed, key: st._providerId || null,
    });
    if (this.providerId) {
      const st = e.resolveSessionSettings?.('claude', this.providerId);
      return usable(st) ? pack(st, st._providerName || this.providerId, false) : null;
    }
    const global = e.getSettings?.();
    if (usable(global)) return pack(global, global._currentProvider?.name || '当前 Claude 供应商', false);
    const proxy = e.getProxyMonitorSettings?.(this.priority() || []);
    return usable(proxy) ? pack(proxy, String(proxy._providerName || '').replace(/\s*\(代理监控\)$/, ''), true) : null;
  }

  /** 给 Supervisor 用的 complete(system, user)。借来的调不通就拉黑换下一家再试。 */
  async complete(system, user) {
    let cred = this.current || this.resolve();
    if (!cred) throw new Error('没有可用的 Claude 供应商（CC Switch 里没有带地址与密钥的供应商）');
    for (let attempt = 0; ; attempt += 1) {
      try {
        // 借来的不做内部重试：死供应商每次要等满连接超时，重试三次只是把换下一家推迟半分钟。换家就是重试
        const r = await this.engine.callClaudeMessages({ config: cred.config, system, user, maxTokens: 4000,
          ...(cred.borrowed ? { maxRetries: 0 } : {}) });
        this.current = cred;
        if (cred.borrowed && cred.key) this.engine._proxyLastGood = cred.key;   // 与监控共享"上次调通"
        return r;
      } catch (err) {
        if (!cred.borrowed || attempt >= MAX_PROVIDER_SWITCHES) throw err;
        this.engine.blacklistProxyProvider?.(cred.key, err.message);
        const next = this.resolve();
        if (!next || next.key === cred.key) throw err;
        this.switches += 1;
        this.onSwitch?.({ from: cred.name, to: next.name, error: err.message });
        this.current = cred = next;
      }
    }
  }
}
