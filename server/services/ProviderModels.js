/**
 * 供应商可用模型发现。
 *
 * 由来（Hitech 2026-09-18/19 实测）：长程连着两轮全军覆没，真因是
 * `503 分组 zhangzong 下模型 claude-fable-5-1 无可用渠道（distributor）` ——
 * 中转站没有该模型的渠道。而启动界面里模型只是高级参数里的一个**手输文本框**
 * （占位符「留空 = CLI 默认」），既不知道当前供应商支持什么，也没法验证填得对不对，
 * 打错一个字的代价是十次重试 + 一发白跑。
 *
 * 这里从供应商自己的 `/v1/models` 拿清单（OpenAI 兼容口径，多数中转站都实现），
 * 给界面做下拉；拿不到就如实说拿不到，退回手输，**绝不编一份清单** ——
 * 编出来的名字同样会撞「无可用渠道」，那比没有清单更坏。
 *
 * ⚠️ 禁止硬编码 Key：凭据一律经 AIEngine.resolveSessionSettings 从 CC Switch 取。
 */

/** 拉清单的超时。中转站列表接口通常很快；慢过这个数就别卡着界面 */
export const MODELS_TIMEOUT_MS = 8000;

/** 结果缓存时长：同一次「开长程」里会反复开关弹窗，没必要每次都打一趟网络 */
export const MODELS_TTL_MS = 5 * 60 * 1000;

/** providerId -> { at, data }。导出供单测在用例间清理，避免上一条的缓存污染下一条 */
export const cache = new Map();

/**
 * 归一化 `/v1/models` 的返回。
 * OpenAI 口径是 `{data:[{id}]}`；有的中转站直接返回数组，或用 `models` 键。
 * @param {any} body 解析后的响应体
 * @returns {string[]} 模型 id 列表（去重、保序）
 */
export function parseModelList(body) {
  const rows = Array.isArray(body) ? body
    : Array.isArray(body?.data) ? body.data
      : Array.isArray(body?.models) ? body.models : [];
  const out = [];
  for (const r of rows) {
    const id = typeof r === 'string' ? r : (r?.id || r?.model || r?.name || '');
    const s = String(id).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * `/v1/models` 的完整 URL。供应商配的 baseUrl 形态很杂：
 * 有的带 `/v1`，有的带 `/api/v1/messages`（Claude Relay），有的什么都不带。
 * @param {string} baseUrl
 * @returns {string}
 */
export function modelsUrl(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  // 把末尾的具体接口路径剥掉，只留站点根：/api/v1/messages、/v1/messages、/v1 都剥
  const root = raw.replace(/\/(api\/)?v1(\/messages)?$/i, '');
  return `${root}/v1/models`;
}

/**
 * 取某供应商的可用模型清单。
 *
 * @param {object} o
 * @param {object} o.engine        AIEngine，用它经 CC Switch 解析地址与密钥（禁止硬编码 Key）
 * @param {string} o.providerId    供应商 id；为空表示"跟随 CC Switch 当前配置"
 * @param {boolean} [o.refresh]    true 则跳过缓存
 * @param {Function} [o.fetchImpl] 注入点（测试用）
 * @returns {Promise<{ok:boolean, models:string[], configured:string, baseUrl:string, error?:string, cached?:boolean}>}
 *   ok=false 时 models 为空，界面退回手输 —— 不猜、不编清单
 */
export async function listProviderModels({ engine, providerId = '', refresh = false, fetchImpl = fetch } = {}) {
  const key = providerId || '__current__';
  if (!refresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < MODELS_TTL_MS) return { ...hit.data, cached: true };
  }

  const st = providerId
    ? engine?.resolveSessionSettings?.('claude', providerId)
    : engine?.getSettings?.();
  const baseUrl = String(st?.claude?.apiUrl || '').trim();
  const apiKey = String(st?.claude?.apiKey || '').trim();
  // 供应商配置里已经写好的模型：清单拉不到时至少能让人一键选回它
  const configured = String(st?.claude?.model || '').trim();

  const fail = (error) => {
    const data = { ok: false, models: [], configured, baseUrl, error };
    cache.set(key, { at: Date.now(), data });   // 失败也缓存：别让界面每次开都卡 8 秒
    return data;
  };

  const url = modelsUrl(baseUrl);
  // OAuth 登录（无 key、走官方）时没有中转站的列表接口可问，如实说明
  if (!url) return fail('当前配置没有自定义 API 地址（官方 OAuth 登录），拿不到模型清单');
  if (!apiKey) return fail('当前供应商没有密钥，无法查询模型清单');

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), MODELS_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(url, {
        signal: ctl.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
      });
    } finally { clearTimeout(timer); }

    if (!res?.ok) return fail(`供应商返回 ${res?.status ?? '?'}，拿不到模型清单`);
    const models = parseModelList(await res.json());
    if (!models.length) return fail('供应商的模型清单是空的');
    const data = { ok: true, models, configured, baseUrl };
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    return fail(e.name === 'AbortError' ? `查询超时（${MODELS_TIMEOUT_MS / 1000} 秒）` : e.message);
  }
}

export default { listProviderModels, parseModelList, modelsUrl, MODELS_TIMEOUT_MS, MODELS_TTL_MS, cache };
