import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * AI 监控预约管理服务
 * 支持每天、每周、指定周几、单次预约
 */
class ScheduleManager {
  constructor() {
    const configDir = path.join(os.homedir(), '.webtmux', 'db');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const dbPath = path.join(configDir, 'webtmux.db');
    this.db = new Database(dbPath);
    this.initDatabase();
    this.checkInterval = null;
    this.callbacks = {
      onScheduleTrigger: null
    };
  }

  /**
   * 初始化数据库表
   */
  initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        type TEXT NOT NULL,
        action TEXT NOT NULL,
        time TEXT NOT NULL,
        weekdays TEXT,
        date TEXT,
        enabled INTEGER DEFAULT 1,
        createdAt INTEGER NOT NULL,
        nextRun INTEGER,
        FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // 创建索引
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_schedules_session ON schedules(sessionId);
      CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
      CREATE INDEX IF NOT EXISTS idx_schedules_nextRun ON schedules(nextRun);
    `);
  }

  /**
   * 生成唯一ID
   */
  generateId() {
    return `schedule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 计算下次执行时间
   * @param {Object} schedule - 预约配置
   * @returns {number} - 时间戳（毫秒）
   */
  calculateNextRun(schedule) {
    const now = new Date();
    const [hours, minutes] = schedule.time.split(':').map(Number);

    let nextRun = new Date(now);
    nextRun.setHours(hours, minutes, 0, 0);

    switch (schedule.type) {
      case 'daily':
        // 每天重复：如果今天的时间已过，设置为明天
        if (nextRun <= now) {
          nextRun.setDate(nextRun.getDate() + 1);
        }
        break;

      case 'weekly':
        // 每周重复：固定在周一
        const daysUntilMonday = (8 - nextRun.getDay()) % 7 || 7;
        nextRun.setDate(nextRun.getDate() + daysUntilMonday);
        if (nextRun <= now) {
          nextRun.setDate(nextRun.getDate() + 7);
        }
        break;

      case 'weekdays':
        // 指定周几：找到下一个匹配的工作日
        const targetDays = JSON.parse(schedule.weekdays || '[]');
        if (targetDays.length === 0) return null;

        let daysToAdd = 0;
        let found = false;

        for (let i = 0; i < 8; i++) { // 最多检查8天
          const checkDate = new Date(nextRun);
          checkDate.setDate(checkDate.getDate() + i);
          const dayOfWeek = checkDate.getDay();

          if (targetDays.includes(dayOfWeek)) {
            if (checkDate > now) {
              daysToAdd = i;
              found = true;
              break;
            }
          }
        }

        if (!found) return null;
        nextRun.setDate(nextRun.getDate() + daysToAdd);
        break;

      case 'once':
        // 单次预约：使用指定的日期
        if (!schedule.date) return null;
        nextRun = new Date(`${schedule.date} ${schedule.time}`);
        if (nextRun <= now) return null; // 已过期
        break;

      default:
        return null;
    }

    return nextRun.getTime();
  }

