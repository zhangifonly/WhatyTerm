import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import crypto from 'crypto';
import { HEALTH_CHECK_MODELS, CLAUDE_CODE_FAKE, CODEX_FAKE, GEMINI_FAKE, CLAUDE_MODEL_FALLBACK_LIST } from '../config/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Provider 健康检查服务
 * 基于 cc-switch StreamCheckService 设计
 */
export class ProviderHealthCheck {
  constructor(config = {}) {
    this.configFile = path.join(__dirname, '../db/provider-config.json');
    this.logsFile = path.join(__dirname, '../db/provider-check-logs.json');

    // 默认配置
    this.config = {
      timeoutSecs: config.timeoutSecs || 45,
      maxRetries: config.maxRetries || 2,
      degradedThresholdMs: config.degradedThresholdMs || 6000,
      testModels: config.testModels || {
        claude: HEALTH_CHECK_MODELS.claude,
        codex: 'gpt-5.1-codex@low',
        gemini: 'gemini-3-pro-preview'
      }
    };

    // 从配置文件加载
    this._loadConfig();
  }

  // ============================================
  // 配置管理
  // ============================================

  _loadConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const data = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
        if (data.healthCheck) {
          Object.assign(this.config, data.healthCheck);
        }
      }
    } catch (error) {
      console.error('[ProviderHealthCheck] 加载配置失败:', error);
    }
  }

  saveConfig(newConfig) {
    try {
      const data = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      data.healthCheck = { ...this.config, ...newConfig };
      fs.writeFileSync(this.configFile, JSON.stringify(data, null, 2), 'utf8');
      Object.assign(this.config, newConfig);
      return true;
    } catch (error) {
      console.error('[ProviderHealthCheck] 保存配置失败:', error);
      return false;
    }
  }

  getConfig() {
    return this.config;
  }

  // ============================================
  // 健康检查核心逻辑
  // ============================================

  /**
   * 执行健康检查（带重试）
   * @param {string} appType - 'claude' | 'codex' | 'gemini'
   * @param {Object} provider - 供应商配置
   * @returns {Promise<Object>} 检查结果
   */
  async checkWithRetry(appType, provider) {
    let lastResult = null;
    let lastError = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const result = await this.checkOnce(appType, provider);

        if (result.success) {
          return { ...result, retryCount: attempt };
        }

        // 失败但非异常，判断是否重试
        if (this.shouldRetry(result.message) && attempt < this.config.maxRetries) {
          lastResult = result;
          continue;
        }

        return { ...result, retryCount: attempt };
      } catch (error) {
        lastError = error;

        if (this.shouldRetry(error.message) && attempt < this.config.maxRetries) {
          continue;
        }

        throw error;
      }
    }

    // 所有重试都失败
    if (lastResult) {
      return { ...lastResult, retryCount: this.config.maxRetries };
    }

    throw lastError || new Error('检查失败');
  }

  /**
   * 单次健康检查
   * @param {string} appType
   * @param {Object} provider
   * @returns {Promise<Object>}
   */
  async checkOnce(appType, provider) {
    const startTime = Date.now();
    const testModel = this.config.testModels[appType];

    try {
      let result;

      switch (appType) {
        case 'claude':
          result = await this._checkClaudeStream(provider, testModel);
          break;
        case 'codex':
          result = await this._checkCodexStream(provider, testModel);
          break;
        case 'gemini':
          result = await this._checkGeminiStream(provider, testModel);
          break;
        default:
          throw new Error(`不支持的应用类型: ${appType}`);
      }

      const responseTime = Date.now() - startTime;
      const status = this._determineStatus(responseTime);

      return {
        status,
        success: true,
        message: '检查成功',
        responseTimeMs: responseTime,
        httpStatus: result.statusCode,
        modelUsed: testModel,
        testedAt: Date.now(),
        retryCount: 0
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      return {
        status: 'failed',
        success: false,
        message: error.message,
        responseTimeMs: responseTime,
        httpStatus: null,
        modelUsed: testModel,
        testedAt: Date.now(),
        retryCount: 0
      };
    }
  }

  /**
   * Claude 流式检查（统一使用 Claude Code 伪装模式）
   */
  async _checkClaudeStream(provider, model) {
    // 兼容两种配置格式：
    // 1. settingsConfig.claude.apiUrl / apiKey（旧格式）
    // 2. settingsConfig.env.ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY（CC-Switch 格式）
    let apiUrl, apiKey;

    const claudeConfig = provider.settingsConfig?.claude;
    const envConfig = provider.settingsConfig?.env;

    if (claudeConfig?.apiUrl && claudeConfig?.apiKey) {
      // 旧格式
      apiUrl = claudeConfig.apiUrl;
      apiKey = claudeConfig.apiKey;
    } else if (envConfig?.ANTHROPIC_BASE_URL && (envConfig?.ANTHROPIC_API_KEY || envConfig?.ANTHROPIC_AUTH_TOKEN)) {
      // CC-Switch 格式（支持 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN）
      apiUrl = envConfig.ANTHROPIC_BASE_URL;
      apiKey = envConfig.ANTHROPIC_API_KEY || envConfig.ANTHROPIC_AUTH_TOKEN;
    } else {
      throw new Error('Claude 配置不完整（需要 apiUrl/apiKey 或 ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN）');
    }

    // 规范化 API URL：确保以 /v1/messages 结尾
    let normalizedUrl = apiUrl;
    if (!apiUrl.endsWith('/v1/messages')) {
      apiUrl = apiUrl.replace(/\/+$/, '');
      if (!apiUrl.endsWith('/v1')) {
        apiUrl = `${apiUrl}/v1/messages`;
      } else {
        apiUrl = `${apiUrl}/messages`;
      }
    }
    const url = apiUrl;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutSecs * 1000
    );

    // 生成伪装的 metadata.user_id
    const userHash = crypto.randomBytes(32).toString('hex');
    const sessionUuid = crypto.randomUUID();
    const fakeUserId = `user_${userHash}_account__session_${sessionUuid}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': CLAUDE_CODE_FAKE.userAgent,
          'x-app': CLAUDE_CODE_FAKE.headers['x-app'],
          'anthropic-beta': CLAUDE_CODE_FAKE.headers['anthropic-beta'],
          'anthropic-version': CLAUDE_CODE_FAKE.headers['anthropic-version'],
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 1,
          system: [{ type: 'text', text: CLAUDE_CODE_FAKE.systemPrompt }],
          messages: [{ role: 'user', content: 'hi' }],
          metadata: { user_id: fakeUserId },
          stream: true
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // 流式读取：只需首个 chunk
      const reader = response.body.getReader();
      const { value } = await reader.read();
      reader.releaseLock();

      if (!value) {
        throw new Error('未收到响应数据');
      }

      return { statusCode: response.status };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Codex/OpenAI 流式检查
   */
  async _checkCodexStream(provider, model) {
    // 判断使用 openai 还是 codex 配置
    const config = provider.settingsConfig.openai || provider.settingsConfig.codex;

    if (!config || !config.apiUrl || !config.apiKey) {
      throw new Error('OpenAI/Codex 配置不完整');
    }

    const url = config.apiUrl;
    // 判断是否使用 Responses API（URL 以 /responses 结尾）
    const isResponsesApi = url.endsWith('/responses');

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutSecs * 1000
    );

    try {
      // 解析模型名和推理等级 (支持 model@level 或 model#level 格式)
      const { actualModel, reasoningEffort } = this._parseModelWithEffort(model);

      let body;
      let headers = {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      };

      if (isResponsesApi) {
        // Codex Responses API 格式（使用正确的 input 数组格式）
        body = {
          model: actualModel,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: 'hi' }
              ]
            }
          ],
          stream: false  // Responses API 健康检查用非流式更简单
        };
        // 添加 Codex CLI 伪装头
        headers['User-Agent'] = CODEX_FAKE.userAgent;
        headers['openai-beta'] = 'responses';
      } else {
        // OpenAI Chat Completions API 格式
        body = {
          model: actualModel,
          messages: [
            { role: 'system', content: '' },
            { role: 'assistant', content: '' },
            { role: 'user', content: 'hi' }
          ],
          max_tokens: 1,
          temperature: 0,
          stream: true
        };
        // 如果是推理模型，添加 reasoning_effort
        if (reasoningEffort) {
          body.reasoning_effort = reasoningEffort;
        }
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      if (isResponsesApi) {
        // Responses API：读取完整响应或 SSE 流的第一个事件
        const responseText = await response.text();
        if (!responseText) {
          throw new Error('未收到响应数据');
        }
      } else {
        // Chat Completions API：流式读取，只需首个 chunk
        const reader = response.body.getReader();
        const { value } = await reader.read();
        reader.releaseLock();
        if (!value) {
          throw new Error('未收到响应数据');
        }
      }

      return { statusCode: response.status };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Gemini 流式检查
   */
  async _checkGeminiStream(provider, model) {
    const config = provider.settingsConfig.gemini;

    if (!config || !config.apiKey) {
      throw new Error('Gemini 配置不完整');
    }

    const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';
    const url = `${baseUrl}/v1/chat/completions`;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutSecs * 1000
    );

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': GEMINI_FAKE.userAgent
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          temperature: 0,
          stream: true
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // 流式读取：只需首个 chunk
      const reader = response.body.getReader();
      const { value } = await reader.read();
      reader.releaseLock();

      if (!value) {
        throw new Error('未收到响应数据');
      }

      return { statusCode: response.status };
    } finally {
      clearTimeout(timeout);
    }
  }

  // ============================================
  // 辅助方法
  // ============================================

  /**
   * 解析模型名和推理等级
   * @param {string} model - 'model@level' 或 'model#level' 格式
   * @returns {{ actualModel: string, reasoningEffort: string|null }}
   */
  _parseModelWithEffort(model) {
    const separatorIndex = model.search(/[@#]/);

    if (separatorIndex === -1) {
      return { actualModel: model, reasoningEffort: null };
    }

    const actualModel = model.substring(0, separatorIndex);
    const effort = model.substring(separatorIndex + 1);

    return {
      actualModel,
      reasoningEffort: effort || null
    };
  }

  /**
   * 判定健康状态
   * @param {number} latencyMs
   * @returns {'operational'|'degraded'|'failed'}
   */
  _determineStatus(latencyMs) {
    if (latencyMs <= this.config.degradedThresholdMs) {
      return 'operational';
    } else {
      return 'degraded';
    }
  }

  /**
   * 判断是否应该重试
   * @param {string} message
   * @returns {boolean}
   */
  shouldRetry(message) {
    const lower = message.toLowerCase();
    return (
      lower.includes('timeout') ||
      lower.includes('abort') ||
      lower.includes('中断') ||
      lower.includes('超时')
    );
  }

  // ============================================
  // 日志管理
  // ============================================

  /**
   * 保存检查日志
   * @param {string} appType
   * @param {string} providerId
   * @param {string} providerName
   * @param {Object} result
   */
  saveLog(appType, providerId, providerName, result) {
    try {
      const logs = this._readLogs();

      const logEntry = {
        id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        appType,
        providerId,
        providerName,
        ...result
      };

      logs.push(logEntry);

      // 只保留最近 1000 条日志
      if (logs.length > 1000) {
        logs.splice(0, logs.length - 1000);
      }

      fs.writeFileSync(this.logsFile, JSON.stringify(logs, null, 2), 'utf8');

      return true;
    } catch (error) {
      console.error('[ProviderHealthCheck] 保存日志失败:', error);
      return false;
    }
  }

  /**
   * 读取检查日志
   * @param {Object} filters - { appType?, providerId?, limit? }
   * @returns {Array}
   */
  getLogs(filters = {}) {
    let logs = this._readLogs();

    // 过滤
    if (filters.appType) {
      logs = logs.filter(log => log.appType === filters.appType);
    }

    if (filters.providerId) {
      logs = logs.filter(log => log.providerId === filters.providerId);
    }

    // 限制数量
    if (filters.limit) {
      logs = logs.slice(-filters.limit);
    }

    return logs.reverse(); // 最新的在前面
  }

  _readLogs() {
    try {
      const data = fs.readFileSync(this.logsFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return [];
    }
  }

  // ============================================
  // 端点测速
  // ============================================

  /**
   * 测试多个端点，返回每个端点的响应时间
   * @param {string} appType - 应用类型
   * @param {Object} provider - 供应商配置
   * @param {Array} endpoints - 端点 URL 列表
   * @returns {Promise<Array>} - 测试结果数组
   */
  async speedTestEndpoints(appType, provider, endpoints) {
    if (!endpoints || endpoints.length === 0) {
      return [];
    }

    const results = [];

    for (const endpoint of endpoints) {
      const result = await this._testSingleEndpoint(appType, provider, endpoint);
      results.push(result);
    }

    // 按延迟排序（成功的在前，失败的在后）
    results.sort((a, b) => {
      if (a.success && !b.success) return -1;
      if (!a.success && b.success) return 1;
      return (a.latencyMs || Infinity) - (b.latencyMs || Infinity);
    });

    return results;
  }

  /**
   * 测试单个端点
   * @param {string} appType
   * @param {Object} provider
   * @param {string} endpointUrl
   * @returns {Promise<Object>}
   */
  async _testSingleEndpoint(appType, provider, endpointUrl) {
    const startTime = Date.now();

    try {
      // 创建临时 provider 配置，使用指定的端点
      const testProvider = JSON.parse(JSON.stringify(provider));
      const apiType = testProvider.settingsConfig?.apiType || 'openai';

      if (apiType === 'openai' && testProvider.settingsConfig?.openai) {
        testProvider.settingsConfig.openai.apiUrl = endpointUrl;
      } else if (apiType === 'claude') {
        // 兼容两种格式
        if (testProvider.settingsConfig?.claude) {
          testProvider.settingsConfig.claude.apiUrl = endpointUrl;
        } else if (testProvider.settingsConfig?.env) {
          testProvider.settingsConfig.env.ANTHROPIC_BASE_URL = endpointUrl;
        }
      }

      // 执行健康检查
      const result = await this.checkOnce(appType, testProvider);
      const latencyMs = Date.now() - startTime;

      return {
        url: endpointUrl,
        success: result.success,
        latencyMs,
        status: result.status,
        httpStatus: result.httpStatus,
        message: result.message,
        testedAt: Date.now()
      };
    } catch (error) {
      return {
        url: endpointUrl,
        success: false,
        latencyMs: Date.now() - startTime,
        status: 'failed',
        message: error.message,
        testedAt: Date.now()
      };
    }
  }

  /**
   * 测试端点并返回最快的一个
   * @param {string} appType
   * @param {Object} provider
   * @param {Array} endpoints
   * @returns {Promise<Object|null>}
   */
  async findFastestEndpoint(appType, provider, endpoints) {
    const results = await this.speedTestEndpoints(appType, provider, endpoints);

    // 找到第一个成功的（已按延迟排序）
    const fastest = results.find(r => r.success);

    return fastest || null;
  }

  // ============================================
  // 多模型测试
  // ============================================

  /**
   * 测试多个模型，返回可用模型列表
   * @param {string} appType - 应用类型 ('claude' | 'codex' | 'gemini')
   * @param {Object} provider - 供应商配置
   * @param {Array} models - 要测试的模型列表（可选，默认使用 CLAUDE_MODEL_FALLBACK_LIST）
   * @returns {Promise<Object>} - { availableModels: [], failedModels: [], firstAvailable: string|null }
   */
  async testMultipleModels(appType, provider, models = null) {
    // 根据 appType 获取默认模型列表
    let modelsToTest = models;
    if (!modelsToTest) {
      if (appType === 'claude') {
        modelsToTest = CLAUDE_MODEL_FALLBACK_LIST;
      } else {
        // 其他类型暂时只测试配置的模型
        modelsToTest = [this.config.testModels[appType]];
      }
    }

    const availableModels = [];
    const failedModels = [];
    let firstAvailable = null;

    console.log(`[ProviderHealthCheck] 开始测试 ${modelsToTest.length} 个模型...`);

    for (const model of modelsToTest) {
      try {
        console.log(`[ProviderHealthCheck] 测试模型: ${model}`);
        const result = await this._testSingleModel(appType, provider, model);

        if (result.success) {
          availableModels.push({
            model,
            responseTimeMs: result.responseTimeMs,
            status: result.status
          });
          if (!firstAvailable) {
            firstAvailable = model;
          }
          console.log(`[ProviderHealthCheck] 模型 ${model} 可用 (${result.responseTimeMs}ms)`);
        } else {
          failedModels.push({
            model,
            error: result.message
          });
          console.log(`[ProviderHealthCheck] 模型 ${model} 不可用: ${result.message}`);
        }
      } catch (error) {
        failedModels.push({
          model,
          error: error.message
        });
        console.log(`[ProviderHealthCheck] 模型 ${model} 测试异常: ${error.message}`);
      }
    }

    return {
      availableModels,
      failedModels,
      firstAvailable,
      testedAt: Date.now()
    };
  }

  /**
   * 测试单个模型
   * @param {string} appType
   * @param {Object} provider
   * @param {string} model
   * @returns {Promise<Object>}
   */
  async _testSingleModel(appType, provider, model) {
    const startTime = Date.now();

    try {
      let result;

      switch (appType) {
        case 'claude':
          result = await this._checkClaudeStream(provider, model);
          break;
        case 'codex':
          result = await this._checkCodexStream(provider, model);
          break;
        case 'gemini':
          result = await this._checkGeminiStream(provider, model);
          break;
        default:
          throw new Error(`不支持的应用类型: ${appType}`);
      }

      const responseTime = Date.now() - startTime;
      const status = this._determineStatus(responseTime);

      return {
        success: true,
        message: '测试成功',
        responseTimeMs: responseTime,
        httpStatus: result.statusCode,
        status
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
        responseTimeMs: Date.now() - startTime
      };
    }
  }
}

export default ProviderHealthCheck;
