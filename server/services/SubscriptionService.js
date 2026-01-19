import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 许可证文件路径
const LICENSE_FILE = path.join(os.homedir(), '.whatyterm', 'license.key');
const LICENSE_CACHE_FILE = path.join(os.homedir(), '.whatyterm', 'license.cache');

// 订阅服务器配置
const SUBSCRIPTION_SERVER = 'https://term.whaty.org';
const API_ENDPOINTS = {
  activate: '/api/license/activate',
  verify: '/api/license/verify',
  deactivate: '/api/license/deactivate',
  info: '/api/license/info'
};

// 验证缓存有效期（小时）
const CACHE_VALIDITY_HOURS = 24;

// 免费插件列表（开源部分）
const FREE_PLUGINS = ['default'];

// 高级插件列表（需要订阅）
const PREMIUM_PLUGINS = [
  'paper-writing',
  'app-dev',
  'data-analysis',
  'deployment',
  'fullstack-dev',
  'code-review',
  'refactoring',
  'bug-fix',
  'scientific-research',
  'tdd-development',
  'frontend-design',
  'api-integration',
  'security-audit',
  'document-processing',
  'plan-execution'
];

/**
 * 订阅验证服务
 * 负责验证用户订阅状态和许可证
 * 支持在线验证和离线缓存
 */
class SubscriptionService {
  constructor() {
    this.license = null;
    this.licenseValid = false;
    this.licenseInfo = null;
    this.machineId = this._getMachineId();
    this.lastVerifyTime = null;
    this.verifyCache = null;
    this._ensureDir();
  }

