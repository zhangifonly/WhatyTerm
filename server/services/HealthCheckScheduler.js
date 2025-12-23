import ProviderService from './ProviderService.js';
import ProviderHealthCheck from './ProviderHealthCheck.js';
import ConfigService from './ConfigService.js';

/**
 * 定时健康检查调度器
 * 后台自动定期检查所有供应商的健康状态
 */
class HealthCheckScheduler {
  constructor(io = null) {
    this.providerService = new ProviderService(io);
    this.healthCheck = new ProviderHealthCheck();
    this.configService = new ConfigService();
    this.io = io;
    this.timer = null;
    this.config = null;
    this.isRunning = false;
  }

  /**
   * 加载配置
   */
  async loadConfig() {
    try {
      await this.configService.loadConfig();
      this.config = this.configService.getSchedulerConfig();
      console.log('[HealthCheckScheduler] 配置加载成功:', this.config);
    } catch (err) {
      console.error('[HealthCheckScheduler] 加载配置失败:', err);
      this.config = {
        enabled: false,
        intervalMinutes: 30,
        checkOnStartup: true,
        notifyOnFailure: false
      };
    }
  }

  /**
   * 启动调度器
   */
  async start() {
    // 加载配置
    await this.loadConfig();

    if (!this.config.enabled) {
      console.log('[HealthCheckScheduler] 定时检查未启用');
      return;
    }

    if (this.isRunning) {
      console.log('[HealthCheckScheduler] 调度器已在运行');
      return;
    }

    this.isRunning = true;
    console.log(`[HealthCheckScheduler] 启动定时检查，间隔: ${this.config.intervalMinutes} 分钟`);

    // 启动时立即检查
    if (this.config.checkOnStartup) {
      console.log('[HealthCheckScheduler] 执行启动时检查');
      this.runCheck().catch(err => {
        console.error('[HealthCheckScheduler] 启动时检查失败:', err);
      });
    }

    // 设置定时器
    const intervalMs = this.config.intervalMinutes * 60 * 1000;
    this.timer = setInterval(() => {
      this.runCheck().catch(err => {
        console.error('[HealthCheckScheduler] 定时检查失败:', err);
      });
    }, intervalMs);

    console.log('[HealthCheckScheduler] 调度器已启动');
  }

  /**
   * 停止调度器
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.isRunning = false;
      console.log('[HealthCheckScheduler] 调度器已停止');
    }
  }

  /**
   * 重启调度器（配置更新后调用）
   */
  async restart() {
    console.log('[HealthCheckScheduler] 重启调度器');
    this.stop();
    await this.start();
  }

  /**
   * 执行健康检查
   */
  async runCheck() {
    const startTime = Date.now();
    console.log('[HealthCheckScheduler] 开始批量健康检查');

    const results = {
      total: 0,
      success: 0,
      degraded: 0,
      failed: 0,
      details: []
    };

    // 检查所有应用类型
    const appTypes = ['claude', 'codex', 'gemini'];

    for (const appType of appTypes) {
      try {
        const data = this.providerService.list(appType);
        const providers = Object.values(data.providers);

        if (providers.length === 0) {
          continue;
        }

        console.log(`[HealthCheckScheduler] 检查 ${appType} 供应商，共 ${providers.length} 个`);

        for (const provider of providers) {
          results.total++;

          try {
            const result = await this.healthCheck.checkWithRetry(appType, provider);

            // 保存日志
            this.healthCheck.saveLog(appType, provider.id, provider.name, result);

            // 统计结果
            if (result.success) {
              if (result.status === 'degraded') {
                results.degraded++;
              } else {
                results.success++;
              }
            } else {
              results.failed++;
            }

            results.details.push({
              appType,
              id: provider.id,
              name: provider.name,
              result
            });
          } catch (error) {
            results.failed++;
            results.details.push({
              appType,
              id: provider.id,
              name: provider.name,
              result: {
                status: 'failed',
                success: false,
                message: error.message,
                testedAt: Date.now()
              }
            });
          }
        }
      } catch (error) {
        console.error(`[HealthCheckScheduler] 检查 ${appType} 时发生错误:`, error);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[HealthCheckScheduler] 批量检查完成，耗时 ${duration}ms`);
    console.log(`[HealthCheckScheduler] 结果: 总计 ${results.total}, 成功 ${results.success}, 降级 ${results.degraded}, 失败 ${results.failed}`);

    // 失败时通知
    if (this.config.notifyOnFailure && results.failed > 0) {
      this.notifyFailures(results);
    }

    // 通过 Socket.IO 推送结果
    if (this.io) {
      this.io.emit('health-check:scheduled', {
        timestamp: Date.now(),
        results
      });
    }

    return results;
  }

  /**
   * 发送失败通知
   */
  notifyFailures(results) {
    const failures = results.details.filter(d => !d.result.success);

    if (failures.length === 0) {
      return;
    }

    console.log(`[HealthCheckScheduler] 发现 ${failures.length} 个供应商健康检查失败`);

    // 通过 Socket.IO 发送通知
    if (this.io) {
      this.io.emit('notification', {
        type: 'health-check-failure',
        title: '供应商健康检查失败',
        message: `${failures.length} 个供应商健康检查失败`,
        failures: failures.map(f => ({
          name: f.name,
          error: f.result.message
        })),
        timestamp: Date.now()
      });
    }
  }

  /**
   * 检查单个供应商
   * @param {string} appType - 应用类型
   * @param {string} providerId - 供应商 ID
   * @returns {Promise<Object>} 检查结果
   */
  async checkSingleProvider(appType, providerId) {
    try {
      const provider = this.providerService.getById(appType, providerId);
      if (!provider) {
        return {
          status: 'failed',
          success: false,
          message: '供应商不存在',
          testedAt: Date.now()
        };
      }

      const result = await this.healthCheck.checkWithRetry(appType, provider);

      // 保存日志
      this.healthCheck.saveLog(appType, provider.id, provider.name, result);

      return result;
    } catch (error) {
      console.error(`[HealthCheckScheduler] 检查单个供应商失败:`, error);
      return {
        status: 'failed',
        success: false,
        message: error.message,
        testedAt: Date.now()
      };
    }
  }

  /**
   * 获取调度器状态
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      config: this.config,
      nextCheckIn: this.timer ? this.config.intervalMinutes * 60 * 1000 : null
    };
  }
}

export default HealthCheckScheduler;
