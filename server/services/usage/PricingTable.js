/**
 * 模型单价（来自 CC Switch 的 model_pricing，只读）
 *
 * 实测：201 个模型，覆盖在用的 claude-opus-5 / gpt-5.6-sol / grok-4.6；
 * 四个价格列在库里是 **TEXT**，必须 Number()，否则 '5' * n 会变成字符串运算。
 * 用它重算 claude-opus-4-8 得 403.50，CLI 自记 403.50252 —— 精度可信。
 * 读不到库时返回"无价格表"，让调用方显示"未知"，**不能当成 0**。
 */

import Database from 'better-sqlite3';
import { existsSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { normalizeModelId } from './costMath.js';

export const CC_SWITCH_DB = () => path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
const RECHECK_MS = 10 * 60 * 1000;

export class PricingTable {
  constructor({ dbPath = null } = {}) {
    this.dbPath = dbPath || CC_SWITCH_DB();
    this.prices = null;       // model_id -> {in,out,cacheRead,cacheWrite}
    this.loadedAt = 0;
    this.mtime = 0;
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
      this.prices = map; this.mtime = mtime; this.loadedAt = now;
    } catch (e) {
      console.warn('[用量] 读价格表失败:', e.message);
      this.prices = null; this.loadedAt = now;
    }
    return this.prices;
  }

  /** @returns {{price: object|null, modelId: string}} 查不到时 price 为 null —— 调用方必须标"费用不完整"，不得记 0 */
  get(model) {
    const prices = this.load();
    if (!prices) return { price: null, modelId: '' };
    const id = normalizeModelId(model, Object.keys(prices));
    return { price: id ? prices[id] : null, modelId: id };
  }
}

export default new PricingTable();
