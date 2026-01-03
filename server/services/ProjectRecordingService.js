/**
 * ProjectRecordingService - 按项目管理终端录制数据
 *
 * 功能：
 * 1. 将录制数据按项目路径组织存储
 * 2. 支持分段录制（一个会话可能涉及多个项目）
 * 3. 追溯绑定（会话开始时未知项目的录制内容）
 * 4. 按项目查询录制历史
 */

import Database from 'better-sqlite3';
import { gzipSync, gunzipSync } from 'zlib';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';

const HOME_DIR = os.homedir();

export class ProjectRecordingService {
  constructor() {
    this.dbPath = path.join(HOME_DIR, '.webtmux', 'db', 'project_recordings.db');
    this._ensureDir();
    this._initDb();
  }

  _ensureDir() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _initDb() {
    this.db = new Database(this.dbPath);

    // 项目表：存储项目元信息
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        ai_type TEXT,
        description TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
    `);

    // 录制片段表：存储按项目分类的录制数据
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recording_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        data BLOB NOT NULL,
        event_count INTEGER NOT NULL,
        cols INTEGER DEFAULT 120,
        rows INTEGER DEFAULT 30,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS idx_segments_project ON recording_segments(project_id, start_time);
      CREATE INDEX IF NOT EXISTS idx_segments_session ON recording_segments(session_id);
    `);

    // 会话项目历史表：记录会话中的项目切换
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_project_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project_path TEXT,
        ai_type TEXT,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        segment_index INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_history_session ON session_project_history(session_id);
    `);

    console.log('[ProjectRecordingService] 数据库初始化完成');
  }

  /**
   * 生成项目 ID（基于路径的哈希）
   */
  _generateProjectId(projectPath) {
    return crypto.createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
  }

  /**
   * 获取或创建项目记录
   */
  getOrCreateProject(projectPath, aiType = null, name = null, description = null) {
    const projectId = this._generateProjectId(projectPath);
    const now = Date.now();

    const existing = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

    if (existing) {
      // 更新最后访问时间和可能的新信息
      const updates = [];
      const params = [];

      if (aiType && aiType !== existing.ai_type) {
        updates.push('ai_type = ?');
        params.push(aiType);
      }
      if (description && description !== existing.description) {
        updates.push('description = ?');
        params.push(description);
      }

      updates.push('updated_at = ?');
      params.push(now);
      params.push(projectId);

      if (updates.length > 1) {
        this.db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }

      return { ...existing, updated_at: now };
    }

    // 创建新项目
    const projectName = name || path.basename(projectPath);
    this.db.prepare(`
      INSERT INTO projects (id, path, name, ai_type, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, projectPath, projectName, aiType, description, now, now);

