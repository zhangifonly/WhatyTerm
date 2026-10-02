/**
 * 已授权的远程设备（手机等）：登录一次，30 天内免登录；桌面端可查看、可逐个退出。
 *
 * 为什么不靠 express-session：它默认把会话放在进程内存里，签名密钥每次启动随机生成 ——
 * 服务一重启（改代码、崩溃、launchd 拉起、整机重启）所有手机都要重新登录，cookie 上写的 7 天形同虚设。
 *
 * 做法：登录成功时发一个随机令牌放在 httpOnly cookie 里，服务端只存它的 SHA-256（文件被人看到也拿不到令牌），
 * 连同设备信息与到期时间落盘。每次请求 / socket 连接凭 cookie 认设备，重启不丢。
 * 到期后必须重新登录（到期时间从登录时算起，使用不续期 —— 一周校验一次，用户要求的就是这个）。
 */

import crypto from 'crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'fs';
import os from 'os';
import path from 'path';

export const DEVICE_COOKIE = 'wt_device';
// 2026-10-02 用户定为一个月（原 7 天）。手机丢了可在电脑端「已授权设备」里立即退出
export const DEVICE_TTL_MS = 30 * 24 * 3600 * 1000;
/** 「最近使用」只在隔了这么久才写盘，避免每个请求都写文件 */
const TOUCH_EVERY_MS = 60 * 1000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** User-Agent → 人看得懂的设备名（只用于显示） */
export function describeDevice(ua = '') {
  const u = String(ua);
  const os_ = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android'
    : /Macintosh|Mac OS X/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : '未知设备';
  const br = /MicroMessenger/.test(u) ? '微信' : /EdgA?\//.test(u) ? 'Edge' : /CriOS|Chrome\//.test(u) ? 'Chrome'
    : /FxiOS|Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : '';
  return br ? `${os_} · ${br}` : os_;
}

/** 从 Cookie 头里取某个 cookie（不依赖 cookie-parser） */
export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

export class DeviceTrust {
  constructor({ file = path.join(os.homedir(), '.webtmux', 'trusted-devices.json'), now = Date.now } = {}) {
    Object.assign(this, { file, now });
    this.devices = this._load();
  }

  _load() {
    try {
      const a = JSON.parse(readFileSync(this.file, 'utf8'));
      const list = Array.isArray(a) ? a.filter((d) => d?.id && d?.tokenHash && d?.expiresAt) : [];
      // 期限改长后，已登录的设备按新期限顺延（从登录时算起），只延不缩
      for (const d of list) if (d.createdAt && d.expiresAt < d.createdAt + DEVICE_TTL_MS) d.expiresAt = d.createdAt + DEVICE_TTL_MS;
      return list;
    } catch { return []; }
  }

  _save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
      try { chmodSync(this.file, 0o600); } catch { /* Windows */ }
    } catch (e) { console.error('[设备授权] 保存失败:', e.message); }
  }

  _prune() {
    const n = this.now();
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.expiresAt > n);
    return before !== this.devices.length;
  }

  /**
   * 登记一台新授权设备。
   * @param {{ua?: string, ip?: string, method?: string}} info  method：密码 / 扫码 / 微信 / 在线账号
   * @returns {{token: string, device: object}} token 只在这里出现一次，放进 cookie
   */
  issue({ ua = '', ip = '', method = '' } = {}) {
    this._prune();
    const token = crypto.randomBytes(32).toString('base64url');
    const n = this.now();
    const device = { id: crypto.randomBytes(8).toString('hex'), tokenHash: sha(token), name: describeDevice(ua),
      ua: String(ua).slice(0, 300), ip: String(ip).slice(0, 64), method, createdAt: n, lastSeenAt: n, expiresAt: n + DEVICE_TTL_MS };
    this.devices.push(device);
    this._save();
    return { token, device };
  }

  /** 凭令牌认设备；过期、被退出、令牌不对都返回 null */
  verify(token, { ip = '' } = {}) {
    if (!token) return null;
    const h = sha(token);
    const d = this.devices.find((x) => x.tokenHash.length === h.length && crypto.timingSafeEqual(Buffer.from(x.tokenHash), Buffer.from(h)));
    if (!d) return null;
    const n = this.now();
    if (d.expiresAt <= n) { this._prune(); this._save(); return null; }
    if (n - (d.lastSeenAt || 0) > TOUCH_EVERY_MS) {
      d.lastSeenAt = n;
      if (ip) d.lastIp = String(ip).slice(0, 64);
      this._save();
    }
    return d;
  }

  /** 给桌面端看的列表（不含令牌哈希） */
  list() {
    if (this._prune()) this._save();
    return this.devices.map(({ tokenHash, ...rest }) => rest).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /** 这台设备是否仍在授权中（请求路径上用：不排序不复制） */
  has(id) {
    const n = this.now();
    return this.devices.some((d) => d.id === id && d.expiresAt > n);
  }

  revoke(id) {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (before !== this.devices.length) { this._save(); return true; }
    return false;
  }

  /** 按令牌注销（手机上点「退出登录」时用） */
  revokeToken(token) {
    if (!token) return false;
    const h = sha(token);
    const d = this.devices.find((x) => x.tokenHash === h);
    return d ? this.revoke(d.id) : false;
  }
}

export default new DeviceTrust();
