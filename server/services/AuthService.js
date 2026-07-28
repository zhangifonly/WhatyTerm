import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AUTH_SETTINGS_PATH = join(__dirname, '../db/auth-settings.json');

// 订阅服务器地址
const SUBSCRIPTION_SERVER = process.env.SUBSCRIPTION_SERVER || 'https://term.whaty.org';

// 微信 OAuth 云端中转（term.whaty.org）签发 openid 时用的共享密钥。
// 云端中转与本客户端用同一密钥做 HMAC，客户端据此验证回传的 openid 未被伪造。
// ⚠️ 占位：服务号申请下来后，云端与客户端配同一个真实随机密钥（环境变量注入）。
const WX_RELAY_SECRET = process.env.WX_RELAY_SECRET || 'PLACEHOLDER_WX_RELAY_SECRET_CHANGE_ME';
// 云端中转基址（发起微信授权、回调都在这里，域名固定且已备案）
// 微信网页授权域名必须 ICP 备案 → 用 CN-BJ 的 crs.owly.cn（term.whaty.org 在美国、未备案）
const WX_RELAY_BASE = process.env.WX_RELAY_BASE || 'https://crs.owly.cn';
// openid 签名有效期（防重放）
const WX_SIG_TTL_MS = 5 * 60 * 1000;

const DEFAULT_SETTINGS = {
  enabled: false,
  username: 'admin',
  passwordHash: null,  // bcrypt 或 sha256 哈希
  wxOpenids: []        // 已绑定的微信 openid 白名单（仅本人，本机绑定时写入）
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

  // ─── 微信认证（云端中转换 openid + 本机白名单）───────────────────

  /** 云端中转基址（前端拼授权链接用） */
  getWxRelayBase() {
    return WX_RELAY_BASE;
  }

  /**
   * 中转共享密钥：环境变量优先，其次本地配置文件（server/db/auth-settings.json 的
   * wxRelaySecret 字段，已 gitignore）——打包应用无法注入环境变量时用后者。
   */
  getWxRelaySecret() {
    const s = process.env.WX_RELAY_SECRET || this.settings.wxRelaySecret || WX_RELAY_SECRET;
    return s;
  }

  /** 是否配置了微信认证（占位密钥未替换时视为未就绪） */
  isWxConfigured() {
    const s = this.getWxRelaySecret();
    return !!s && !s.startsWith('PLACEHOLDER_');
  }

  /**
   * 校验云端中转回传的 openid 签名（HMAC-SHA256(openid.ts, 共享密钥)）+ 时间戳防重放。
   * 云端换到 openid 后用同一密钥签名，客户端据此确认 openid 真实、未被伪造。
   */
  verifyWxSignature(openid, ts, sig) {
    if (!openid || !ts || !sig) return false;
    const age = Date.now() - Number(ts);
    if (!(age >= -60000 && age <= WX_SIG_TTL_MS)) return false; // 允许 60s 时钟偏差
    const expected = crypto.createHmac('sha256', this.getWxRelaySecret())
      .update(`${openid}.${ts}`).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch { return false; }
  }

  /** openid 是否在白名单（本人已绑定） */
  isWxOpenidAllowed(openid) {
    return !!openid && Array.isArray(this.settings.wxOpenids) && this.settings.wxOpenids.includes(openid);
  }

  /** 绑定 openid 到白名单（仅本机可信操作调用） */
  bindWxOpenid(openid) {
    if (!openid) return false;
    if (!Array.isArray(this.settings.wxOpenids)) this.settings.wxOpenids = [];
    if (!this.settings.wxOpenids.includes(openid)) {
      this.settings.wxOpenids.push(openid);
      this.saveSettings();
    }
    return true;
  }

  /** 解绑 openid */
  unbindWxOpenid(openid) {
    if (!Array.isArray(this.settings.wxOpenids)) return false;
    this.settings.wxOpenids = this.settings.wxOpenids.filter(o => o !== openid);
    return this.saveSettings();
  }

  /** 已绑定的 openid 列表（脱敏，仅供状态显示） */
  getWxOpenids() {
    return (this.settings.wxOpenids || []).map(o =>
      o.length > 8 ? `${o.slice(0, 4)}****${o.slice(-4)}` : o
    );
  }

  /** 是否已绑定至少一个微信 */
  hasWxBound() {
    return Array.isArray(this.settings.wxOpenids) && this.settings.wxOpenids.length > 0;
  }
}
