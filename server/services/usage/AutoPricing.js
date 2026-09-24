/**
 * 自动价格：LiteLLM 社区维护的模型价格表，作为 CC Switch 价格表的**补充**（CC Switch 优先）。
 *
 * 为什么是它（2026-09-24 实测）：4328 个模型；与 CC Switch 共有的 59 个里 55 个输入/输出价一致；
 * CC Switch 缺的 claude-opus-5-5（$4/$20）与 gpt-6-sol（$2/$10）它都有，且与 OpenRouter 独立报价完全一致。
 * 旧逻辑把 opus-5-5 按 opus-5（$5/$25）算，单价高估 25%。
 *
 * 为什么 CC Switch 优先：那是用户唯一能直接改价的地方。自动源优先的话，它哪天错了用户无从纠正。
 *
 * 拉取：每天一次，jsDelivr 在前 —— 服务端的 fetch 不走代理，国内直连 raw.githubusercontent.com 实测 20 秒超时，
 * jsDelivr 1 秒内拿到。拉取失败**保留上次的缓存**，绝不因为网络问题把价格变成"无"。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import os from 'os';
import path from 'path';

const FILE = 'model_prices_and_context_window.json';
export const SOURCES = [
  `https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/${FILE}`,
  `https://raw.githubusercontent.com/BerriAI/litellm/main/${FILE}`,
];
export const REFRESH_MS = 24 * 3600 * 1000;
/** 少于这么多条带价格的模型，视为拿到的是残缺/错误文件，不采用（2026-09-24 实测不带平台前缀的有 546 条） */
const MIN_ENTRIES = 300;
/** 单价上限（$/百万 token）。超过必是单位错了（比如把每 token 价当成每百万），宁可不用 */
const MAX_PER_M = 1000;

/**
 * LiteLLM 原始 JSON → {model_id: {in,out,cacheRead,cacheWrite}}（每百万 token 美元）。
 * 只收**不带平台前缀**的条目：`bedrock/…`、`azure/…` 这类是各云平台自己的价，与直连不同。
 */
export function parseLiteLLM(raw) {
  const out = {};
  for (const [id, v] of Object.entries(raw || {})) {
    if (!v || typeof v !== 'object' || id.includes('/') || id === 'sample_spec') continue;
    const inP = v.input_cost_per_token, outP = v.output_cost_per_token;
    if (!Number.isFinite(inP) || !Number.isFinite(outP) || inP < 0 || outP < 0) continue;
    const perM = (x) => Math.round((Number(x) || 0) * 1e6 * 1e6) / 1e6;   // 去掉 0.19999999… 的浮点尾巴
    const p = { in: perM(inP), out: perM(outP), cacheRead: perM(v.cache_read_input_token_cost), cacheWrite: perM(v.cache_creation_input_token_cost) };
    if (Object.values(p).some((x) => x > MAX_PER_M)) continue;
    out[id] = p;
  }
  return out;
}

export class AutoPricing {
  constructor({ dir = path.join(os.homedir(), '.webtmux', 'pricing'), fetcher = globalThis.fetch, log = console } = {}) {
    Object.assign(this, { dir, fetcher, log });
    this.cacheFile = path.join(dir, 'litellm.json');
    this.prices = null;
    this.version = 0;
    this.status = { ok: false, fetchedAt: 0, count: 0, source: '', error: '' };
    this._loadCache();
  }

  _loadCache() {
    try {
      const c = JSON.parse(readFileSync(this.cacheFile, 'utf8'));
      if (c?.prices && Object.keys(c.prices).length >= MIN_ENTRIES) {
        this.prices = c.prices; this.version += 1;
        this.status = { ok: true, fetchedAt: c.fetchedAt || 0, count: Object.keys(c.prices).length, source: c.source || '', error: '' };
      }
    } catch { /* 首次没有缓存 */ }
  }

  /** 缓存过期才拉；force 用于手动刷新。返回是否拿到了新表 */
  async refresh({ force = false, now = Date.now() } = {}) {
    if (!force && this.prices && now - this.status.fetchedAt < REFRESH_MS) return false;
    const errors = [];
    for (const url of SOURCES) {
      try {
        const r = await this.fetcher(url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const prices = parseLiteLLM(await r.json());
        const count = Object.keys(prices).length;
        if (count < MIN_ENTRIES) throw new Error(`只解析出 ${count} 条，疑似残缺`);
        mkdirSync(this.dir, { recursive: true });
        const tmp = `${this.cacheFile}.tmp`;
        writeFileSync(tmp, JSON.stringify({ fetchedAt: now, source: url, prices }));
        renameSync(tmp, this.cacheFile);           // 原子替换：写一半断电也不会留下坏缓存
        this.prices = prices; this.version += 1;
        this.status = { ok: true, fetchedAt: now, count, source: url, error: '' };
        this.log.log?.(`[价格] 自动价格表已更新：${count} 个模型（${new URL(url).host}）`);
        return true;
      } catch (e) { errors.push(`${new URL(url).host}: ${e.cause?.code || e.message}`); }
    }
    // 全失败：保留旧表，只记错误
    this.status = { ...this.status, error: errors.join('；') };
    this.log.warn?.(`[价格] 自动价格表拉取失败，继续用${this.prices ? '上次的缓存' : '（无缓存）'}：${this.status.error}`);
    return false;
  }

  hasCache() { return existsSync(this.cacheFile); }
}
