import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AUTH_SETTINGS_PATH = join(__dirname, '../db/auth-settings.json');

// 订阅服务器地址
const SUBSCRIPTION_SERVER = process.env.SUBSCRIPTION_SERVER || 'https://term.whaty.org';

const DEFAULT_SETTINGS = {
  enabled: false,
  username: 'admin',
  passwordHash: null  // bcrypt 或 sha256 哈希
};

export class AuthService {
  constructor() {
    this.settings = this.loadSettings();
    // 在线登录失败计数（防止暴力破解）
    this.loginAttempts = new Map();  // IP -> { count, lastAttempt }
    this.MAX_ATTEMPTS = 5;
    this.LOCKOUT_TIME = 15 * 60 * 1000;  // 15 分钟锁定
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

  // 验证用户名和密码（本地认证）
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

  // 检查是否被锁定（防止暴力破解）
  isLocked(ip) {
    const attempts = this.loginAttempts.get(ip);
    if (!attempts) return false;

    // 检查是否在锁定期内
    if (Date.now() - attempts.lastAttempt > this.LOCKOUT_TIME) {
      this.loginAttempts.delete(ip);
      return false;
    }

    return attempts.count >= this.MAX_ATTEMPTS;
  }

  // 记录失败的登录尝试
  recordFailedAttempt(ip) {
    const attempts = this.loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    attempts.count++;
    attempts.lastAttempt = Date.now();
    this.loginAttempts.set(ip, attempts);

    const remaining = this.MAX_ATTEMPTS - attempts.count;
    return remaining > 0 ? remaining : 0;
  }

  // 清除登录尝试记录（登录成功后）
  clearAttempts(ip) {
    this.loginAttempts.delete(ip);
  }

  // 验证在线凭据（调用订阅服务器）
  async verifyOnlineCredentials(email, password) {
    try {
      const response = await fetch(`${SUBSCRIPTION_SERVER}/api/auth/verify-credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, password })
      });

      if (!response.ok) {
        console.error(`[AuthService] 在线验证失败: HTTP ${response.status}`);
        return { valid: false, error: '验证服务暂时不可用' };
      }

      const result = await response.json();

      if (result.valid) {
        console.log(`[AuthService] 在线验证成功: ${email}`);
      } else {
        console.log(`[AuthService] 在线验证失败: ${email} - ${result.error}`);
      }

      return result;
    } catch (err) {
      console.error('[AuthService] 在线验证请求失败:', err.message);
      return { valid: false, error: '无法连接到验证服务器' };
    }
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
