/**
 * 模型单价（来自 CC Switch 的 model_pricing，只读）
 *
 * 实测：201 个模型，覆盖在用的 claude-opus-5 / gpt-5.6-sol / grok-4.6；
 * 四个价格列在库里是 **TEXT**，必须 Number()，否则 '5' * n 会变成字符串运算。
 * 用它重算 claude-opus-4-8 得 403.50，CLI 自记 403.50252 —— 精度可信。
 * 读不到库时返回"无价格表"，让调用方显示"未知"，**不能当成 0**。
 *
 * 价格表在 CC Switch 里维护（「模型定价」），这里只读。模型更新后要做的只有一件事：去 CC Switch 补一条。
 * 为了让人知道要补哪条，这里记下所有查不到价格的模型（misses），界面列出来。
 */

/** 缺价记录保留多久。超过的视为不再使用（换掉了），不再提示 */
export const MISS_TTL_MS = 7 * 24 * 3600 * 1000;

import Database from 'better-sqlite3';
import { existsSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { matchModelId } from './costMath.js';

export const CC_SWITCH_DB = () => path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
const RECHECK_MS = 10 * 60 * 1000;

export class PricingTable {
  constructor({ dbPath = null } = {}) {
    this.dbPath = dbPath || CC_SWITCH_DB();
    this.prices = null;       // model_id -> {in,out,cacheRead,cacheWrite}
    this.loadedAt = 0;
    this.mtime = 0;
    /** 每次真正重读价格表 +1。用量采集据此强制重算：补了价格不必等会话文件变动才生效 */
    this.version = 0;
    /** 原始模型名 -> {firstAt, lastAt}：查不到价格的模型 */
    this.misses = new Map();
  }

  /** 按 mtime + 10 分钟复查；库不存在返回 null（调用方据此显示"无价格表"） */
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
        map[r.model_id] = {
          in: Number(r.input_cost_per_million) || 0,
          out: Number(r.output_cost_per_million) || 0,
          cacheRead: Number(r.cache_read_cost_per_million) || 0,
          cacheWrite: Number(r.cache_creation_cost_per_million) || 0,
        };
      }
      this.prices = map; this.mtime = mtime; this.loadedAt = now; this.version += 1;
      // 表换了：已补上价格的从缺价记录里清掉（没补的下次查询会重新记上）
      for (const m of [...this.misses.keys()]) if (matchModelId(m, Object.keys(map)).id) this.misses.delete(m);
    } catch (e) {
      console.warn('[用量] 读价格表失败:', e.message);
      this.prices = null; this.loadedAt = now;
    }
    return this.prices;
  }

  /**
   * @returns {{price: object|null, modelId: string, how: string}} 查不到时 price 为 null ——
   *   调用方必须标"费用不完整"，不得记 0。how 见 costMath.matchModelId
   */
  get(model, now = Date.now()) {
    const prices = this.load();
    if (!prices) return { price: null, modelId: '', how: '' };
    const { id, how } = matchModelId(model, Object.keys(prices));
    const name = String(model || '').trim();
    if (!id && name && name !== '<synthetic>') {
      const m = this.misses.get(name);
      this.misses.set(name, { firstAt: m?.firstAt || now, lastAt: now });
    }
    return { price: id ? prices[id] : null, modelId: id, how };
  }

  /**
   * 最近 7 天用过但价格表里没有的模型（新的在前）。
   * @returns {{tableFound:boolean, models:Array<{model:string, firstAt:number, lastAt:number}>}}
   */
  missing(now = Date.now()) {
    const tableFound = !!this.load();
    const models = [...this.misses.entries()].filter(([, v]) => now - v.lastAt <= MISS_TTL_MS)
      .map(([model, v]) => ({ model, ...v })).sort((a, b) => b.lastAt - a.lastAt);
    return { tableFound, models };
  }
}

export default new PricingTable();