  /**
   * 确保许可证目录存在
   */
  _ensureDir() {
    const dir = path.dirname(LICENSE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 获取机器唯一标识
   */
  _getMachineId() {
    const interfaces = os.networkInterfaces();
    const cpus = os.cpus();
    const hostname = os.hostname();

    // 组合多个硬件信息生成唯一 ID
    let raw = hostname + (cpus[0]?.model || '');

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

  /**
   * 获取订阅页面 URL
   * @returns {string} 订阅页面 URL（包含机器 ID）
   */
  getSubscriptionUrl() {
    return `${SUBSCRIPTION_SERVER}?machineId=${this.machineId}`;
  }

  /**
   * 加载本地许可证
   */
  loadLicense() {
    try {
      if (fs.existsSync(LICENSE_FILE)) {
        const content = fs.readFileSync(LICENSE_FILE, 'utf-8');
        this.license = content.trim();

        // 尝试加载缓存
        this._loadCache();

        // 如果缓存有效，使用缓存
        if (this._isCacheValid()) {
          this.licenseValid = true;
          this.licenseInfo = this.verifyCache.info;
          console.log(`[SubscriptionService] 使用缓存的许可证信息: ${this.licenseInfo.email}`);
        } else {
          // 缓存无效，进行在线验证
          this._validateLicenseOffline();
        }
      } else {
        console.log('[SubscriptionService] 未找到许可证文件');
        this.licenseValid = false;
        this.licenseInfo = null;
      }
    } catch (err) {
      console.error('[SubscriptionService] 加载许可证失败:', err.message);
      this.licenseValid = false;
    }
  }

  /**
   * 加载验证缓存
   */
  _loadCache() {
    try {
      if (fs.existsSync(LICENSE_CACHE_FILE)) {
        const content = fs.readFileSync(LICENSE_CACHE_FILE, 'utf-8');
        this.verifyCache = JSON.parse(content);
        this.lastVerifyTime = new Date(this.verifyCache.verifyTime);
      }
    } catch (err) {
      this.verifyCache = null;
      this.lastVerifyTime = null;
    }
  }

  /**
   * 保存验证缓存
   */
  _saveCache(info) {
    try {
      const cache = {
        verifyTime: new Date().toISOString(),
        info: info,
        machineId: this.machineId
      };
      fs.writeFileSync(LICENSE_CACHE_FILE, JSON.stringify(cache, null, 2));
      this.verifyCache = cache;
      this.lastVerifyTime = new Date();
    } catch (err) {
      console.error('[SubscriptionService] 保存缓存失败:', err.message);
    }
  }

  /**
   * 清除本地许可证文件（设备被解绑时调用）
   */
  _clearLocalLicense() {
    try {
      if (fs.existsSync(LICENSE_FILE)) {
        fs.unlinkSync(LICENSE_FILE);
      }
      if (fs.existsSync(LICENSE_CACHE_FILE)) {
        fs.unlinkSync(LICENSE_CACHE_FILE);
      }
      this.license = null;
      this.verifyCache = null;
      this.lastVerifyTime = null;
    } catch (err) {
      console.error('[SubscriptionService] 清除本地许可证失败:', err.message);
    }
  }

  /**
   * 检查缓存是否有效
   */
  _isCacheValid() {
    if (!this.verifyCache || !this.lastVerifyTime) {
      return false;
    }

    // 检查缓存是否过期
    const now = new Date();
    const cacheAge = (now - this.lastVerifyTime) / (1000 * 60 * 60);
    if (cacheAge > CACHE_VALIDITY_HOURS) {
      return false;
    }

    // 检查机器 ID 是否匹配
    if (this.verifyCache.machineId !== this.machineId) {
      return false;
    }

    // 检查许可证是否过期
    if (this.verifyCache.info && this.verifyCache.info.expiresAt) {
      const expiresAt = new Date(this.verifyCache.info.expiresAt);
      if (expiresAt < now) {
        return false;
      }
    }

    return true;
  }

  /**
   * 离线验证许可证（基本格式检查）
   */
  _validateLicenseOffline() {
    if (!this.license) {
      this.licenseValid = false;
      return;
    }

    try {
      // 许可证格式: BASE64(JSON)
      const data = Buffer.from(this.license, 'base64').toString('utf-8');
      const licenseData = JSON.parse(data);

      // 检查必要字段（支持 code 或 key）
      const licenseCode = licenseData.code || licenseData.key;
      if (!licenseCode || !licenseData.expiresAt) {
        throw new Error('许可证数据不完整');
      }

      // 检查过期时间
      const expiresAt = new Date(licenseData.expiresAt);
      if (expiresAt < new Date()) {
        throw new Error('许可证已过期');
      }

      // 离线模式下暂时认为有效，等待在线验证
      this.licenseValid = true;
      this.licenseInfo = {
        code: licenseCode,
        plan: licenseData.planName || licenseData.plan || 'unknown',
        expiresAt: expiresAt,
        email: licenseData.email || '',
        maxDevices: licenseData.maxDevices || 1,
        offlineMode: true
      };

      console.log(`[SubscriptionService] 离线验证通过，计划: ${this.licenseInfo.plan}, 到期: ${expiresAt.toISOString()}`);
    } catch (err) {
      console.error('[SubscriptionService] 离线验证失败:', err.message);
      this.licenseValid = false;
      this.licenseInfo = null;
    }
  }

  /**
   * 在线激活许可证
   * @param {string} activationCode - 激活码（从网站获取）
   * @returns {Promise<Object>} 激活结果
   */
  async activateLicense(activationCode) {
    try {
      const response = await fetch(`${SUBSCRIPTION_SERVER}${API_ENDPOINTS.activate}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          code: activationCode.trim(),
          machineId: this.machineId,
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch()
        })
      });

      const result = await response.json();

      if (result.success) {
        // 保存许可证
        const licenseData = {
          code: activationCode.trim(),
          ...result.license
        };
        const licenseB64 = Buffer.from(JSON.stringify(licenseData)).toString('base64');

        fs.writeFileSync(LICENSE_FILE, licenseB64);
        this.license = licenseB64;

        // 更新状态
        this.licenseValid = true;
        this.licenseInfo = {
          code: activationCode.trim(),
          email: result.license.email,
          plan: result.license.plan,
          expiresAt: new Date(result.license.expiresAt),
          maxDevices: result.license.maxDevices || 1,
          features: result.license.features || []
        };

        // 保存缓存
        this._saveCache(this.licenseInfo);

        return {
          success: true,
          message: '许可证激活成功',
          info: this.licenseInfo
        };
      } else {
        return {
          success: false,
          message: result.message || '激活失败'
        };
      }
    } catch (err) {
      console.error('[SubscriptionService] 在线激活失败:', err.message);
      return {
        success: false,
        message: `网络错误: ${err.message}`,
        offline: true
      };
    }
  }

  /**
   * 使用邮箱+密码激活许可证
   * @param {string} email - 用户邮箱
   * @param {string} password - 用户密码
   * @returns {Promise<Object>} 激活结果
   */
  async activateLicenseByLogin(email, password) {
    try {
      const response = await fetch(`${SUBSCRIPTION_SERVER}${API_ENDPOINTS.activate}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: email.trim(),
          password: password,
          machineId: this.machineId,
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch()
        })
      });

      const result = await response.json();

      if (result.success) {
        // 保存许可证
        const licenseData = {
          key: result.license.key,
          email: result.license.email,
          plan: result.license.plan,
          planName: result.license.planName,
          expiresAt: result.license.expiresAt,
          maxDevices: result.license.maxDevices
        };
        const licenseB64 = Buffer.from(JSON.stringify(licenseData)).toString('base64');

        fs.writeFileSync(LICENSE_FILE, licenseB64);
        this.license = licenseB64;

        // 更新状态
        this.licenseValid = true;
        this.licenseInfo = {
          code: result.license.key,
          email: result.license.email,
          plan: result.license.planName || result.license.plan,
          expiresAt: new Date(result.license.expiresAt),
          maxDevices: result.license.maxDevices || 1
        };

        // 保存缓存
        this._saveCache(this.licenseInfo);

        return {
          success: true,
          message: '激活成功',
          info: this.licenseInfo
        };
      } else {
        return {
          success: false,
          message: result.message || '激活失败'
        };
      }
    } catch (err) {
      console.error('[SubscriptionService] 邮箱登录激活失败:', err.message);
      return {
        success: false,
        message: `网络错误: ${err.message}`,
        offline: true
      };
    }
  }

