import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Provider 管理服务
 * 基于 cc-switch 架构设计
 */
export class ProviderService {
  constructor(io = null) {
    this.io = io; // Socket.IO 实例（用于推送事件）

    // 确定数据库目录
    // Electron 环境下使用用户数据目录，否则使用项目目录
    const dbDir = this._getDbDir();

    this.providersFile = path.join(dbDir, 'providers.json');
    this.endpointsFile = path.join(dbDir, 'provider-endpoints.json');
    this.oldSettingsFile = path.join(dbDir, 'ai-settings.json');

    // 确保数据库目录存在
    this._ensureDbDir(dbDir);
  }

  /**
   * 获取数据库目录路径
   */
  _getDbDir() {
    // 如果设置了环境变量，优先使用
    if (process.env.WEBTMUX_DB_DIR) {
      return process.env.WEBTMUX_DB_DIR;
    }

    // 统一使用用户数据目录，这样 Web 版和 Electron 版可以共享数据库
    const homeDir = os.homedir();
    const userDataDir = path.join(homeDir, '.webtmux', 'db');

    // 如果用户数据目录存在，使用它
    if (fs.existsSync(userDataDir)) {
      return userDataDir;
    }

    // 否则检查项目目录的数据库是否存在（向后兼容）
    const projectDbDir = path.join(__dirname, '../db');
    const projectDbFile = path.join(projectDbDir, 'providers.json');

    if (fs.existsSync(projectDbFile)) {
      // 如果项目目录有数据库，迁移到用户数据目录
      console.log('[ProviderService] 检测到项目目录数据库，准备迁移到用户数据目录');
      this._migrateDb(projectDbDir, userDataDir);
      return userDataDir;
    }

    // 都不存在，使用用户数据目录（新安装）
    return userDataDir;
  }

  /**
   * 迁移数据库从项目目录到用户数据目录
   */
  _migrateDb(fromDir, toDir) {
    try {
      // 确保目标目录存在
      if (!fs.existsSync(toDir)) {
        fs.mkdirSync(toDir, { recursive: true });
      }

      // 迁移数据库文件
      const files = ['providers.json', 'provider-endpoints.json', 'ai-settings.json', 'webtmux.db'];
      let migratedCount = 0;

      for (const file of files) {
        const fromFile = path.join(fromDir, file);
        const toFile = path.join(toDir, file);

        if (fs.existsSync(fromFile) && !fs.existsSync(toFile)) {
          fs.copyFileSync(fromFile, toFile);
          migratedCount++;
          console.log(`[ProviderService] 迁移数据库文件: ${file}`);
        }
      }

      if (migratedCount > 0) {
        console.log(`[ProviderService] 数据库迁移完成，共迁移 ${migratedCount} 个文件`);
        console.log(`[ProviderService] 新数据库位置: ${toDir}`);
      }
    } catch (error) {
      console.error('[ProviderService] 数据库迁移失败:', error);
    }
  }

