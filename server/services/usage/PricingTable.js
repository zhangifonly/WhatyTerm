/**
 * 模型单价：CC Switch 的 model_pricing（只读，**优先**）+ LiteLLM 自动价格（补缺，见 AutoPricing.js）。
 *
 * CC Switch 实测：四个价格列在库里是 **TEXT**，必须 Number()；重算 claude-opus-4-8 得 403.50，CLI 自记 403.50252。
 * 两边都查不到才算缺价 —— 调用方显示"未知/不完整"，**不能当成 0**。
 * 选价规则见 priceResolve.js。每个查过的模型记下「从哪层取到的价」，界面据此列出自动价格、缺价、不一致。
 */

import Database from 'better-sqlite3';
import { existsSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { resolvePrice, priceConflict } from './priceResolve.js';

export const CC_SWITCH_DB = () => path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
const RECHECK_MS = 10 * 60 * 1000;
/** 查询记录保留多久。超过的视为不再使用（换掉了），不再提示 */
export const MISS_TTL_MS = 7 * 24 * 3600 * 1000;

export class PricingTable {
  /** @param {{dbPath?:string, auto?:{prices:object|null, version:number, status?:object}|null}} opts */
  constructor({ dbPath = null, auto = null } = {}) {
    this.dbPath = dbPath || CC_SWITCH_DB();
    this.auto = auto;
    this.prices = null;       // CC Switch：model_id -> {in,out,cacheRead,cacheWrite}
    this.loadedAt = 0;
    this.mtime = 0;
    this.ccsVersion = 0;
    /** 原始模型名 -> {lastAt}：查过的模型（缺价/自动价/不一致都从这里按现价重新判定） */
    this.used = new Map();
    this._memo = new Map();
    this._memoVer = '';
  }

  /** 任一层价格表换了就变。用量采集据此强制按现价重算：补了价不必等会话文件变动才生效 */
  get version() { return `${this.ccsVersion}.${this.auto?.version || 0}`; }

  /** CC Switch 表：按 mtime + 10 分钟复查；库不存在返回 null */
  load() {
    const now = Date.now();
    if (this.prices && now - this.loadedAt < RECHECK_MS) return this.prices;
    if (!existsSync(this.dbPath)) { this.prices = null; this.loadedAt = now; return null; }
    const mtime = statSync(this.dbPath).mtimeMs;
    if (this.prices && mtime === this.mtime) { this.loadedAt = now; return this.prices; }
    try {
      const db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      const rows = db.prepare('SELECT model_id, input_cost_per_million, output_cost_per_million,'
        + ' cache_read_cost_per_million, cache_creation_cost_per_million FROM model_pricing').all();
      db.close();
      const map = {};
      for (const r of rows) {
        map[r.model_id] = { in: Number(r.input_cost_per_million) || 0, out: Number(r.output_cost_per_million) || 0,
          cacheRead: Number(r.cache_read_cost_per_million) || 0, cacheWrite: Number(r.cache_creation_cost_per_million) || 0 };
      }
      this.prices = map; this.mtime = mtime; this.loadedAt = now; this.ccsVersion += 1;
    } catch (e) {
      console.warn('[用量] 读价格表失败:', e.message);
      this.prices = null; this.loadedAt = now;
    }
    return this.prices;
  }

  /** 不记录查询的纯解析（带缓存：自动表两千多条，匹配要扫全表） */
  resolve(model) {
    const ccs = this.load();
    const auto = this.auto?.prices || null;
    if (this._memoVer !== this.version) {
      this._memo.clear(); this._memoVer = this.version;
      this._keys = { ccsKeys: ccs ? Object.keys(ccs) : [], autoKeys: auto ? Object.keys(auto) : [] };
    }
    const k = String(model || '').trim();
    if (!this._memo.has(k)) this._memo.set(k, resolvePrice(k, ccs, auto, this._keys));
    return this._memo.get(k);
  }

  /**
   * @returns {{price:object|null, modelId:string, how:string, source:string}} 查不到时 price 为 null ——
   *   调用方必须标"费用不完整"，不得记 0。source: ccswitch | litellm | ''
   */
  get(model, now = Date.now()) {
    const r = this.resolve(model);
    const name = String(model || '').trim();
    if (name && name !== '<synthetic>') this.used.set(name, { lastAt: now });
    return r;
  }

  /** 最近 7 天查过的模型，按**现价**重新判定（补了价的自然消失） */
  _recent(now) {
    return [...this.used.entries()].filter(([, v]) => now - v.lastAt <= MISS_TTL_MS)
      .sort((a, b) => b[1].lastAt - a[1].lastAt).map(([model, v]) => ({ model, lastAt: v.lastAt, ...this.resolve(model) }));
  }

  /** 界面用的汇总：缺价 / 用了自动价格 / CC Switch 与自动价不一致，以及两层表各自的状态 */
  report(now = Date.now()) {
    const recent = this._recent(now);
    const auto = this.auto?.prices || null;
    return {
      tableFound: !!this.load(),
      auto: this.auto?.status || { ok: false },
      missing: recent.filter((r) => !r.price).map(({ model, lastAt }) => ({ model, lastAt })),
      autoPriced: recent.filter((r) => r.source === 'litellm').map(({ model, modelId, price }) => ({ model, modelId, price })),
      conflicts: recent.filter((r) => r.source === 'ccswitch').map((r) => priceConflict(r.modelId, this.prices, auto))
        .filter(Boolean).filter((c, i, a) => a.findIndex((x) => x.model === c.model) === i),
    };
  }
}

export default new PricingTable();