    return {
      id: projectId,
      path: projectPath,
      name: projectName,
      ai_type: aiType,
      description,
      created_at: now,
      updated_at: now
    };
  }

  /**
   * 记录项目切换事件
   */
  recordProjectSwitch(sessionId, projectPath, aiType, timestamp) {
    const now = timestamp || Date.now();

    // 结束上一个项目片段
    const lastSegment = this.db.prepare(`
      SELECT * FROM session_project_history
      WHERE session_id = ? AND end_time IS NULL
      ORDER BY start_time DESC LIMIT 1
    `).get(sessionId);

    if (lastSegment) {
      this.db.prepare(`
        UPDATE session_project_history SET end_time = ? WHERE id = ?
      `).run(now, lastSegment.id);
    }

    // 计算新片段索引
    const segmentCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM session_project_history WHERE session_id = ?
    `).get(sessionId);
    const segmentIndex = segmentCount?.count || 0;

    // 创建新片段记录
    this.db.prepare(`
      INSERT INTO session_project_history (session_id, project_path, ai_type, start_time, segment_index)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, projectPath, aiType, now, segmentIndex);

    console.log(`[ProjectRecordingService] 项目切换: session=${sessionId}, project=${projectPath}, segment=${segmentIndex}`);

    return { segmentIndex, startTime: now };
  }

  /**
   * 获取会话的项目历史
   */
  getSessionProjectHistory(sessionId) {
    return this.db.prepare(`
      SELECT * FROM session_project_history
      WHERE session_id = ?
      ORDER BY start_time ASC
    `).all(sessionId);
  }

  /**
   * 保存录制片段到项目
   */
  saveRecordingSegment(projectPath, sessionId, events, startTime, endTime, termSize = { cols: 120, rows: 30 }) {
    if (!events || events.length === 0) return null;

    const project = this.getOrCreateProject(projectPath);
    const now = Date.now();

    try {
      const jsonData = JSON.stringify(events);
      const compressed = gzipSync(jsonData);

      const result = this.db.prepare(`
        INSERT INTO recording_segments
        (project_id, session_id, start_time, end_time, data, event_count, cols, rows, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        project.id,
        sessionId,
        startTime,
        endTime,
        compressed,
        events.length,
        termSize.cols,
        termSize.rows,
        now
      );

      console.log(`[ProjectRecordingService] 保存录制片段: project=${project.name}, events=${events.length}`);
      return result.lastInsertRowid;
    } catch (err) {
      console.error('[ProjectRecordingService] 保存录制片段失败:', err);
      return null;
    }
  }

  /**
   * 获取项目的所有录制片段
   */
  getProjectRecordings(projectPath, limit = 50) {
    const projectId = this._generateProjectId(projectPath);

    const segments = this.db.prepare(`
      SELECT * FROM recording_segments
      WHERE project_id = ?
      ORDER BY start_time DESC
      LIMIT ?
    `).all(projectId, limit);

    return segments.map(seg => ({
      id: seg.id,
      sessionId: seg.session_id,
      startTime: seg.start_time,
      endTime: seg.end_time,
      eventCount: seg.event_count,
      cols: seg.cols,
      rows: seg.rows,
      createdAt: seg.created_at
    }));
  }

  /**
   * 获取录制片段的事件数据
   */
  getSegmentEvents(segmentId) {
    const segment = this.db.prepare('SELECT * FROM recording_segments WHERE id = ?').get(segmentId);

    if (!segment) return null;

    try {
      const decompressed = gunzipSync(segment.data).toString('utf-8');
      return JSON.parse(decompressed);
    } catch (err) {
      console.error('[ProjectRecordingService] 解压片段数据失败:', err);
      return null;
    }
  }

  /**
   * 获取所有有录制数据的项目列表
   */
  getProjectsWithRecordings(limit = 20) {
    const projects = this.db.prepare(`
      SELECT p.*,
             COUNT(rs.id) as segment_count,
             SUM(rs.event_count) as total_events,
             MAX(rs.start_time) as last_recording_time
      FROM projects p
      LEFT JOIN recording_segments rs ON p.id = rs.project_id
      GROUP BY p.id
      HAVING segment_count > 0
      ORDER BY last_recording_time DESC
      LIMIT ?
    `).all(limit);

    return projects.map(p => ({
      id: p.id,
      path: p.path,
      name: p.name,
      aiType: p.ai_type,
      description: p.description,
      segmentCount: p.segment_count,
      totalEvents: p.total_events,
      lastRecordingTime: p.last_recording_time,
      createdAt: p.created_at,
      updatedAt: p.updated_at
    }));
  }

  /**
   * 获取项目的录制时间范围
   */
  getProjectTimeRange(projectPath) {
    const projectId = this._generateProjectId(projectPath);

    const result = this.db.prepare(`
      SELECT
        MIN(start_time) as start_time,
        MAX(COALESCE(end_time, start_time)) as end_time,
        cols, rows
      FROM recording_segments
      WHERE project_id = ?
    `).get(projectId);

    if (!result || !result.start_time) {
      return null;
    }

    return {
      startTime: result.start_time,
      endTime: result.end_time,
      cols: result.cols || 120,
      rows: result.rows || 30,
      hasRecordings: true
    };
  }

  /**
   * 获取项目在指定时间范围内的录制事件
   */
  getProjectEvents(projectPath, startTime = 0, endTime = Date.now(), limit = 0) {
    const projectId = this._generateProjectId(projectPath);

    let sql = `
      SELECT start_time, data FROM recording_segments
      WHERE project_id = ? AND start_time >= ? AND start_time <= ?
      ORDER BY start_time ASC
    `;
    if (limit > 0) {
      sql += ` LIMIT ${limit}`;
    }

    const rows = this.db.prepare(sql).all(projectId, startTime, endTime);
    const allEvents = [];

    for (const row of rows) {
      try {
        const decompressed = gunzipSync(row.data).toString('utf-8');
        const events = JSON.parse(decompressed);

        for (const event of events) {
          allEvents.push({
            timestamp: row.start_time + event.t,
            type: event.type,
            data: event.data
          });
        }
      } catch (err) {
        console.error('[ProjectRecordingService] 解压失败:', err);
      }
    }

    allEvents.sort((a, b) => a.timestamp - b.timestamp);
    return allEvents;
  }

  /**
   * 从会话录制数据迁移到项目
   * 用于会话结束时的分拣存储
   */
  migrateSessionRecordings(sessionId, projectHistory, terminalRecorder) {
    if (!projectHistory || projectHistory.length === 0) {
      console.log(`[ProjectRecordingService] 会话 ${sessionId} 无项目历史，跳过迁移`);
      return;
    }

    // 获取会话的所有录制数据
    const timeRange = terminalRecorder.getTimeRange(sessionId);
    if (!timeRange) {
      console.log(`[ProjectRecordingService] 会话 ${sessionId} 无录制数据`);
      return;
    }

    const allEvents = terminalRecorder.getRecordings(sessionId, timeRange.startTime, timeRange.endTime);
    if (allEvents.length === 0) {
      console.log(`[ProjectRecordingService] 会话 ${sessionId} 录制事件为空`);
      return;
    }

    console.log(`[ProjectRecordingService] 开始迁移会话 ${sessionId} 的录制数据，共 ${allEvents.length} 个事件`);

    // 处理追溯绑定：如果第一个片段没有项目，绑定到第二个片段的项目
    if (projectHistory.length > 1 && !projectHistory[0].project_path && projectHistory[1].project_path) {
      projectHistory[0].project_path = projectHistory[1].project_path;
      projectHistory[0].ai_type = projectHistory[1].ai_type;
      console.log(`[ProjectRecordingService] 追溯绑定: 片段0 -> ${projectHistory[1].project_path}`);
    }

    // 按项目片段分拣事件
    for (let i = 0; i < projectHistory.length; i++) {
      const segment = projectHistory[i];

      if (!segment.project_path) {
        console.log(`[ProjectRecordingService] 片段 ${i} 无项目路径，跳过`);
        continue;
      }

      const segmentStart = segment.start_time;
      const segmentEnd = segment.end_time || Date.now();

      // 筛选属于这个片段的事件
      const segmentEvents = allEvents.filter(e =>
        e.timestamp >= segmentStart && e.timestamp < segmentEnd
      );

      if (segmentEvents.length === 0) {
        console.log(`[ProjectRecordingService] 片段 ${i} (${segment.project_path}) 无事件`);
        continue;
      }

      // 转换为相对时间格式
      const relativeEvents = segmentEvents.map(e => ({
        t: e.timestamp - segmentStart,
        type: e.type,
        data: e.data
      }));

      // 保存到项目
      this.saveRecordingSegment(
        segment.project_path,
        sessionId,
        relativeEvents,
        segmentStart,
        segmentEnd,
        { cols: timeRange.cols, rows: timeRange.rows }
      );

      // 确保项目记录存在
      this.getOrCreateProject(segment.project_path, segment.ai_type);
    }

    console.log(`[ProjectRecordingService] 会话 ${sessionId} 录制数据迁移完成`);
  }

  /**
   * 清理旧录制数据
   */
  cleanOldRecordings(daysToKeep = 30) {
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

    const result = this.db.prepare(`
      DELETE FROM recording_segments WHERE start_time < ?
    `).run(cutoff);

    if (result.changes > 0) {
      console.log(`[ProjectRecordingService] 已清理 ${result.changes} 条旧录制数据`);
    }

    // 清理没有录制数据的项目
    this.db.prepare(`
      DELETE FROM projects WHERE id NOT IN (
        SELECT DISTINCT project_id FROM recording_segments
      )
    `).run();

    return result.changes;
  }

  /**
   * 删除项目的所有录制
   */
  deleteProjectRecordings(projectPath) {
    const projectId = this._generateProjectId(projectPath);

    const result = this.db.prepare('DELETE FROM recording_segments WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

    return result.changes;
  }

  /**
   * 获取存储统计
   */
  getStats() {
    const stats = this.db.prepare(`
      SELECT
        COUNT(DISTINCT project_id) as project_count,
        COUNT(*) as segment_count,
        SUM(event_count) as total_events,
        SUM(LENGTH(data)) as total_size
      FROM recording_segments
    `).get();

    return {
      projectCount: stats?.project_count || 0,
      segmentCount: stats?.segment_count || 0,
      totalEvents: stats?.total_events || 0,
      totalSize: stats?.total_size || 0
    };
  }

  /**
   * 关闭服务
   */
  close() {
    this.db.close();
  }
}

// 单例
let instance = null;

export function getProjectRecordingService() {
  if (!instance) {
    instance = new ProjectRecordingService();
  }
  return instance;
}

export default ProjectRecordingService;
