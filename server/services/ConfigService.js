import fs from 'fs/promises';
import path from 'path';
import { HEALTH_CHECK_MODELS } from '../config/constants.js';

/**
 * 配置管理服务
 * 管理故障转移、定时检查等高级配置
 */
class ConfigService {
  constructor() {
    this.configDir = path.join(process.cwd(), 'server', 'config');
    this.configFile = path.join(this.configDir, 'advanced-settings.json');
    this.defaultConfig = {
      healthCheck: {
        timeoutSecs: 45,
        maxRetries: 2,
        degradedThresholdMs: 6000,
        testModels: {
          claude: HEALTH_CHECK_MODELS.claude,
          codex: HEALTH_CHECK_MODELS.openai,
          gemini: 'gemini-2.0-flash'
        }
      },
      failover: {
        enabled: false,
        maxRetries: 3,
        retryDelayMs: 5000,
        fallbackOrder: [],
        excludeFromFailover: []
      },
      scheduler: {
        enabled: false,
        intervalMinutes: 30,
        checkOnStartup: true,
        notifyOnFailure: false
      },
      memoryLimit: {
        enabled: false,              // 是否启用内存限制
        limitMB: 1024,               // MB，超过此值触发限制
        warningMB: 512,              // MB，超过此值显示警告
        autoKillOnLimit: false,      // 超限时是否自动杀进程
        pauseAutoActionOnLimit: true // 超限时暂停自动操作
      }
    };
    this.config = { ...this.defaultConfig };
  }

  // 确保配置目录存在
  async ensureConfigDir() {
    try {
      await fs.mkdir(this.configDir, { recursive: true });
    } catch (err) {
      console.error('[ConfigService] 创建配置目录失败:', err);
    }
  }

  // 加载配置
  async loadConfig() {
    try {
      await this.ensureConfigDir();
      const data = await fs.readFile(this.configFile, 'utf-8');
      const loaded = JSON.parse(data);

      // 合并默认配置和加载的配置
      this.config = {
        healthCheck: { ...this.defaultConfig.healthCheck, ...loaded.healthCheck },
        failover: { ...this.defaultConfig.failover, ...loaded.failover },
        scheduler: { ...this.defaultConfig.scheduler, ...loaded.scheduler },
        memoryLimit: { ...this.defaultConfig.memoryLimit, ...loaded.memoryLimit }
      };

      console.log('[ConfigService] 配置加载成功');
      return this.config;
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('[ConfigService] 配置文件不存在，使用默认配置');
        await this.saveConfig();
      } else {
        console.error('[ConfigService] 加载配置失败:', err);
      }
      return this.config;
    }
  }

  // 保存配置
  async saveConfig() {
    try {
      await this.ensureConfigDir();
      await fs.writeFile(
        this.configFile,
        JSON.stringify(this.config, null, 2),
        'utf-8'
      );
      console.log('[ConfigService] 配置保存成功');
      return true;
    } catch (err) {
      console.error('[ConfigService] 保存配置失败:', err);
      return false;
    }
  }

  // 获取健康检查配置
  getHealthCheckConfig() {
    return this.config.healthCheck;
  }

  // 更新健康检查配置
  async updateHealthCheckConfig(updates) {
    this.config.healthCheck = {
      ...this.config.healthCheck,
      ...updates
    };
    await this.saveConfig();
    return this.config.healthCheck;
  }

  // 获取故障转移配置
  getFailoverConfig() {
    return this.config.failover;
  }

  // 更新故障转移配置
  async updateFailoverConfig(updates) {
    this.config.failover = {
      ...this.config.failover,
      ...updates
    };
    await this.saveConfig();
    return this.config.failover;
  }

  // 获取定时检查配置
  getSchedulerConfig() {
    return this.config.scheduler;
  }

  // 更新定时检查配置
  async updateSchedulerConfig(updates) {
    this.config.scheduler = {
      ...this.config.scheduler,
      ...updates
    };
    await this.saveConfig();
    return this.config.scheduler;
  }

  // 获取内存限制配置
  getMemoryLimitConfig() {
    return this.config.memoryLimit;
  }

  // 更新内存限制配置
  async updateMemoryLimitConfig(updates) {
    this.config.memoryLimit = {
      ...this.config.memoryLimit,
      ...updates
    };
    await this.saveConfig();
    return this.config.memoryLimit;
  }

  // 重置为默认配置
  async resetConfig() {
    this.config = { ...this.defaultConfig };
    await this.saveConfig();
    return this.config;
  }
}

// 导出单例实例
const configService = new ConfigService();
export default configService;
