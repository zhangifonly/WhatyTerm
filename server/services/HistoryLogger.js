import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class HistoryLogger {
  constructor() {
    const dbPath = join(__dirname, '../db/webtmux.db');
    this.db = new Database(dbPath);
    this._initTables();
  }

  _initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        ai_generated INTEGER DEFAULT 0,
        ai_reasoning TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_history_session ON history(session_id);
      CREATE INDEX IF NOT EXISTS idx_history_created ON history(created_at);

      CREATE TABLE IF NOT EXISTS sessions_meta (
        id TEXT PRIMARY KEY,
        name TEXT,
        goal TEXT,
        system_prompt TEXT,
        share_token TEXT,
        is_public INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  log(sessionId, entry) {
    const stmt = this.db.prepare(`
      INSERT INTO history (id, session_id, type, content, ai_generated, ai_reasoning)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      uuidv4(),
      sessionId,
      entry.type,
      entry.content,
      entry.aiGenerated ? 1 : 0,
      entry.aiReasoning || null
    );
  }

  getHistory(sessionId, limit = 100, offset = 0) {
    const stmt = this.db.prepare(`
      SELECT * FROM history
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(sessionId, limit, offset);

    return rows.reverse().map(row => ({
      id: row.id,
      sessionId: row.session_id,
      type: row.type,
      content: row.content,
      aiGenerated: !!row.ai_generated,
      aiReasoning: row.ai_reasoning,
      createdAt: row.created_at
    }));
  }

  searchHistory(sessionId, query, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM history
      WHERE session_id = ? AND content LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    return stmt.all(sessionId, `%${query}%`, limit);
  }

  getHistoryByType(sessionId, type, limit = 100) {
    const stmt = this.db.prepare(`
      SELECT * FROM history
      WHERE session_id = ? AND type = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    return stmt.all(sessionId, type, limit);
  }

  // 获取所有会话的 AI 操作日志
  getAllAiLogs(limit = 500) {
    const stmt = this.db.prepare(`
      SELECT * FROM history
      WHERE type = 'ai_decision'
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(limit);
    return rows.reverse().map(row => ({
      id: row.id,
      sessionId: row.session_id,
      type: row.type,
      content: row.content,
      aiGenerated: !!row.ai_generated,
      aiReasoning: row.ai_reasoning,
      createdAt: row.created_at
    }));
  }

  createShareToken(sessionId) {
    const token = uuidv4();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions_meta (id, share_token, is_public, updated_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    `);
    stmt.run(sessionId, token);
    return token;
  }

  getSessionByShareToken(token) {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions_meta WHERE share_token = ? AND is_public = 1
    `);
    return stmt.get(token);
  }

  clearHistory(sessionId) {
    const stmt = this.db.prepare(`DELETE FROM history WHERE session_id = ?`);
    stmt.run(sessionId);
  }

  // 清理超过指定天数的旧历史记录
  cleanOldHistory(daysToKeep = 7) {
    const stmt = this.db.prepare(`
      DELETE FROM history
      WHERE datetime(created_at) < datetime('now', '-' || ? || ' days')
    `);
    const result = stmt.run(daysToKeep);
    return result.changes;
  }

  // 清理超过指定天数的输出记录（output 类型）
  // output 记录量大，需要更频繁地清理
  cleanOldOutputs(daysToKeep = 1) {
    const stmt = this.db.prepare(`
      DELETE FROM history
      WHERE type = 'output'
      AND datetime(created_at) < datetime('now', '-' || ? || ' days')
    `);
    const result = stmt.run(daysToKeep);
    return result.changes;
  }

  // 优化数据库（清理碎片、更新统计信息）
  optimizeDatabase() {
    console.log('[HistoryLogger] 开始优化数据库...');
    const startTime = Date.now();

    // VACUUM 会重建整个数据库，删除碎片
    this.db.exec('VACUUM');

    // ANALYZE 更新统计信息，提升查询性能
    this.db.exec('ANALYZE');

    const elapsed = Date.now() - startTime;
    console.log(`[HistoryLogger] 数据库优化完成，耗时: ${elapsed}ms`);
  }

  // 获取数据库统计信息
  getStats() {
    const totalRecords = this.db.prepare('SELECT COUNT(*) as count FROM history').get().count;
    const oldRecords = this.db.prepare(`
      SELECT COUNT(*) as count FROM history
      WHERE datetime(created_at) < datetime('now', '-7 days')
    `).get().count;

    return {
      totalRecords,
      oldRecords,
      activeRecords: totalRecords - oldRecords
    };
  }
}
