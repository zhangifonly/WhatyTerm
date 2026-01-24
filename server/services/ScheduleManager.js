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
    console.log(`[ScheduleManager] 数据库路径: ${dbPath}`);
    this.db = new Database(dbPath);
    console.log(`[ScheduleManager] 数据库已打开`);
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
    // 检查是否需要迁移（添加 projectPath 字段）
    const tableInfo = this.db.prepare("PRAGMA table_info(schedules)").all();
    const hasProjectPath = tableInfo.some(col => col.name === 'projectPath');

    if (!hasProjectPath && tableInfo.length > 0) {
      // 表存在但没有 projectPath 字段，需要迁移
      console.log('[ScheduleManager] 迁移数据库：添加 projectPath 字段');
      this.db.exec(`ALTER TABLE schedules ADD COLUMN projectPath TEXT`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        sessionId TEXT,
        projectPath TEXT,
        type TEXT NOT NULL,
        action TEXT NOT NULL,
        time TEXT NOT NULL,
        weekdays TEXT,
        date TEXT,
        enabled INTEGER DEFAULT 1,
        createdAt INTEGER NOT NULL,
        nextRun INTEGER
      )
    `);

    // 创建索引
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_schedules_session ON schedules(sessionId);
      CREATE INDEX IF NOT EXISTS idx_schedules_project ON schedules(projectPath);
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
        // weekdays 可能是数组或 JSON 字符串
        const targetDays = Array.isArray(schedule.weekdays)
          ? schedule.weekdays
          : JSON.parse(schedule.weekdays || '[]');
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

    console.log(`[ScheduleManager] 创建预约: id=${id}, projectPath=${schedule.projectPath}, nextRun=${nextRun}`);

    if (nextRun === null) {
      throw new Error('无法计算下次执行时间');
    }

    const stmt = this.db.prepare(`
      INSERT INTO schedules (id, sessionId, projectPath, type, action, time, weekdays, date, enabled, createdAt, nextRun)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      id,
      schedule.sessionId || null,
      schedule.projectPath || null,
      schedule.type,
      schedule.action,
      schedule.time,
      schedule.weekdays ? JSON.stringify(schedule.weekdays) : null,
      schedule.date || null,
      schedule.enabled !== false ? 1 : 0,
      now,
      nextRun
    );

    console.log(`[ScheduleManager] 插入结果: changes=${result.changes}, lastInsertRowid=${result.lastInsertRowid}`);

    const created = this.getSchedule(id);
    console.log(`[ScheduleManager] 查询创建的预约: ${created ? 'found' : 'not found'}`);

    return created;
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
      weekdays: row.weekdays ? JSON.parse(row.weekdays) : null,
      projectPath: row.projectPath || null
    };
  }

  /**
   * 获取会话的所有预约（兼容旧版）
   * @param {string} sessionId - 会话ID
   * @returns {Array}
   */
  getSessionSchedules(sessionId) {
    const stmt = this.db.prepare('SELECT * FROM schedules WHERE sessionId = ? ORDER BY nextRun ASC');
    const rows = stmt.all(sessionId);

    return rows.map(row => ({
      ...row,
      enabled: Boolean(row.enabled),
      weekdays: row.weekdays ? JSON.parse(row.weekdays) : null,
      projectPath: row.projectPath || null
    }));
  }

  /**
   * 获取项目的所有预约
   * @param {string} projectPath - 项目路径
   * @returns {Array}
   */
  getProjectSchedules(projectPath) {
    const stmt = this.db.prepare('SELECT * FROM schedules WHERE projectPath = ? ORDER BY nextRun ASC');
    const rows = stmt.all(projectPath);

    return rows.map(row => ({
      ...row,
      enabled: Boolean(row.enabled),
      weekdays: row.weekdays ? JSON.parse(row.weekdays) : null,
      projectPath: row.projectPath || null
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
      weekdays: row.weekdays ? JSON.parse(row.weekdays) : null,
      projectPath: row.projectPath || null
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

    // 确保 enabled 字段是整数（SQLite 不接受布尔值）
    let enabledValue;
    if (updates.enabled !== undefined) {
      enabledValue = updates.enabled ? 1 : 0;
    } else {
      // schedule.enabled 可能是布尔值（从 getSchedule 返回），需要转换
      enabledValue = schedule.enabled ? 1 : 0;
    }

    stmt.run(
      updates.type || schedule.type,
      updates.action || schedule.action,
      updates.time || schedule.time,
      updates.weekdays ? JSON.stringify(updates.weekdays) : schedule.weekdays,
      updates.date !== undefined ? updates.date : schedule.date,
      enabledValue,
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
   * 删除项目的所有预约
   * @param {string} projectPath - 项目路径
   * @returns {number} - 删除的数量
   */
  deleteProjectSchedules(projectPath) {
    const stmt = this.db.prepare('DELETE FROM schedules WHERE projectPath = ?');
    const result = stmt.run(projectPath);
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
    console.log(`[ScheduleManager] 检查预约, 当前时间: ${now} (${new Date(now).toLocaleString()})`);

    const stmt = this.db.prepare(`
      SELECT * FROM schedules
      WHERE enabled = 1 AND nextRun <= ?
      ORDER BY nextRun ASC
    `);

    const dueSchedules = stmt.all(now);
    console.log(`[ScheduleManager] 找到 ${dueSchedules.length} 个到期预约`);

    if (dueSchedules.length > 0) {
      console.log(`[ScheduleManager] 到期预约详情:`, dueSchedules.map(s => ({
        id: s.id,
        sessionId: s.sessionId,
        action: s.action,
        nextRun: s.nextRun,
        nextRunTime: new Date(s.nextRun).toLocaleString()
      })));
    }

    for (const schedule of dueSchedules) {
      try {
        console.log(`[ScheduleManager] 执行预约 ${schedule.id}, 动作: ${schedule.action}, 会话: ${schedule.sessionId}`);

        // 触发回调
        if (this.callbacks.onScheduleTrigger) {
          console.log(`[ScheduleManager] 触发回调 onScheduleTrigger`);
          this.callbacks.onScheduleTrigger({
            ...schedule,
            enabled: Boolean(schedule.enabled),
            weekdays: schedule.weekdays ? JSON.parse(schedule.weekdays) : null
          });
        } else {
          console.log(`[ScheduleManager] 警告: 没有注册 onScheduleTrigger 回调!`);
        }

        // 更新下次执行时间（单次预约除外）
        if (schedule.type === 'once') {
          // 单次预约执行后禁用
          console.log(`[ScheduleManager] 单次预约执行完成，禁用预约 ${schedule.id}`);
          this.updateSchedule(schedule.id, { enabled: false, nextRun: null });
        } else {
          // 重复预约更新下次执行时间
          const nextRun = this.calculateNextRun({
            ...schedule,
            weekdays: schedule.weekdays ? JSON.parse(schedule.weekdays) : null
          });

          if (nextRun) {
            console.log(`[ScheduleManager] 更新预约 ${schedule.id} 下次执行时间: ${nextRun} (${new Date(nextRun).toLocaleString()})`);
            const updateStmt = this.db.prepare('UPDATE schedules SET nextRun = ? WHERE id = ?');
            updateStmt.run(nextRun, schedule.id);
          } else {
            // 无法计算下次执行时间，禁用预约
            console.log(`[ScheduleManager] 无法计算下次执行时间，禁用预约 ${schedule.id}`);
            this.updateSchedule(schedule.id, { enabled: false });
          }
        }
      } catch (error) {
        console.error(`[ScheduleManager] 执行预约失败 [${schedule.id}]:`, error);
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