  /**
   * 在线验证许可证
   * @returns {Promise<Object>} 验证结果
   */
  async verifyLicenseOnline() {
    if (!this.license) {
      return { success: false, message: '未找到许可证' };
    }

    try {
      // 解析许可证获取激活码
      const data = Buffer.from(this.license, 'base64').toString('utf-8');
      const licenseData = JSON.parse(data);

      const response = await fetch(`${SUBSCRIPTION_SERVER}${API_ENDPOINTS.verify}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          code: licenseData.code,
          machineId: this.machineId
        })
      });

      const result = await response.json();

      if (result.success) {
        // 更新许可证信息
        this.licenseValid = true;
        this.licenseInfo = {
          code: licenseData.code,
          email: result.license.email,
          plan: result.license.plan,
          expiresAt: new Date(result.license.expiresAt),
          maxDevices: result.license.maxDevices || 1,
          features: result.license.features || [],
          offlineMode: false
        };

        // 更新缓存
        this._saveCache(this.licenseInfo);

        return {
          success: true,
          message: '许可证验证成功',
          info: this.licenseInfo
        };
      } else {
        // 验证失败，清除许可证状态
        this.licenseValid = false;
        this.licenseInfo = null;

        // 如果是设备被解绑或许可证无效，清除本地文件
        if (result.code === 'DEVICE_DEACTIVATED' || result.code === 'LICENSE_INVALID') {
          this._clearLocalLicense();
          console.log('[SubscriptionService] 设备已被解绑，本地许可证已清除');
        }

        return {
          success: false,
          message: result.message || '许可证无效',
          code: result.code
        };
      }
    } catch (err) {
      console.error('[SubscriptionService] 在线验证失败:', err.message);

      // 网络错误时，如果缓存有效则继续使用
      if (this._isCacheValid()) {
        return {
          success: true,
          message: '使用缓存的许可证信息（离线模式）',
          info: this.licenseInfo,
          offline: true
        };
      }

      return {
        success: false,
        message: `网络错误: ${err.message}`,
        offline: true
      };
    }
  }

  /**
   * 停用许可证
   * @returns {Promise<Object>} 停用结果
   */
  async deactivateLicense() {
    try {
      // 尝试在线停用
      if (this.license) {
        try {
          const data = Buffer.from(this.license, 'base64').toString('utf-8');
          const licenseData = JSON.parse(data);

          await fetch(`${SUBSCRIPTION_SERVER}${API_ENDPOINTS.deactivate}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              code: licenseData.code,
              machineId: this.machineId
            })
          });
        } catch (err) {
          console.warn('[SubscriptionService] 在线停用失败，继续本地清理');
        }
      }

      // 清理本地文件
      if (fs.existsSync(LICENSE_FILE)) {
        fs.unlinkSync(LICENSE_FILE);
      }
      if (fs.existsSync(LICENSE_CACHE_FILE)) {
        fs.unlinkSync(LICENSE_CACHE_FILE);
      }

      this.license = null;
      this.licenseValid = false;
      this.licenseInfo = null;
      this.verifyCache = null;
      this.lastVerifyTime = null;

      return { success: true, message: '许可证已停用' };
    } catch (err) {
      return { success: false, message: `停用失败: ${err.message}` };
    }
  }

  /**
   * 检查是否有有效订阅
   */
  hasValidSubscription() {
    return this.licenseValid;
  }

  /**
   * 检查插件是否可用
   * @param {string} pluginId - 插件 ID
   * @returns {boolean} 是否可用
   */
  isPluginAvailable(pluginId) {
    // 免费插件始终可用
    if (FREE_PLUGINS.includes(pluginId)) {
      return true;
    }

    // 高级插件需要有效订阅
    if (PREMIUM_PLUGINS.includes(pluginId)) {
      return this.licenseValid;
    }

    // 未知插件默认不可用
    return false;
  }

  /**
   * 获取可用插件列表
   * @returns {Array<string>} 可用插件 ID 列表
   */
  getAvailablePlugins() {
    if (this.licenseValid) {
      return [...FREE_PLUGINS, ...PREMIUM_PLUGINS];
    }
    return [...FREE_PLUGINS];
  }

  /**
   * 获取订阅状态
   */
  getStatus() {
    return {
      valid: this.licenseValid,
      info: this.licenseInfo,
      machineId: this.machineId,
      subscriptionUrl: this.getSubscriptionUrl(),
      freePlugins: FREE_PLUGINS,
      premiumPlugins: PREMIUM_PLUGINS,
      availablePlugins: this.getAvailablePlugins(),
      lastVerifyTime: this.lastVerifyTime?.toISOString() || null,
      cacheValid: this._isCacheValid()
    };
  }

  /**
   * 获取剩余天数
   * @returns {number|null} 剩余天数，未订阅返回 null
   */
  getRemainingDays() {
    if (!this.licenseValid || !this.licenseInfo?.expiresAt) {
      return null;
    }

    const now = new Date();
    const expiresAt = new Date(this.licenseInfo.expiresAt);
    const diffTime = expiresAt - now;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    return Math.max(0, diffDays);
  }

  /**
   * 获取可用的隧道类型列表
   * - 付费用户：可使用 FRP 和 Cloudflare，选择更快的
   * - 免费用户：只能使用 Cloudflare 隧道（域名每次变化）
   * - Windows 平台 FRP：使用自定义 FRP 库（非 frpc.exe）
   * @returns {Array<'frp' | 'cloudflare'>} 可用隧道类型列表
   */
  getAvailableTunnelTypes() {
    if (this.licenseValid) {
      // 付费用户可以使用两种隧道
      return ['frp', 'cloudflare'];
    }
    // 免费用户只能使用 Cloudflare
    return ['cloudflare'];
  }

  /**
   * 检查是否可以使用 FRP 隧道
   * @returns {boolean} 是否可以使用 FRP
   */
  canUseFrp() {
    return this.licenseValid;
  }

  /**
   * 检查是否可以使用 Cloudflare 隧道
   * @returns {boolean} 是否可以使用 Cloudflare（所有用户都可以）
   */
  canUseCloudflare() {
    return true;
  }
}

// 创建单例
const subscriptionService = new SubscriptionService();

// 启动时加载许可证
subscriptionService.loadLicense();

export { SubscriptionService, FREE_PLUGINS, PREMIUM_PLUGINS };
export default subscriptionService;
