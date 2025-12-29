/**
 * Token 统计服务
 *
 * 统计维度：
 * 1. 按供应商（API 服务器）- 总体 + 按时间
 * 2. 按会话 - 总体 + 按时间
 * 3. 按模型 - 区分不同模型的消耗
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class TokenStatsService {
  constructor() {
    this.db = null;
    this._initDb();
  }

  _initDb() {
    const dbPath = join(__dirname, '../../data/token_stats.db');
    const dbDir = dirname(dbPath);

    // 确保数据库目录存在
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // 创建 token 使用记录表（详细记录每次 API 调用）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        session_id TEXT,
        provider_name TEXT NOT NULL,
        provider_url TEXT,
        model TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_creation_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        request_type TEXT,
        success INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 创建按小时汇总表（用于快速查询时间趋势）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_hourly_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hour_timestamp INTEGER NOT NULL,
        provider_name TEXT NOT NULL,
        model TEXT NOT NULL,
        session_id TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_creation_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        request_count INTEGER DEFAULT 0,
        UNIQUE(hour_timestamp, provider_name, model, session_id)
      )
    `);

    // 创建按天汇总表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_daily_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day_timestamp INTEGER NOT NULL,
        provider_name TEXT NOT NULL,
        model TEXT NOT NULL,
        session_id TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_creation_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        request_count INTEGER DEFAULT 0,
        UNIQUE(day_timestamp, provider_name, model, session_id)
      )
    `);

    // 创建索引
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_provider ON token_usage(provider_name)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(model)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_hourly_stats_hour ON token_hourly_stats(hour_timestamp)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_stats_day ON token_daily_stats(day_timestamp)`);

    console.log('[TokenStats] 数据库初始化完成');
  }

  /**
   * 记录一次 API 调用的 token 使用
   */
  recordUsage({
    sessionId,
    providerName,
    providerUrl,
    model,
    usage,
    requestType = 'analyze',
    success = true
  }) {
    if (!usage) return;

    const timestamp = Date.now();
    const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
    const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens || 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
    const totalTokens = inputTokens + outputTokens;

    // 插入详细记录
    const stmt = this.db.prepare(`
      INSERT INTO token_usage
      (timestamp, session_id, provider_name, provider_url, model,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       total_tokens, request_type, success)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      timestamp,
      sessionId || null,
      providerName || 'unknown',
      providerUrl || null,
      model || 'unknown',
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens,
      requestType,
      success ? 1 : 0
    );

    // 更新小时汇总
    this._updateHourlyStats(timestamp, sessionId, providerName, model, {
      inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalTokens
    });

    // 更新天汇总
    this._updateDailyStats(timestamp, sessionId, providerName, model, {
      inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalTokens
    });

    console.log(`[TokenStats] 记录: ${providerName}/${model} - 输入:${inputTokens} 输出:${outputTokens} 缓存:${cacheReadTokens}`);

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens
    };
  }

  _updateHourlyStats(timestamp, sessionId, providerName, model, tokens) {
    // 将时间戳归一化到小时
    const hourTimestamp = Math.floor(timestamp / 3600000) * 3600000;

    const stmt = this.db.prepare(`
      INSERT INTO token_hourly_stats
      (hour_timestamp, provider_name, model, session_id,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       total_tokens, request_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(hour_timestamp, provider_name, model, session_id) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        request_count = request_count + 1
    `);

    stmt.run(
      hourTimestamp,
      providerName || 'unknown',
      model || 'unknown',
      sessionId || '__global__',
      tokens.inputTokens,
      tokens.outputTokens,
      tokens.cacheReadTokens,
      tokens.cacheCreationTokens,
      tokens.totalTokens
    );
  }

  _updateDailyStats(timestamp, sessionId, providerName, model, tokens) {
    // 将时间戳归一化到天（UTC）
    const dayTimestamp = Math.floor(timestamp / 86400000) * 86400000;

    const stmt = this.db.prepare(`
      INSERT INTO token_daily_stats
      (day_timestamp, provider_name, model, session_id,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       total_tokens, request_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(day_timestamp, provider_name, model, session_id) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        request_count = request_count + 1
    `);

    stmt.run(
      dayTimestamp,
      providerName || 'unknown',
      model || 'unknown',
      sessionId || '__global__',
      tokens.inputTokens,
      tokens.outputTokens,
      tokens.cacheReadTokens,
      tokens.cacheCreationTokens,
      tokens.totalTokens
    );
  }

  /**
   * 获取供应商总体统计
   */
  getProviderStats(providerName = null) {
    let sql = `
      SELECT
        provider_name,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        SUM(cache_read_tokens) as total_cache_read,
        SUM(cache_creation_tokens) as total_cache_creation,
        SUM(total_tokens) as total_tokens,
        COUNT(*) as request_count,
        MIN(timestamp) as first_usage,
        MAX(timestamp) as last_usage
      FROM token_usage
    `;

    if (providerName) {
      sql += ` WHERE provider_name = ?`;
      sql += ` GROUP BY provider_name`;
      return this.db.prepare(sql).get(providerName);
    } else {
      sql += ` GROUP BY provider_name ORDER BY total_tokens DESC`;
      return this.db.prepare(sql).all();
    }
  }

  /**
   * 获取供应商按时间统计
   */
  getProviderStatsByTime(providerName, granularity = 'day', startTime = null, endTime = null) {
    const table = granularity === 'hour' ? 'token_hourly_stats' : 'token_daily_stats';
    const timeField = granularity === 'hour' ? 'hour_timestamp' : 'day_timestamp';

    let sql = `
      SELECT
        ${timeField} as timestamp,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cache_read_tokens) as cache_read_tokens,
        SUM(cache_creation_tokens) as cache_creation_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(request_count) as request_count
      FROM ${table}
      WHERE provider_name = ?
    `;

    const params = [providerName];

    if (startTime) {
      sql += ` AND ${timeField} >= ?`;
      params.push(startTime);
    }
    if (endTime) {
      sql += ` AND ${timeField} <= ?`;
      params.push(endTime);
    }

    sql += ` GROUP BY ${timeField} ORDER BY ${timeField} ASC`;

    return this.db.prepare(sql).all(...params);
  }

  /**
   * 获取会话总体统计
   */
  getSessionStats(sessionId) {
    const sql = `
      SELECT
        session_id,
        provider_name,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        SUM(cache_read_tokens) as total_cache_read,
        SUM(cache_creation_tokens) as total_cache_creation,
        SUM(total_tokens) as total_tokens,
        COUNT(*) as request_count,
        MIN(timestamp) as first_usage,
        MAX(timestamp) as last_usage
      FROM token_usage
      WHERE session_id = ?
      GROUP BY provider_name
    `;

    return this.db.prepare(sql).all(sessionId);
  }

  /**
   * 获取会话汇总统计（不按供应商分组）
   */
  getSessionSummary(sessionId) {
    const sql = `
      SELECT
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        SUM(cache_read_tokens) as total_cache_read,
        SUM(cache_creation_tokens) as total_cache_creation,
        SUM(total_tokens) as total_tokens,
        COUNT(*) as request_count
      FROM token_usage
      WHERE session_id = ?
    `;

    return this.db.prepare(sql).get(sessionId);
  }

  /**
   * 获取会话按时间统计
   */
  getSessionStatsByTime(sessionId, granularity = 'hour', startTime = null, endTime = null) {
    const table = granularity === 'hour' ? 'token_hourly_stats' : 'token_daily_stats';
    const timeField = granularity === 'hour' ? 'hour_timestamp' : 'day_timestamp';

    let sql = `
      SELECT
        ${timeField} as timestamp,
        provider_name,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        total_tokens,
        request_count
      FROM ${table}
      WHERE session_id = ?
    `;

    const params = [sessionId];

    if (startTime) {
      sql += ` AND ${timeField} >= ?`;
      params.push(startTime);
    }
    if (endTime) {
      sql += ` AND ${timeField} <= ?`;
      params.push(endTime);
    }

    sql += ` ORDER BY ${timeField} ASC`;

    return this.db.prepare(sql).all(...params);
  }

  /**
   * 获取模型统计
   */
  getModelStats(providerName = null) {
    let sql = `
      SELECT
        model,
        provider_name,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        SUM(cache_read_tokens) as total_cache_read,
        SUM(cache_creation_tokens) as total_cache_creation,
        SUM(total_tokens) as total_tokens,
        COUNT(*) as request_count
      FROM token_usage
    `;

    if (providerName) {
      sql += ` WHERE provider_name = ?`;
      sql += ` GROUP BY model ORDER BY total_tokens DESC`;
      return this.db.prepare(sql).all(providerName);
    } else {
      sql += ` GROUP BY model, provider_name ORDER BY total_tokens DESC`;
      return this.db.prepare(sql).all();
    }
  }

  /**
   * 获取全局统计摘要
   */
  getGlobalSummary() {
    const sql = `
      SELECT
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        SUM(cache_read_tokens) as total_cache_read,
        SUM(cache_creation_tokens) as total_cache_creation,
        SUM(total_tokens) as total_tokens,
        COUNT(*) as request_count,
        COUNT(DISTINCT provider_name) as provider_count,
        COUNT(DISTINCT model) as model_count,
        COUNT(DISTINCT session_id) as session_count,
        MIN(timestamp) as first_usage,
        MAX(timestamp) as last_usage
      FROM token_usage
    `;

    return this.db.prepare(sql).get();
  }

  /**
   * 获取今日统计
   */
  getTodayStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTimestamp = todayStart.getTime();

    const sql = `
      SELECT
        provider_name,
        model,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        SUM(cache_read_tokens) as total_cache_read,
        SUM(total_tokens) as total_tokens,
        COUNT(*) as request_count
      FROM token_usage
      WHERE timestamp >= ?
      GROUP BY provider_name, model
      ORDER BY total_tokens DESC
    `;

    return this.db.prepare(sql).all(todayTimestamp);
  }

  /**
   * 获取最近 N 天的每日统计
   */
  getRecentDailyStats(days = 7) {
    const startTime = Date.now() - days * 86400000;
    const dayTimestamp = Math.floor(startTime / 86400000) * 86400000;

    const sql = `
      SELECT
        day_timestamp as timestamp,
        provider_name,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cache_read_tokens) as cache_read_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(request_count) as request_count
      FROM token_daily_stats
      WHERE day_timestamp >= ?
      GROUP BY day_timestamp, provider_name
      ORDER BY day_timestamp ASC
    `;

    return this.db.prepare(sql).all(dayTimestamp);
  }

  /**
   * 清理旧数据（保留最近 N 天的详细记录）
   */
  cleanup(keepDays = 30) {
    const cutoffTime = Date.now() - keepDays * 86400000;

    const stmt = this.db.prepare(`DELETE FROM token_usage WHERE timestamp < ?`);
    const result = stmt.run(cutoffTime);

    console.log(`[TokenStats] 清理了 ${result.changes} 条旧记录`);
    return result.changes;
  }

  /**
   * 关闭数据库连接
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// 导出单例
const tokenStatsService = new TokenStatsService();
export default tokenStatsService;
