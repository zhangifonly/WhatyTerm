/**
 * 终端录制服务
 * 记录所有终端输入输出事件，支持压缩存储和回放
 */

import Database from 'better-sqlite3';
import { gzipSync, gunzipSync } from 'zlib';
import path from 'path';
import os from 'os';
import fs from 'fs';

export class TerminalRecorder {
  constructor() {
    this.dbPath = path.join(os.homedir(), '.webtmux', 'db', 'recordings.db');
    this._ensureDir();
    this._initDb();

    // 内存缓冲区：每个会话的事件队列
    this.buffers = new Map(); // sessionId -> { events: [], baseTime: number }

    // 定时刷新到数据库（每5秒）
    this.flushInterval = setInterval(() => this._flushAll(), 5000);
  }

  _ensureDir() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _initDb() {
    this.db = new Database(this.dbPath);

    // 创建录制表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recordings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        base_time INTEGER NOT NULL,
        data BLOB NOT NULL,
        event_count INTEGER NOT NULL,
        cols INTEGER DEFAULT 120,
        rows INTEGER DEFAULT 30,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_recordings_session_time
        ON recordings(session_id, base_time);
    `);

    // 添加尺寸字段（如果不存在）
    try {
      this.db.exec(`ALTER TABLE recordings ADD COLUMN cols INTEGER DEFAULT 120`);
    } catch (e) { /* 字段已存在 */ }
    try {
      this.db.exec(`ALTER TABLE recordings ADD COLUMN rows INTEGER DEFAULT 30`);
    } catch (e) { /* 字段已存在 */ }

    // 创建会话信息表（保存项目名称等）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_info (
        session_id TEXT PRIMARY KEY,
        project_name TEXT,
        project_dir TEXT,
        project_desc TEXT,
        name TEXT,
        updated_at INTEGER
      )
    `);

