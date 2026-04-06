/**
 * CrashReporter - 崩溃/错误日志上报
 *
 * 采集内容：
 *  - 错误类型、消息、堆栈
 *  - 设备匿名ID、应用版本、平台
 *  - 最近 50 行应用日志（辅助定位）
 *
 * 不采集：命令内容、文件路径、用户名等隐私数据
 */

import crypto from 'crypto';
import os from 'os';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRASH_URL = 'https://term.whaty.org/api/crash-report';

class CrashReporter {
  constructor() {
    this._version = 'unknown';
    this._logDir = null;
    this._recentErrors = [];
    this._maxQueue = 10;      // 单次会话最多上报 10 次
    this._reportCount = 0;
    this._debounceMap = {};   // 去重：相同错误 5 分钟内只报一次
    this._initVersion();
  }

  _initVersion() {
    try {
      const pkg = join(__dirname, '../../package.json');
      this._version = JSON.parse(readFileSync(pkg, 'utf8')).version;
    } catch {}
  }

  _getDeviceId() {
    const interfaces = os.networkInterfaces();
    const cpus = os.cpus();
    let raw = cpus[0]?.model || '';
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (!iface.internal && iface.mac !== '00:00:00:00:00:00') {
          raw += iface.mac;
          break;
        }
      }
    }
    return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
  }

  /** 设置日志目录，由 Electron 主进程传入 */
  setLogDir(dir) {
    this._logDir = dir;
  }

  /** 读取最近的日志尾部（最多 50 行） */
  _getRecentLogs() {
    if (!this._logDir || !existsSync(this._logDir)) return '';
    try {
      const files = readdirSync(this._logDir)
        .filter(f => f.startsWith('whatyterm-') && f.endsWith('.log'))
        .sort()
        .reverse();
      if (files.length === 0) return '';
      const content = readFileSync(join(this._logDir, files[0]), 'utf8');
      const lines = content.split('\n');
      return lines.slice(-50).join('\n');
    } catch {
      return '';
    }
  }

  /** 脱敏：去除路径中的用户名 */
  _sanitize(text) {
    if (!text) return '';
    return text
      .replace(/\/Users\/[^/]+/g, '/Users/***')
      .replace(/C:\\Users\\[^\\]+/g, 'C:\\Users\\***')
      .replace(/\/home\/[^/]+/g, '/home/***');
  }

  /**
   * 上报错误
   * @param {string} type - 错误类型: uncaughtException | unhandledRejection | renderCrash | serverError
   * @param {Error|string} error - 错误对象或消息
   * @param {object} extra - 附加信息
   */
  async report(type, error, extra = {}) {
    if (this._reportCount >= this._maxQueue) return;

    const message = error?.message || String(error);
    const stack = this._sanitize(error?.stack || '');

    // 去重：相同错误消息 5 分钟内只报一次
    const key = type + ':' + message.substring(0, 100);
    const now = Date.now();
    if (this._debounceMap[key] && now - this._debounceMap[key] < 300000) return;
    this._debounceMap[key] = now;
    this._reportCount++;

    const payload = {
      deviceId: this._getDeviceId(),
      appVersion: this._version,
      platform: os.platform(),
      arch: os.arch(),
      osVersion: os.release(),
      type,
      message: message.substring(0, 500),
      stack: stack.substring(0, 3000),
      recentLogs: this._sanitize(this._getRecentLogs()).substring(0, 5000),
      extra: JSON.stringify(extra).substring(0, 1000),
      timestamp: now,
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      await fetch(CRASH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch {
      // 静默失败
    }
  }
}

export default new CrashReporter();
