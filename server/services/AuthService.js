import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AUTH_SETTINGS_PATH = join(__dirname, '../db/auth-settings.json');

const DEFAULT_SETTINGS = {
  enabled: false,
  username: 'admin',
  passwordHash: null  // bcrypt 或 sha256 哈希
};

export class AuthService {
  constructor() {
    this.settings = this.loadSettings();
  }

  loadSettings() {
    try {
      if (fs.existsSync(AUTH_SETTINGS_PATH)) {
        const data = fs.readFileSync(AUTH_SETTINGS_PATH, 'utf-8');
        return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
      }
    } catch (err) {
      console.error('[AuthService] 加载设置失败:', err.message);
    }
    return { ...DEFAULT_SETTINGS };
  }

  saveSettings() {
    try {
      fs.writeFileSync(AUTH_SETTINGS_PATH, JSON.stringify(this.settings, null, 2));
      return true;
    } catch (err) {
      console.error('[AuthService] 保存设置失败:', err.message);
      return false;
    }
  }

  // 哈希密码
  hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
  }

  // 验证密码
  verifyPassword(password) {
    if (!this.settings.enabled || !this.settings.passwordHash) {
      return true;  // 未启用认证，直接通过
    }
    const hash = this.hashPassword(password);
    return hash === this.settings.passwordHash;
  }

  // 验证用户名和密码
  authenticate(username, password) {
    if (!this.settings.enabled) {
      return { success: true };
    }

    if (username !== this.settings.username) {
      return { success: false, error: '用户名错误' };
    }

    if (!this.verifyPassword(password)) {
      return { success: false, error: '密码错误' };
    }

    return { success: true };
  }

  // 设置密码（同时启用认证）
  setPassword(username, password) {
    this.settings.username = username || 'admin';
    this.settings.passwordHash = this.hashPassword(password);
    this.settings.enabled = true;
    return this.saveSettings();
  }

  // 禁用认证
  disableAuth() {
    this.settings.enabled = false;
    this.settings.passwordHash = null;
    return this.saveSettings();
  }

  // 获取认证状态（不返回密码哈希）
  getStatus() {
    return {
      enabled: this.settings.enabled,
      username: this.settings.username
    };
  }

  // 检查是否需要认证
  isAuthRequired() {
    return this.settings.enabled && this.settings.passwordHash !== null;
  }

  // 生成会话令牌
  generateToken() {
    return crypto.randomBytes(32).toString('hex');
  }
}