  /**
   * 创建预约
   * @param {Object} schedule - 预约配置
   * @returns {Object} - 创建的预约
   */
  createSchedule(schedule) {
    const id = this.generateId();
    const now = Date.now();
    const nextRun = this.calculateNextRun(schedule);

    if (nextRun === null) {
      throw new Error('无法计算下次执行时间');
    }

    const stmt = this.db.prepare(`
      INSERT INTO schedules (id, sessionId, type, action, time, weekdays, date, enabled, createdAt, nextRun)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      schedule.sessionId,
      schedule.type,
      schedule.action,
      schedule.time,
      schedule.weekdays ? JSON.stringify(schedule.weekdays) : null,
      schedule.date || null,
      schedule.enabled !== false ? 1 : 0,
      now,
      nextRun
    );

    return this.getSchedule(id);
  }

  /**
   * 获取预约详情
   * @param {string} id - 预约ID
   * @returns {Object|null}
   */
  getSchedule(id) {
    const stmt = this.db.prepare('SELECT * FROM schedules WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return null;

    return {
      ...row,
      enabled: Boolean(row.enabled),
      weekdays: row.weekdays ? JSON.parse(row.weekdays) : null
    };
  }

  /**
   * 获取会话的所有预约
   * @param {string} sessionId - 会话ID
   * @returns {Array}
   */
  getSessionSchedules(sessionId) {
    const stmt = this.db.prepare('SELECT * FROM schedules WHERE sessionId = ? ORDER BY nextRun ASC');
    const rows = stmt.all(sessionId);

    return rows.map(row => ({
      ...row,
      enabled: Boolean(row.enabled),
      weekdays: row.weekdays ? JSON.parse(row.weekdays) : null
    }));
  }

  /**
   * 获取所有预约
   * @returns {Array}
   */
  getAllSchedules() {
    const stmt = this.db.prepare('SELECT * FROM schedules ORDER BY nextRun ASC');
    const rows = stmt.all();

    return rows.map(row => ({
      ...row,
      enabled: Boolean(row.enabled),
      weekdays: row.weekdays ? JSON.parse(row.weekdays) : null
    }));
  }

  /**
   * 更新预约
   * @param {string} id - 预约ID
   * @param {Object} updates - 更新的字段
   * @returns {Object|null}
   */
  updateSchedule(id, updates) {
    const schedule = this.getSchedule(id);
    if (!schedule) return null;

    const updatedSchedule = { ...schedule, ...updates };
    const nextRun = this.calculateNextRun(updatedSchedule);

    if (nextRun === null && updates.enabled !== false) {
      throw new Error('无法计算下次执行时间');
    }

    const stmt = this.db.prepare(`
      UPDATE schedules
      SET type = ?, action = ?, time = ?, weekdays = ?, date = ?, enabled = ?, nextRun = ?
      WHERE id = ?
    `);

    stmt.run(
      updates.type || schedule.type,
      updates.action || schedule.action,
      updates.time || schedule.time,
      updates.weekdays ? JSON.stringify(updates.weekdays) : schedule.weekdays,
      updates.date !== undefined ? updates.date : schedule.date,
      updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : schedule.enabled,
      nextRun,
      id
    );

    return this.getSchedule(id);
  }

  /**
   * 删除预约
   * @param {string} id - 预约ID
   * @returns {boolean}
   */
  deleteSchedule(id) {
    const stmt = this.db.prepare('DELETE FROM schedules WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * 删除会话的所有预约
   * @param {string} sessionId - 会话ID
   * @returns {number} - 删除的数量
   */
  deleteSessionSchedules(sessionId) {
    const stmt = this.db.prepare('DELETE FROM schedules WHERE sessionId = ?');
    const result = stmt.run(sessionId);
    return result.changes;
  }

  /**
   * 启用/禁用预约
   * @param {string} id - 预约ID
   * @param {boolean} enabled - 是否启用
   * @returns {Object|null}
   */
  toggleSchedule(id, enabled) {
    return this.updateSchedule(id, { enabled });
  }

  /**
   * 检查并执行到期的预约
   */
  checkSchedules() {
    const now = Date.now();
    const stmt = this.db.prepare(`
      SELECT * FROM schedules
      WHERE enabled = 1 AND nextRun <= ?
      ORDER BY nextRun ASC
    `);

    const dueSchedules = stmt.all(now);

    for (const schedule of dueSchedules) {
      try {
        // 触发回调
        if (this.callbacks.onScheduleTrigger) {
          this.callbacks.onScheduleTrigger({
            ...schedule,
            enabled: Boolean(schedule.enabled),
            weekdays: schedule.weekdays ? JSON.parse(schedule.weekdays) : null
          });
        }

        // 更新下次执行时间（单次预约除外）
        if (schedule.type === 'once') {
          // 单次预约执行后禁用
          this.updateSchedule(schedule.id, { enabled: false, nextRun: null });
        } else {
          // 重复预约更新下次执行时间
          const nextRun = this.calculateNextRun({
            ...schedule,
            weekdays: schedule.weekdays ? JSON.parse(schedule.weekdays) : null
          });

          if (nextRun) {
            const updateStmt = this.db.prepare('UPDATE schedules SET nextRun = ? WHERE id = ?');
            updateStmt.run(nextRun, schedule.id);
          } else {
            // 无法计算下次执行时间，禁用预约
            this.updateSchedule(schedule.id, { enabled: false });
          }
        }
      } catch (error) {
        console.error(`执行预约失败 [${schedule.id}]:`, error);
      }
    }
  }

  /**
   * 启动定时检查
   * @param {number} interval - 检查间隔（毫秒），默认30秒
   */
  startScheduler(interval = 30000) {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(() => {
      this.checkSchedules();
    }, interval);

    // 立即执行一次
    this.checkSchedules();
  }

  /**
   * 停止定时检查
   */
  stopScheduler() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * 注册预约触发回调
   * @param {Function} callback - 回调函数
   */
  onScheduleTrigger(callback) {
    this.callbacks.onScheduleTrigger = callback;
  }

  /**
   * 关闭数据库
   */
  close() {
    this.stopScheduler();
    if (this.db) {
      this.db.close();
    }
  }
}

export default ScheduleManager;