  /**
   * 确保数据库目录存在
   */
  _ensureDbDir(dbDir) {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      console.log(`[ProviderService] 创建数据库目录: ${dbDir}`);
    }
  }

  // ============================================
  // 私有方法：文件读写
  // ============================================

  /**
   * 读取 providers.json
   */
  _readProviders() {
    try {
      const data = fs.readFileSync(this.providersFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('[ProviderService] 读取 providers.json 失败:', error);
      return {
        claude: { current: null, providers: {} },
        codex: { current: null, providers: {} },
        gemini: { current: null, providers: {} }
      };
    }
  }

  /**
   * 写入 providers.json
   */
  _writeProviders(data) {
    try {
      fs.writeFileSync(this.providersFile, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('[ProviderService] 写入 providers.json 失败:', error);
      return false;
    }
  }

  /**
   * 读取 provider-endpoints.json
   */
  _readEndpoints() {
    try {
      const data = fs.readFileSync(this.endpointsFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('[ProviderService] 读取 provider-endpoints.json 失败:', error);
      return { claude: {}, codex: {}, gemini: {} };
    }
  }

  /**
   * 写入 provider-endpoints.json
   */
  _writeEndpoints(data) {
    try {
      fs.writeFileSync(this.endpointsFile, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('[ProviderService] 写入 provider-endpoints.json 失败:', error);
      return false;
    }
  }

  /**
   * 发送 Socket.IO 事件
   */
  _emit(event, data) {
    if (this.io) {
      this.io.emit(event, data);
    }
  }

  // ============================================
  // 公共方法：CRUD 操作
  // ============================================

  /**
   * 获取所有供应商
   * @param {string} appType - 'claude' | 'codex' | 'gemini'
   * @returns {Object} { current: string, providers: {} }
   */
  list(appType) {
    const data = this._readProviders();
    return data[appType] || { current: null, providers: {} };
  }

  /**
   * 获取当前供应商 ID
   * @param {string} appType
   * @returns {string|null}
   */
  getCurrent(appType) {
    const data = this._readProviders();
    return data[appType]?.current || null;
  }

  /**
   * 获取当前供应商配置
   * @param {string} appType
   * @returns {Object|null}
   */
  getCurrentProvider(appType) {
    const data = this._readProviders();
    const current = data[appType]?.current;
    if (!current) return null;
    return data[appType]?.providers[current] || null;
  }

  /**
   * 根据 ID 获取供应商
   * @param {string} appType
   * @param {string} id
   * @returns {Object|null}
   */
  getById(appType, id) {
    const data = this._readProviders();
    return data[appType]?.providers[id] || null;
  }

  /**
   * 添加供应商
   * @param {string} appType
   * @param {Object} provider
   * @returns {boolean}
   */
  add(appType, provider) {
    const data = this._readProviders();

    // 自动生成 ID（如果未提供）
    if (!provider.id) {
      provider.id = `provider-${Date.now()}`;
    }

    // 设置 appType 和创建时间
    provider.appType = appType;
    provider.createdAt = provider.createdAt || Date.now();

    // 保存到数据库
    if (!data[appType]) {
      data[appType] = { current: null, providers: {} };
    }

    data[appType].providers[provider.id] = provider;

    // 如果是第一个供应商，自动设为当前
    if (!data[appType].current) {
      data[appType].current = provider.id;
    }

    const success = this._writeProviders(data);

    if (success) {
      this._emit('provider:added', { appType, provider });
      console.log(`[ProviderService] 添加供应商成功: ${provider.name} (${provider.id})`);
    }

    return success;
  }

  /**
   * 更新供应商
   * @param {string} appType
   * @param {string} id
   * @param {Object} updates
   * @returns {boolean}
   */
  update(appType, id, updates) {
    const data = this._readProviders();

    if (!data[appType]?.providers[id]) {
      console.error(`[ProviderService] 供应商不存在: ${id}`);
      return false;
    }

    // 合并更新
    const provider = data[appType].providers[id];
    Object.assign(provider, updates);
    provider.updatedAt = Date.now();

    const success = this._writeProviders(data);

    if (success) {
      // 如果是当前供应商，需要同步到 AIEngine
      if (data[appType].current === id) {
        this._syncToAIEngine(appType, provider);
      }

      this._emit('provider:updated', { appType, provider });
      console.log(`[ProviderService] 更新供应商成功: ${provider.name} (${id})`);
    }

    return success;
  }

  /**
   * 删除供应商
   * @param {string} appType
   * @param {string} id
   * @returns {boolean}
   */
  delete(appType, id) {
    const data = this._readProviders();

    if (!data[appType]?.providers[id]) {
      console.error(`[ProviderService] 供应商不存在: ${id}`);
      return false;
    }

    // 不能删除当前供应商
    if (data[appType].current === id) {
      console.error(`[ProviderService] 不能删除当前正在使用的供应商: ${id}`);
      return false;
    }

    const providerName = data[appType].providers[id].name;
    delete data[appType].providers[id];

    // 删除关联的端点
    const endpoints = this._readEndpoints();
    if (endpoints[appType]?.[id]) {
      delete endpoints[appType][id];
      this._writeEndpoints(endpoints);
    }

    const success = this._writeProviders(data);

    if (success) {
      this._emit('provider:deleted', { appType, id });
      console.log(`[ProviderService] 删除供应商成功: ${providerName} (${id})`);
    }

    return success;
  }

  /**
   * 切换供应商
   * @param {string} appType
   * @param {string} id
   * @returns {boolean}
   */
  switch(appType, id) {
    const data = this._readProviders();

    if (!data[appType]?.providers[id]) {
      console.error(`[ProviderService] 供应商不存在: ${id}`);
      return false;
    }

    // Backfill：回填当前 live 配置到旧供应商
    const oldId = data[appType].current;
    if (oldId && oldId !== id && data[appType].providers[oldId]) {
      this._backfillToProvider(appType, oldId, data);
    }

    // 切换当前供应商
    data[appType].current = id;
    const success = this._writeProviders(data);

    if (success) {
      const provider = data[appType].providers[id];

      // 同步到 AIEngine
      this._syncToAIEngine(appType, provider);

      // 推送事件
      this._emit('provider:switched', { appType, id, provider });
      console.log(`[ProviderService] 切换供应商成功: ${provider.name} (${id})`);
    }

    return success;
  }

  /**
   * 同步当前供应商配置到 AIEngine
   * @param {string} appType
   * @param {Object} provider
   */
  _syncToAIEngine(appType, provider) {
    try {
      // 读取当前 ai-settings.json
      let settings = {};
      if (fs.existsSync(this.oldSettingsFile)) {
        settings = JSON.parse(fs.readFileSync(this.oldSettingsFile, 'utf8'));
      }

      // 合并 provider 的 settingsConfig
      Object.assign(settings, provider.settingsConfig);

      // 写入 ai-settings.json
      fs.writeFileSync(this.oldSettingsFile, JSON.stringify(settings, null, 2), 'utf8');
      console.log(`[ProviderService] 同步配置到 AIEngine: ${provider.name}`);

      return true;
    } catch (error) {
      console.error('[ProviderService] 同步配置失败:', error);
      return false;
    }
  }

  /**
   * Backfill：将当前 live 配置回填到供应商
   * 当用户在 AI 设置界面修改了配置后，切换供应商时会将修改保存回旧供应商
   * @param {string} appType
   * @param {string} providerId
   * @param {Object} data - providers 数据（可选，避免重复读取）
   * @returns {boolean}
   */
  _backfillToProvider(appType, providerId, data = null) {
    try {
      // 读取当前 ai-settings.json
      if (!fs.existsSync(this.oldSettingsFile)) {
        console.log('[ProviderService] Backfill: ai-settings.json 不存在，跳过');
        return false;
      }

      const liveSettings = JSON.parse(fs.readFileSync(this.oldSettingsFile, 'utf8'));

      // 读取 providers 数据
      if (!data) {
        data = this._readProviders();
      }

      const provider = data[appType]?.providers[providerId];
      if (!provider) {
        console.log(`[ProviderService] Backfill: 供应商 ${providerId} 不存在，跳过`);
        return false;
      }

      // 提取需要回填的字段
      const backfillFields = ['apiType', 'openai', 'claude', 'maxTokens', 'temperature'];
      const updatedConfig = { ...provider.settingsConfig };
      let hasChanges = false;

      for (const field of backfillFields) {
        if (liveSettings[field] !== undefined) {
          // 深度比较对象
          const oldValue = JSON.stringify(updatedConfig[field]);
          const newValue = JSON.stringify(liveSettings[field]);
          if (oldValue !== newValue) {
            updatedConfig[field] = liveSettings[field];
            hasChanges = true;
          }
        }
      }

      if (!hasChanges) {
        console.log(`[ProviderService] Backfill: ${provider.name} 无变更，跳过`);
        return false;
      }

      // 更新供应商配置
      provider.settingsConfig = updatedConfig;
      provider.updatedAt = Date.now();

      // 写入文件
      const success = this._writeProviders(data);
      if (success) {
        console.log(`[ProviderService] Backfill: 已将 live 配置回填到 ${provider.name}`);
        this._emit('provider:updated', { appType, id: providerId, provider });
      }

      return success;
    } catch (error) {
      console.error('[ProviderService] Backfill 失败:', error);
      return false;
    }
  }

  /**
   * 手动触发 Backfill（API 调用）
   * @param {string} appType
   * @returns {boolean}
   */
  backfillCurrentProvider(appType) {
    const data = this._readProviders();
    const currentId = data[appType]?.current;
    if (!currentId) {
      console.log(`[ProviderService] Backfill: ${appType} 没有当前供应商`);
      return false;
    }
    return this._backfillToProvider(appType, currentId, data);
  }

  // ============================================
  // 端点管理
  // ============================================

  /**
   * 获取供应商的自定义端点
   * @param {string} appType
   * @param {string} providerId
   * @returns {Array}
   */
  getEndpoints(appType, providerId) {
    const endpoints = this._readEndpoints();
    const providerEndpoints = endpoints[appType]?.[providerId] || {};

    // 转换为数组
    return Object.values(providerEndpoints);
  }

  /**
   * 添加自定义端点
   * @param {string} appType
   * @param {string} providerId
   * @param {string} url
   * @returns {boolean}
   */
  addEndpoint(appType, providerId, url) {
    const endpoints = this._readEndpoints();

    if (!endpoints[appType]) {
      endpoints[appType] = {};
    }

    if (!endpoints[appType][providerId]) {
      endpoints[appType][providerId] = {};
    }

    // 添加端点
    endpoints[appType][providerId][url] = {
      url,
      addedAt: Date.now(),
      lastUsed: null
    };

    const success = this._writeEndpoints(endpoints);

    if (success) {
      console.log(`[ProviderService] 添加端点成功: ${url} (${providerId})`);
    }

    return success;
  }

  /**
   * 删除自定义端点
   * @param {string} appType
   * @param {string} providerId
   * @param {string} url
   * @returns {boolean}
   */
  removeEndpoint(appType, providerId, url) {
    const endpoints = this._readEndpoints();

    if (endpoints[appType]?.[providerId]?.[url]) {
      delete endpoints[appType][providerId][url];

      const success = this._writeEndpoints(endpoints);

      if (success) {
        console.log(`[ProviderService] 删除端点成功: ${url} (${providerId})`);
      }

      return success;
    }

    return false;
  }

  /**
   * 更新端点最后使用时间
   * @param {string} appType
   * @param {string} providerId
   * @param {string} url
   * @returns {boolean}
   */
  updateEndpointLastUsed(appType, providerId, url) {
    const endpoints = this._readEndpoints();

    if (endpoints[appType]?.[providerId]?.[url]) {
      endpoints[appType][providerId][url].lastUsed = Date.now();
      return this._writeEndpoints(endpoints);
    }

    return false;
  }

  // ============================================
  // 数据迁移
  // ============================================

  /**
   * 从旧的 ai-settings.json 迁移配置
   * @returns {boolean}
   */
  migrateFromOldSettings() {
    try {
      if (!fs.existsSync(this.oldSettingsFile)) {
        console.log('[ProviderService] 无旧配置文件，跳过迁移');
        return false;
      }

      const oldSettings = JSON.parse(fs.readFileSync(this.oldSettingsFile, 'utf8'));

      // 检查是否已迁移
      const data = this._readProviders();
      if (Object.keys(data.claude.providers).length > 0) {
        console.log('[ProviderService] 已有供应商配置，跳过迁移');
        return false;
      }

      // 创建迁移后的供应商
      const provider = {
        id: 'provider-migrated',
        name: '迁移的 AI 配置',
        appType: 'claude',
        settingsConfig: {
          apiType: oldSettings.apiType,
          openai: oldSettings.openai,
          claude: oldSettings.claude,
          maxTokens: oldSettings.maxTokens,
          temperature: oldSettings.temperature
        },
        category: 'custom',
        websiteUrl: '',
        createdAt: Date.now(),
        sortIndex: 0,
        notes: '从旧版 ai-settings.json 自动迁移',
        icon: oldSettings.apiType === 'claude' ? 'anthropic' : 'generic',
        iconColor: '#6366F1',
        meta: {
          customEndpoints: {},
          usageScript: null
        }
      };

      // 添加供应商
      this.add('claude', provider);

      console.log('[ProviderService] 配置迁移成功');
      return true;
    } catch (error) {
      console.error('[ProviderService] 配置迁移失败:', error);
      return false;
    }
  }

  // ============================================
  // 排序管理
  // ============================================

  /**
   * 批量更新供应商排序
   * @param {string} appType
   * @param {Array} updates - [{ id: string, sortIndex: number }]
   * @returns {boolean}
   */
  updateSortOrder(appType, updates) {
    const data = this._readProviders();

    if (!data[appType]) {
      return false;
    }

    updates.forEach(({ id, sortIndex }) => {
      if (data[appType].providers[id]) {
        data[appType].providers[id].sortIndex = sortIndex;
      }
    });

    const success = this._writeProviders(data);

    if (success) {
      console.log(`[ProviderService] 更新排序成功: ${updates.length} 个供应商`);
    }

    return success;
  }

  // ============================================
  // 用量查询
  // ============================================

  /**
   * 设置供应商的用量查询脚本
   * @param {string} appType
   * @param {string} providerId
   * @param {string} script - Shell 脚本内容
   * @returns {boolean}
   */
  setUsageScript(appType, providerId, script) {
    const data = this._readProviders();
    const provider = data[appType]?.providers[providerId];

    if (!provider) {
      return false;
    }

    if (!provider.meta) {
      provider.meta = {};
    }

    provider.meta.usageScript = script;
    provider.updatedAt = Date.now();

    const success = this._writeProviders(data);
    if (success) {
      console.log(`[ProviderService] 设置用量脚本成功: ${provider.name}`);
      this._emit('provider:updated', { appType, id: providerId, provider });
    }

    return success;
  }

  /**
   * 获取供应商的用量查询脚本
   * @param {string} appType
   * @param {string} providerId
   * @returns {string|null}
   */
  getUsageScript(appType, providerId) {
    const provider = this.getById(appType, providerId);
    return provider?.meta?.usageScript || null;
  }

  /**
   * 执行用量查询脚本
   * @param {string} appType
   * @param {string} providerId
   * @returns {Promise<Object>}
   */
  async queryUsage(appType, providerId) {
    const provider = this.getById(appType, providerId);
    if (!provider) {
      throw new Error('供应商不存在');
    }

    const script = provider.meta?.usageScript;
    if (!script) {
      throw new Error('未配置用量查询脚本');
    }

    // 动态导入 child_process
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      // 设置环境变量，供脚本使用
      const env = {
        ...process.env,
        PROVIDER_ID: providerId,
        PROVIDER_NAME: provider.name,
        API_TYPE: provider.settingsConfig?.apiType || 'openai'
      };

      // 根据 API 类型设置对应的环境变量
      const apiType = provider.settingsConfig?.apiType || 'openai';
      if (apiType === 'openai' && provider.settingsConfig?.openai) {
        env.API_URL = provider.settingsConfig.openai.apiUrl || '';
        env.API_KEY = provider.settingsConfig.openai.apiKey || '';
        env.MODEL = provider.settingsConfig.openai.model || '';
      } else if (apiType === 'claude' && provider.settingsConfig?.claude) {
        env.API_URL = provider.settingsConfig.claude.apiUrl || '';
        env.API_KEY = provider.settingsConfig.claude.apiKey || '';
        env.MODEL = provider.settingsConfig.claude.model || '';
      }

      // 执行脚本（超时 30 秒）
      const { stdout, stderr } = await execAsync(script, {
        env,
        timeout: 30000,
        shell: '/bin/bash'
      });

      // 尝试解析 JSON 输出
      let result;
      try {
        result = JSON.parse(stdout.trim());
      } catch {
        // 如果不是 JSON，返回原始输出
        result = {
          raw: stdout.trim(),
          stderr: stderr.trim() || undefined
        };
      }

      return {
        success: true,
        providerId,
        providerName: provider.name,
        result,
        queriedAt: Date.now()
      };
    } catch (error) {
      return {
        success: false,
        providerId,
        providerName: provider.name,
        error: error.message,
        queriedAt: Date.now()
      };
    }
  }
}

export default ProviderService;
