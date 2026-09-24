/**
 * 网页推送（Web Push / VAPID）：密钥与订阅的持久化 + 群发。
 *
 * 为什么是网页推送而不是微信/短信：不经第三方账号，不花钱；手机把 /m/ 加到主屏幕后（iOS ≥ 16.4）
 * 就能收到系统通知。推送经苹果/谷歌的推送服务器中转，**内容只写摘要**，不放代码、不放完整问题。
 *
 * 存储：~/.webtmux/push/（本机数据目录，永不入 git）
 *   vapid.json          首次用到时生成；换了它，所有已订阅的设备都要重新开启提醒
 *   subscriptions.json  [{endpoint, keys, ua, at}]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import path from 'path';
import os from 'os';
import webpush from 'web-push';

/** VAPID subject 必须是 mailto: 或 https:。用产品站点，不放任何人的邮箱 */
const SUBJECT = 'https://term.whaty.org';
/** 推送服务器替我们保留多久（秒）。手机离线超过这个时间就丢：过时的"在等你"没有意义 */
const TTL_S = 6 * 3600;
/** 这两个状态码表示订阅已失效（用户关了通知 / 卸了主屏幕图标），必须删，否则每次都白发 */
const GONE = new Set([404, 410]);

export class PushService {
  constructor({ dir = path.join(os.homedir(), '.webtmux', 'push'), sender = webpush } = {}) {
    this.dir = dir;
    this.sender = sender;
    this.vapidFile = path.join(dir, 'vapid.json');
    this.subsFile = path.join(dir, 'subscriptions.json');
    this._vapid = null;
  }

  _ensureDir() { mkdirSync(this.dir, { recursive: true, mode: 0o700 }); }

  _writePrivate(file, obj) {
    this._ensureDir();
    writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* Windows 上无意义，忽略 */ }
  }

  /** 读或首次生成 VAPID 密钥。私钥只落本机文件，不进日志、不进响应 */
  vapid() {
    if (this._vapid) return this._vapid;
    let v = null;
    try { v = JSON.parse(readFileSync(this.vapidFile, 'utf8')); } catch { /* 首次或损坏 → 重新生成 */ }
    if (!v?.publicKey || !v?.privateKey) {
      v = this.sender.generateVAPIDKeys();
      this._writePrivate(this.vapidFile, v);
    }
    this._vapid = v;
    return v;
  }

  publicKey() { return this.vapid().publicKey; }

  list() {
    try {
      const a = JSON.parse(readFileSync(this.subsFile, 'utf8'));
      return Array.isArray(a) ? a.filter((s) => s?.endpoint && s?.keys?.p256dh && s?.keys?.auth) : [];
    } catch { return []; }
  }

  _save(list) { this._writePrivate(this.subsFile, list); }

  /** 同一 endpoint 重复开启只保留一份（按钮点两次、重装图标都会这样） */
  subscribe(sub, ua = '') {
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
      throw new Error('订阅信息不完整');
    }
    const rest = this.list().filter((s) => s.endpoint !== sub.endpoint);
    rest.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      ua: String(ua).slice(0, 200), at: new Date().toISOString() });
    this._save(rest);
    return rest.length;
  }

  unsubscribe(endpoint) {
    const all = this.list();
    const rest = all.filter((s) => s.endpoint !== endpoint);
    if (rest.length !== all.length) this._save(rest);
    return all.length - rest.length;
  }

  has(endpoint) { return this.list().some((s) => s.endpoint === endpoint); }

  /**
   * 发给所有订阅（或只发给 only 指定的 endpoint，用于「发一条测试」）。
   * 失效订阅自动删；其他失败只记数不删（网络抖动不该让人收不到下一条）。
   * @returns {Promise<{sent:number, removed:number, failed:number, errors:string[]}>}
   */
  async send(payload, { only = null } = {}) {
    const v = this.vapid();
    const targets = this.list().filter((s) => !only || s.endpoint === only);
    const body = JSON.stringify(payload);
    const gone = [];
    const errors = [];
    let sent = 0;
    await Promise.all(targets.map(async (s) => {
      try {
        await this.sender.sendNotification(s, body, {
          TTL: TTL_S, urgency: payload.urgency || 'normal',
          vapidDetails: { subject: SUBJECT, publicKey: v.publicKey, privateKey: v.privateKey },
          // 同一 topic 的新通知在推送服务器上顶掉旧的（手机离线时只留最新一条）
          ...(payload.topic ? { topic: payload.topic } : {}),
        });
        sent += 1;
      } catch (err) {
        if (GONE.has(err?.statusCode)) gone.push(s.endpoint);
        else errors.push(`${hostOf(s.endpoint)} ${err?.statusCode || ''} ${err?.body || err?.message || err}`.trim());
      }
    }));
    if (gone.length) this._save(this.list().filter((s) => !gone.includes(s.endpoint)));
    return { sent, removed: gone.length, failed: errors.length, errors };
  }
}

/** 日志里只露推送服务的主机名（endpoint 全文相当于这台设备的投递地址） */
export function hostOf(endpoint) {
  try { return new URL(endpoint).host; } catch { return '?'; }
}
