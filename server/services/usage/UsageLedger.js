/**
 * 用量账本（data/token_stats.db 里另建表，不碰现有 token_usage —— 那张表记的是 WebTmux 监控自身的调用）
 *
 * 核心不变式：**会话花费 = Σ 各 run 的「认领后增量」**，永远不是某个累计值。
 * 认领时把当时的累计记成基线，所以 `claude --resume` 一个花过几千刀的老会话、或 codex 目录里堆着几十份历史 rollout，
 * 都不会把历史算进这个会话。`credited_usd` 单调不减，已记过的钱不追溯搬家（否则每日总额会出现负增量）。
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { localDayKey } from './costMath.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export class UsageLedger {
  constructor({ dbPath = join(HERE, '../../../data/token_stats.db') } = {}) {
    if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cli_run_binding (
        session_id TEXT NOT NULL, cli TEXT NOT NULL, run_key TEXT NOT NULL,
        claimed_at INTEGER, claimed_cum_usd REAL DEFAULT 0, credited_usd REAL DEFAULT 0,
        released_at INTEGER, source TEXT,
        PRIMARY KEY (session_id, cli, run_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_cli_run_active ON cli_run_binding(cli, run_key) WHERE released_at IS NULL;
      CREATE TABLE IF NOT EXISTS cli_run_cursor (
        cli TEXT NOT NULL, run_key TEXT NOT NULL, file_path TEXT, inode TEXT,
        file_size INTEGER DEFAULT 0, file_mtime REAL DEFAULT 0, scan_offset INTEGER DEFAULT 0,
        anchor_usd REAL DEFAULT 0, by_model TEXT, cum_usd REAL DEFAULT 0,
        cost_complete INTEGER DEFAULT 1, estimated INTEGER DEFAULT 0, updated_at INTEGER,
        PRIMARY KEY (cli, run_key)
      );
      CREATE TABLE IF NOT EXISTS cli_usage_daily (
        day TEXT NOT NULL, session_id TEXT NOT NULL, cli TEXT NOT NULL, model TEXT DEFAULT '',
        cost_usd REAL DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
        PRIMARY KEY (day, session_id, cli, model)
      );
    `);
  }

  getCursor(cli, runKey) {
    const r = this.db.prepare('SELECT * FROM cli_run_cursor WHERE cli=? AND run_key=?').get(cli, runKey);
    return r ? { ...r, byModel: r.by_model ? JSON.parse(r.by_model) : {} } : null;
  }

  activeBinding(cli, runKey) {
    return this.db.prepare('SELECT * FROM cli_run_binding WHERE cli=? AND run_key=? AND released_at IS NULL').get(cli, runKey) || null;
  }

  sessionBindings(sessionId) {
    return this.db.prepare('SELECT * FROM cli_run_binding WHERE session_id=?').all(sessionId);
  }

  /** 认领：把当前累计记成基线。同一个 run 已被别的会话占着就先释放（保留它已记的钱，不回收） */
  claim(sessionId, cli, runKey, cumUsd, source, now = Date.now()) {
    const held = this.activeBinding(cli, runKey);
    if (held && held.session_id !== sessionId) this.release(cli, runKey, now);
    else if (held) return held;
    this.db.prepare(`INSERT INTO cli_run_binding (session_id, cli, run_key, claimed_at, claimed_cum_usd, credited_usd, source)
      VALUES (?,?,?,?,?,0,?)
      ON CONFLICT(session_id, cli, run_key) DO UPDATE SET released_at=NULL, claimed_at=excluded.claimed_at,
        claimed_cum_usd=excluded.claimed_cum_usd, source=excluded.source`).run(sessionId, cli, runKey, now, cumUsd, source);
    return this.activeBinding(cli, runKey);
  }

  release(cli, runKey, now = Date.now()) {
    this.db.prepare('UPDATE cli_run_binding SET released_at=? WHERE cli=? AND run_key=? AND released_at IS NULL').run(now, cli, runKey);
  }

  /** 一笔增量：写日账 + 累加 credited + 推游标，三件事必须原子，否则重启后会重复计 */
  record({ sessionId, cli, runKey, deltaUsd, tokens = {}, model = '', cursor, now = Date.now(), lastDay = '' }) {
    const day = localDayKey(now, lastDay);
    const tx = this.db.transaction(() => {
      if (deltaUsd > 0 || tokens.input || tokens.output) {
        this.db.prepare(`INSERT INTO cli_usage_daily (day, session_id, cli, model, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
          VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(day, session_id, cli, model) DO UPDATE SET cost_usd=cost_usd+excluded.cost_usd,
            input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens,
            cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens`)
          .run(day, sessionId, cli, model, deltaUsd, tokens.input || 0, tokens.output || 0, tokens.cacheRead || 0, tokens.cacheWrite || 0);
        this.db.prepare('UPDATE cli_run_binding SET credited_usd=credited_usd+? WHERE session_id=? AND cli=? AND run_key=?')
          .run(deltaUsd, sessionId, cli, runKey);
      }
      this.db.prepare(`INSERT INTO cli_run_cursor (cli, run_key, file_path, inode, file_size, file_mtime, scan_offset, anchor_usd, by_model, cum_usd, cost_complete, estimated, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(cli, run_key) DO UPDATE SET file_path=excluded.file_path, inode=excluded.inode, file_size=excluded.file_size,
          file_mtime=excluded.file_mtime, scan_offset=excluded.scan_offset, anchor_usd=excluded.anchor_usd, by_model=excluded.by_model,
          cum_usd=excluded.cum_usd, cost_complete=excluded.cost_complete, estimated=excluded.estimated, updated_at=excluded.updated_at`)
        .run(cli, runKey, cursor.filePath, String(cursor.inode || ''), cursor.fileSize || 0, cursor.fileMtime || 0,
          cursor.scanOffset || 0, cursor.anchorUsd || 0, JSON.stringify(cursor.byModel || {}), cursor.cumUsd || 0,
          cursor.costComplete ? 1 : 0, cursor.estimated ? 1 : 0, now);
    });
    tx();
    return day;
  }

  sessionTotal(sessionId) {
    const r = this.db.prepare('SELECT COALESCE(SUM(credited_usd),0) usd FROM cli_run_binding WHERE session_id=?').get(sessionId);
    return r?.usd || 0;
  }

  dayTotal(day, sessionId = null) {
    const sql = sessionId
      ? 'SELECT COALESCE(SUM(cost_usd),0) usd FROM cli_usage_daily WHERE day=? AND session_id=?'
      : 'SELECT COALESCE(SUM(cost_usd),0) usd FROM cli_usage_daily WHERE day=?';
    return (sessionId ? this.db.prepare(sql).get(day, sessionId) : this.db.prepare(sql).get(day))?.usd || 0;
  }
}
