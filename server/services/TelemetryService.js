/**
 * TelemetryService - 匿名使用统计
 *
 * 采集内容（全部非隐私数据）：
 *  - deviceId: 与 SubscriptionService 一致的哈希机器ID（无法反推硬件信息）
 *  - appVersion, platform, arch, osVersion
 *  - sessionCount: 当天创建的终端会话数
 *  - featureFlags: 使用过的功能集合（布尔值）
 *  - isPro: 是否付费用户
 *
 * 绝不采集：IP之外的网络信息、命令内容、文件路径、主机名、邮箱
 */

import crypto from 'crypto';
import os from 'os';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TELEMETRY_URL = 'https://term.whaty.org/api/telemetry';
const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每天一次

class TelemetryService {
  constructor() {
    this._lastReportTime = 0;
    this._sessionCount = 0;
    this._featureFlags = {};
    this._timer = null;
    this._version = this._readVersion();
  }

  _readVersion() {
    try {
      const pkgPath = join(__dirname, '../../package.json');
      return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    } catch {
      return 'unknown';
    }
  }

  // 生成匿名设备ID（与 SubscriptionService.machineId 相同算法）
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

  /** 记录会话创建事件（由 SessionManager 调用） */
  recordSession() {
    this._sessionCount++;
  }

  /** 记录功能使用（由各服务调用） */
  recordFeature(feature) {
    this._featureFlags[feature] = true;
  }

  /** 启动定时上报，传入 subscriptionService 实例 */
  start(subscriptionService) {
    this._subscriptionService = subscriptionService;
    // 延迟 5 分钟后首次上报（避免启动时网络未就绪）
    setTimeout(() => this._report(), 5 * 60 * 1000);
    this._timer = setInterval(() => this._report(), REPORT_INTERVAL_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _report() {
    try {
      const payload = {
        deviceId: this._getDeviceId(),
        appVersion: this._version,
        platform: os.platform(),
        arch: os.arch(),
        osVersion: os.release(),
        sessionCount: this._sessionCount,
        isPro: this._subscriptionService?.hasValidSubscription?.() ?? false,
        features: { ...this._featureFlags },
        reportedAt: Date.now(),
      };

      // 重置计数（每次上报后清零，下次上报是新一天的数据）
      this._sessionCount = 0;
      this._featureFlags = {};

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      await fetch(TELEMETRY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);
    } catch {
      // 静默失败，不影响主功能
    }
  }
}

export default new TelemetryService();