    console.log('[TerminalRecorder] 数据库初始化完成');
  }

  /**
   * 记录输出事件
   */
  recordOutput(sessionId, data, termSize = null) {
    this._addEvent(sessionId, 'o', data, termSize);
  }

  /**
   * 记录输入事件
   */
  recordInput(sessionId, data) {
    this._addEvent(sessionId, 'i', data);
  }

  /**
   * 记录终端尺寸变化
   */
  recordResize(sessionId, cols, rows) {
    this._addEvent(sessionId, 'r', { cols, rows });
  }

  /**
   * 添加事件到缓冲区
   */
  _addEvent(sessionId, type, data, termSize = null) {
    if (!data || (typeof data === 'string' && data.length === 0)) return;

    const now = Date.now();

    if (!this.buffers.has(sessionId)) {
      this.buffers.set(sessionId, {
        events: [],
        baseTime: now,
        termSize: termSize || { cols: 120, rows: 30 }
      });
    }

    const buffer = this.buffers.get(sessionId);
    const relativeTime = now - buffer.baseTime;

    // 更新终端尺寸
    if (termSize) {
      buffer.termSize = termSize;
    }

    buffer.events.push({
      t: relativeTime,
      type,
      data: typeof data === 'string' ? data : (typeof data === 'object' ? data : data.toString('utf-8'))
    });

    // 如果缓冲区过大，立即刷新
    if (buffer.events.length >= 100) {
      this._flushSession(sessionId);
    }
  }

  /**
   * 刷新所有会话的缓冲区
   */
  _flushAll() {
    for (const sessionId of this.buffers.keys()) {
      this._flushSession(sessionId);
    }
  }

  /**
   * 刷新单个会话的缓冲区到数据库
   */
  _flushSession(sessionId) {
    const buffer = this.buffers.get(sessionId);
    if (!buffer || buffer.events.length === 0) return;

    try {
      // 压缩事件数据
      const jsonData = JSON.stringify(buffer.events);
      const compressed = gzipSync(jsonData);

      // 存入数据库（包含终端尺寸）
      const stmt = this.db.prepare(`
        INSERT INTO recordings (session_id, base_time, data, event_count, cols, rows)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const termSize = buffer.termSize || { cols: 120, rows: 30 };
      stmt.run(sessionId, buffer.baseTime, compressed, buffer.events.length, termSize.cols, termSize.rows);

      // 重置缓冲区（保留终端尺寸）
      this.buffers.set(sessionId, {
        events: [],
        baseTime: Date.now(),
        termSize: buffer.termSize
      });
    } catch (err) {
      console.error('[TerminalRecorder] 刷新失败:', err);
    }
  }

  /**
   * 获取会话的录制时间范围和终端尺寸
   */
  getTimeRange(sessionId) {
    const stmt = this.db.prepare(`
      SELECT MIN(base_time) as start_time, MAX(base_time) as end_time,
             cols, rows
      FROM recordings WHERE session_id = ?
    `);
    const row = stmt.get(sessionId);

    if (!row || !row.start_time) {
      return null;
    }

    return {
      startTime: row.start_time,
      endTime: row.end_time || row.start_time,
      cols: row.cols || 120,
      rows: row.rows || 30
    };
  }

  /**
   * 获取指定时间范围的录制数据
   * @param {number} limit - 限制返回的数据块数量，0表示不限制
   */
  getRecordings(sessionId, startTime = 0, endTime = Date.now(), limit = 0) {
    let sql = `
      SELECT base_time, data FROM recordings
      WHERE session_id = ? AND base_time >= ? AND base_time <= ?
      ORDER BY base_time ASC
    `;
    if (limit > 0) {
      sql += ` LIMIT ${limit}`;
    }
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(sessionId, startTime, endTime);

    // 解压并合并所有事件
    const allEvents = [];

    for (const row of rows) {
      try {
        const decompressed = gunzipSync(row.data).toString('utf-8');
        const events = JSON.parse(decompressed);

        // 转换为绝对时间
        for (const event of events) {
          allEvents.push({
            timestamp: row.base_time + event.t,
            type: event.type,
            data: event.data
          });
        }
      } catch (err) {
        console.error('[TerminalRecorder] 解压失败:', err);
      }
    }

    // 按时间排序
    allEvents.sort((a, b) => a.timestamp - b.timestamp);

    return allEvents;
  }

  /**
   * 获取录制数据块数量
   */
  getRecordingChunkCount(sessionId, startTime = 0, endTime = Date.now()) {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM recordings
      WHERE session_id = ? AND base_time >= ? AND base_time <= ?
    `);
    const row = stmt.get(sessionId, startTime, endTime);
    return row?.count || 0;
  }

  /**
   * 清理旧录制数据
   */
  cleanOldRecordings(hoursToKeep = 24) {
    const cutoff = Date.now() - hoursToKeep * 60 * 60 * 1000;
    const stmt = this.db.prepare(`
      DELETE FROM recordings WHERE base_time < ?
    `);
    const result = stmt.run(cutoff);

    if (result.changes > 0) {
      console.log(`[TerminalRecorder] 已清理 ${result.changes} 条旧录制数据`);
    }

    return result.changes;
  }

  /**
   * 删除会话的所有录制
   */
  deleteSession(sessionId) {
    this.buffers.delete(sessionId);
    const stmt = this.db.prepare(`DELETE FROM recordings WHERE session_id = ?`);
    return stmt.run(sessionId).changes;
  }

  /**
   * 获取存储统计
   */
  getStats() {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total_records,
        SUM(event_count) as total_events,
        SUM(LENGTH(data)) as total_size,
        MIN(base_time) as oldest_time
      FROM recordings
    `);
    const row = stmt.get();
    return {
      totalRecords: row?.total_records || 0,
      totalEvents: row?.total_events || 0,
      totalSize: row?.total_size || 0,
      oldestTime: row?.oldest_time || null
    };
  }

  /**
   * 获取按会话分组的统计
   */
  getStatsBySession() {
    const stmt = this.db.prepare(`
      SELECT
        session_id,
        COUNT(*) as records,
        SUM(event_count) as events,
        SUM(LENGTH(data)) as size,
        MIN(base_time) as start_time,
        MAX(base_time) as end_time
      FROM recordings
      GROUP BY session_id
      ORDER BY end_time DESC
    `);
    return stmt.all().map(row => ({
      sessionId: row.session_id,
      records: row.records,
      events: row.events,
      size: row.size,
      startTime: row.start_time,
      endTime: row.end_time
    }));
  }

  /**
   * 保存会话项目信息
   */
  saveSessionInfo(sessionId, info) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO session_info
      (session_id, project_name, project_dir, project_desc, name, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      sessionId,
      info.projectName || null,
      info.projectDir || null,
      info.projectDesc || null,
      info.name || null,
      Date.now()
    );
  }

  /**
   * 获取会话项目信息
   */
  getSessionInfo(sessionId) {
    const stmt = this.db.prepare(`SELECT * FROM session_info WHERE session_id = ?`);
    return stmt.get(sessionId);
  }

  /**
   * 获取所有会话项目信息
   */
  getAllSessionInfo() {
    const stmt = this.db.prepare(`SELECT * FROM session_info`);
    const rows = stmt.all();
    const map = {};
    rows.forEach(r => {
      map[r.session_id] = {
        projectName: r.project_name,
        projectDir: r.project_dir,
        projectDesc: r.project_desc,
        name: r.name
      };
    });
    return map;
  }

  /**
   * 导出所有录制数据
   */
  exportAll() {
    const stmt = this.db.prepare(`SELECT session_id, base_time, data FROM recordings ORDER BY base_time`);
    const rows = stmt.all();
    const result = [];
    for (const row of rows) {
      try {
        const decompressed = gunzipSync(row.data).toString('utf-8');
        result.push({
          sessionId: row.session_id,
          baseTime: row.base_time,
          events: JSON.parse(decompressed)
        });
      } catch (e) { /* skip */ }
    }
    return result;
  }

  /**
   * 关闭服务
   */
  close() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    this._flushAll();
    this.db.close();
  }
}

// 单例
let instance = null;

export function getTerminalRecorder() {
  if (!instance) {
    instance = new TerminalRecorder();
  }
  return instance;
}

export default TerminalRecorder;
