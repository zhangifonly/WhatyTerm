import ProviderService from '../services/ProviderService.js';
import ProviderHealthCheck from '../services/ProviderHealthCheck.js';
import ConfigService from '../services/ConfigService.js';
import { getTerminalRecorder } from '../services/TerminalRecorder.js';
import presets from '../config/providerPresets.js';
import dependencyManager from '../services/DependencyManager.js';
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import { CLAUDE_CODE_FAKE } from '../config/constants.js';

export function setupRoutes(app, sessionManager, historyLogger, io = null, aiEngine = null, healthCheckScheduler = null) {
  // 初始化服务
  const providerService = new ProviderService(io);
  const healthCheck = new ProviderHealthCheck();
  const configService = new ConfigService();

  // 启动时执行迁移（仅首次）
  providerService.migrateFromOldSettings();

  // 启动时加载配置
  configService.loadConfig().catch(err => {
    console.error('[Routes] 加载配置失败:', err);
  });

  // 获取会话列表
  app.get('/api/sessions', (req, res) => {
    const sessions = sessionManager.listSessions();
    res.json(sessions);
  });

  // 获取单个会话
  app.get('/api/sessions/:id', (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: '会话不存在' });
    }
    res.json(session.toJSON());
  });

  // 删除会话
  app.delete('/api/sessions/:id', (req, res) => {
    const deleted = sessionManager.deleteSession(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: '会话不存在' });
    }
    res.json({ success: true });
  });

  // 获取会话历史
  app.get('/api/sessions/:id/history', (req, res) => {
    const { limit = 100, offset = 0, type } = req.query;

    let history;
    if (type) {
      history = historyLogger.getHistoryByType(req.params.id, type, parseInt(limit));
    } else {
      history = historyLogger.getHistory(req.params.id, parseInt(limit), parseInt(offset));
    }

    res.json(history);
  });

  // 搜索历史
  app.get('/api/sessions/:id/history/search', (req, res) => {
    const { q, limit = 50 } = req.query;
    if (!q) {
      return res.status(400).json({ error: '缺少搜索关键词' });
    }

    const results = historyLogger.searchHistory(req.params.id, q, parseInt(limit));
    res.json(results);
  });

  // 获取所有 AI 操作日志
  app.get('/api/ai-logs', (req, res) => {
    const { limit = 500 } = req.query;
    const logs = historyLogger.getAllAiLogs(parseInt(limit));
    res.json(logs);
  });

  // ========== 终端回放 API ==========

  // 获取会话录制时间范围
  app.get('/api/sessions/:id/recordings/range', (req, res) => {
    const recorder = getTerminalRecorder();
    const range = recorder.getTimeRange(req.params.id);
    if (!range) {
      return res.json({ hasRecordings: false });
    }
    res.json({ hasRecordings: true, ...range });
  });

  // 获取会话录制数据
  app.get('/api/sessions/:id/recordings', (req, res) => {
    const { start, end, limit } = req.query;
    const recorder = getTerminalRecorder();
    const startTime = start ? parseInt(start) : 0;
    const endTime = end ? parseInt(end) : Date.now();
    const limitNum = limit ? parseInt(limit) : 0;
    const events = recorder.getRecordings(req.params.id, startTime, endTime, limitNum);
    res.json(events);
  });

  // 获取录制统计
  app.get('/api/recordings/stats', (req, res) => {
    const recorder = getTerminalRecorder();
    const stats = recorder.getStats();
    res.json(stats);
  });

  // 获取当前使用的 API 供应商（从 CC Switch 数据库读取）
  // 支持 claude 和 codex，通过 ?app=xxx 参数指定
  app.get('/api/current-provider', (req, res) => {
    try {
      const appType = req.query.app || 'claude'; // 默认 claude
      const ccSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

      // 检查数据库是否存在
      if (!fs.existsSync(ccSwitchDbPath)) {
        return res.json({
          name: '未配置',
          url: '',
          app: appType,
          exists: false
        });
      }

      const db = new Database(ccSwitchDbPath, { readonly: true });
      const row = db.prepare('SELECT * FROM providers WHERE app_type = ? AND is_current = 1').get(appType);
      db.close();

      if (!row) {
        return res.json({
          name: '未配置',
          url: '',
          app: appType,
          exists: false
        });
      }

      // 解析 settings_config 获取 API 地址
      let apiUrl = '';
      try {
        if (row.settings_config) {
          const config = JSON.parse(row.settings_config);

          if (appType === 'claude') {
            // Claude 使用 env.ANTHROPIC_BASE_URL
            apiUrl = config.env?.ANTHROPIC_BASE_URL || config.baseURL || '';
          } else if (appType === 'codex') {
            // Codex 使用 TOML 格式的 config 字段
            if (config.config) {
              // 从 TOML 中提取 base_url
              const baseUrlMatch = config.config.match(/base_url\s*=\s*"([^"]+)"/);
              if (baseUrlMatch) {
                apiUrl = baseUrlMatch[1];
              }
            }
          } else if (appType === 'gemini') {
            // Gemini CLI - 预留支持，待确认具体配置格式
            // 尝试多种可能的字段
            apiUrl = config.env?.GEMINI_API_BASE ||
                     config.env?.GOOGLE_API_BASE ||
                     config.baseURL ||
                     '';
            // 如果是 TOML 格式
            if (!apiUrl && config.config) {
              const baseUrlMatch = config.config.match(/(?:base_url|api_base)\s*=\s*"([^"]+)"/);
              if (baseUrlMatch) {
                apiUrl = baseUrlMatch[1];
              }
            }
          } else {
            // 其他应用类型尝试通用字段
            apiUrl = config.baseURL || config.env?.BASE_URL || '';
          }
        }
      } catch (parseError) {
        console.error(`[API] 解析 ${appType} settings_config 失败:`, parseError);
      }

      res.json({
        name: row.name || '未命名',
        url: apiUrl,
        app: appType,
        exists: true
      });
    } catch (error) {
      console.error('[API] 获取当前供应商失败:', error);
      res.status(500).json({
        error: '获取供应商信息失败',
        name: '错误',
        url: '',
        exists: false
      });
    }
  });

  /**
   * GET /api/ccswitch/providers
   * 获取 CC Switch 数据库中的所有供应商（claude/codex/gemini）
   */
  app.get('/api/ccswitch/providers', (req, res) => {
    try {
      const ccSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

      if (!fs.existsSync(ccSwitchDbPath)) {
        return res.json({ providers: [], error: 'CC Switch 数据库不存在' });
      }

      const db = new Database(ccSwitchDbPath, { readonly: true });
      const rows = db.prepare('SELECT * FROM providers ORDER BY app_type, sort_index, created_at').all();
      db.close();

      // 转换数据格式
      const providers = rows.map(row => {
        let settingsConfig = {};
        try {
          if (row.settings_config) {
            settingsConfig = JSON.parse(row.settings_config);
          }
        } catch (e) {
          console.error('[API] 解析 settings_config 失败:', e);
        }

        return {
          id: row.id,
          name: row.name,
          appType: row.app_type,
          isCurrent: row.is_current === 1,
          settingsConfig,
          category: row.category,
          sortIndex: row.sort_index,
          createdAt: row.created_at
        };
      });

      res.json({ providers });
    } catch (error) {
      console.error('[API] 获取 CC Switch 供应商失败:', error);
      res.status(500).json({ providers: [], error: error.message });
    }
  });

  // 创建分享链接
  app.post('/api/sessions/:id/share', (req, res) => {
    const token = historyLogger.createShareToken(req.params.id);
    res.json({
      token,
      url: `/share/${token}`
    });
  });

  // 通过分享链接访问
  app.get('/api/share/:token', (req, res) => {
    const meta = historyLogger.getSessionByShareToken(req.params.token);
    if (!meta) {
      return res.status(404).json({ error: '分享链接无效或已过期' });
    }

    const history = historyLogger.getHistory(meta.id, 1000);
    res.json({
      session: meta,
      history
    });
  });

  // 导出历史
  app.get('/api/sessions/:id/export', (req, res) => {
    const history = historyLogger.getHistory(req.params.id, 10000);
    const session = sessionManager.getSession(req.params.id);

    const exportData = {
      session: session ? session.toJSON() : { id: req.params.id },
      history,
      exportedAt: new Date().toISOString()
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="session-${req.params.id}.json"`);
    res.json(exportData);
  });

  // 测试 AI API 连接
  app.post('/api/ai/test', async (req, res) => {
    const { type, config } = req.body;
    const startTime = Date.now();

    try {
      if (type === 'openai') {
        // 测试 OpenAI 兼容 API
        const response = await fetch(config.apiUrl || 'https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {})
          },
          body: JSON.stringify({
            model: config.model || 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 10,
            stream: false
          }),
          signal: AbortSignal.timeout(15000)
        });

        const latency = Date.now() - startTime;

        if (!response.ok) {
          const errorText = await response.text();
          let errorMsg = `HTTP ${response.status}`;
          try {
            const errorJson = JSON.parse(errorText);
            errorMsg = errorJson.error?.message || errorJson.detail || errorText.slice(0, 100);
          } catch {
            errorMsg = errorText.slice(0, 100);
          }
          return res.json({ success: false, error: errorMsg, latency });
        }

        const data = await response.json();
        if (data.choices && data.choices[0]) {
          return res.json({ success: true, latency, model: data.model });
        } else {
          return res.json({ success: false, error: '响应格式错误', latency });
        }

      } else if (type === 'claude') {
        // 测试 Claude API（使用 Claude Code 伪装模式）
        // 规范化 API URL：确保以 /v1/messages 结尾
        let apiUrl = config.apiUrl || 'https://api.anthropic.com/v1/messages';
        if (!apiUrl.endsWith('/v1/messages')) {
          apiUrl = apiUrl.replace(/\/+$/, '');
          if (!apiUrl.endsWith('/v1')) {
            apiUrl = `${apiUrl}/v1/messages`;
          } else {
            apiUrl = `${apiUrl}/messages`;
          }
        }

        // 生成伪装的 metadata.user_id
        const userHash = crypto.randomBytes(32).toString('hex');
        const sessionUuid = crypto.randomUUID();
        const fakeUserId = `user_${userHash}_account__session_${sessionUuid}`;

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': CLAUDE_CODE_FAKE.userAgent,
            'x-app': CLAUDE_CODE_FAKE.headers['x-app'],
            'anthropic-beta': CLAUDE_CODE_FAKE.headers['anthropic-beta'],
            'anthropic-version': CLAUDE_CODE_FAKE.headers['anthropic-version'],
            'Authorization': `Bearer ${config.apiKey || ''}`
          },
          body: JSON.stringify({
            model: config.model || 'claude-sonnet-4-20250514',
            max_tokens: 10,
            system: [{ type: 'text', text: CLAUDE_CODE_FAKE.systemPrompt }],
            messages: [{ role: 'user', content: 'Hi' }],
            metadata: { user_id: fakeUserId }
          }),
          signal: AbortSignal.timeout(15000)
        });

        const latency = Date.now() - startTime;

        if (!response.ok) {
          const errorText = await response.text();
          let errorMsg = `HTTP ${response.status}`;
          try {
            const errorJson = JSON.parse(errorText);
            errorMsg = errorJson.error?.message || errorJson.detail || errorText.slice(0, 100);
          } catch {
            errorMsg = errorText.slice(0, 100);
          }
          return res.json({ success: false, error: errorMsg, latency });
        }

        const data = await response.json();
        if (data.content && data.content[0]) {
          return res.json({ success: true, latency, model: data.model });
        } else {
          return res.json({ success: false, error: '响应格式错误', latency });
        }

      } else {
        return res.json({ success: false, error: '不支持的 API 类型' });
      }
    } catch (err) {
      const latency = Date.now() - startTime;
      let errorMsg = err.message;
      if (err.name === 'TimeoutError' || err.code === 'ABORT_ERR') {
        errorMsg = '请求超时 (15s)';
      } else if (err.code === 'ECONNRESET') {
        errorMsg = '连接被重置';
      } else if (err.code === 'ENOTFOUND') {
        errorMsg = '无法解析域名';
      }
      return res.json({ success: false, error: errorMsg, latency });
    }
  });

  // ============================================
  // Provider 预设（必须在 :appType 路由之前）
  // ============================================

  /**
   * 获取所有预设
   * GET /api/providers/presets
   * Query: ?category=xxx
   */
  app.get('/api/providers/presets', (req, res) => {
    const { category } = req.query;

    if (category) {
      const filtered = presets.getPresetsByCategory(category);
      res.json(filtered);
    } else {
      res.json(presets.providerPresets);
    }
  });

  /**
   * 获取预设分类
   * GET /api/providers/presets/categories
   */
  app.get('/api/providers/presets/categories', (req, res) => {
    const categories = presets.getCategories();
    res.json(categories);
  });

  /**
   * 根据预设创建供应商
   * POST /api/providers/presets/:presetId/apply
   * Body: { apiKey?: string, templateVariables?: {}, appType?: 'claude'|'codex'|'gemini' }
   */
  app.post('/api/providers/presets/:presetId/apply', (req, res) => {
    const { presetId } = req.params;
    const { apiKey, templateVariables, appType = 'claude' } = req.body;

    const preset = presets.getPresetById(presetId);

    if (!preset) {
      return res.status(404).json({ error: '预设不存在' });
    }

    try {
      const provider = presets.createProviderFromPreset(preset, {
        apiKey,
        templateVariables
      });

      const success = providerService.add(appType, provider);

      if (success) {
        res.json({ success: true, provider });
      } else {
        res.status(500).json({ error: '添加供应商失败' });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // Provider 管理路由
  // ============================================

  /**
   * 获取所有供应商
   * GET /api/providers/:appType
   */
  app.get('/api/providers/:appType', (req, res) => {
    const { appType } = req.params;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    const data = providerService.list(appType);
    res.json(data);
  });

  /**
   * 获取当前供应商
   * GET /api/providers/:appType/current
   */
  app.get('/api/providers/:appType/current', (req, res) => {
    const { appType } = req.params;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    const provider = providerService.getCurrentProvider(appType);

    if (!provider) {
      return res.status(404).json({ error: '未配置供应商' });
    }

    res.json(provider);
  });

  /**
   * 添加供应商
   * POST /api/providers/:appType
   * Body: { provider: { name, settingsConfig, ... } }
   */
  app.post('/api/providers/:appType', (req, res) => {
    const { appType } = req.params;
    const { provider } = req.body;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    if (!provider || !provider.name || !provider.settingsConfig) {
      return res.status(400).json({ error: '缺少必要字段' });
    }

    const success = providerService.add(appType, provider);

    if (success) {
      res.json({ success: true, provider });
    } else {
      res.status(500).json({ error: '添加失败' });
    }
  });

  /**
   * 更新供应商
   * PUT /api/providers/:appType/:id
   * Body: { updates: { name?, settingsConfig?, ... } }
   */
  app.put('/api/providers/:appType/:id', (req, res) => {
    const { appType, id } = req.params;
    const { updates } = req.body;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    if (!updates) {
      return res.status(400).json({ error: '缺少更新数据' });
    }

    const success = providerService.update(appType, id, updates);

    if (success) {
      const provider = providerService.getById(appType, id);
      res.json({ success: true, provider });
    } else {
      res.status(500).json({ error: '更新失败' });
    }
  });

  /**
   * 删除供应商
   * DELETE /api/providers/:appType/:id
   */
  app.delete('/api/providers/:appType/:id', (req, res) => {
    const { appType, id } = req.params;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    const success = providerService.delete(appType, id);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: '删除失败（可能是当前使用的供应商）' });
    }
  });

  /**
   * 切换供应商
   * POST /api/providers/:appType/:id/switch
   */
  app.post('/api/providers/:appType/:id/switch', (req, res) => {
    const { appType, id } = req.params;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    const success = providerService.switch(appType, id);

    if (success) {
      const provider = providerService.getById(appType, id);

      // 通知 AIEngine 重新加载配置
      if (aiEngine && appType === 'claude') {
        aiEngine.reloadSettings();
        console.log(`[Routes] 已通知 AIEngine 重新加载配置`);
      }

      res.json({ success: true, provider });
    } else {
      res.status(500).json({ error: '切换失败' });
    }
  });

  /**
   * 批量更新排序
   * PUT /api/providers/:appType/sort-order
   * Body: { updates: [{ id, sortIndex }, ...] }
   */
  app.put('/api/providers/:appType/sort-order', (req, res) => {
    const { appType } = req.params;
    const { updates } = req.body;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    if (!Array.isArray(updates)) {
      return res.status(400).json({ error: '更新数据必须是数组' });
    }

    const success = providerService.updateSortOrder(appType, updates);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: '更新排序失败' });
    }
  });

  /**
   * 手动触发 Backfill（将当前 live 配置回填到当前供应商）
   * POST /api/providers/:appType/backfill
   */
  app.post('/api/providers/:appType/backfill', (req, res) => {
    const { appType } = req.params;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    const success = providerService.backfillCurrentProvider(appType);

    if (success) {
      const currentProvider = providerService.getCurrentProvider(appType);
      res.json({ success: true, provider: currentProvider });
    } else {
      res.json({ success: false, message: '无变更或 Backfill 失败' });
    }
  });

  /**
   * 健康检查（单个供应商）
   * POST /api/providers/:appType/:id/health-check
   */
  app.post('/api/providers/:appType/:id/health-check', async (req, res) => {
    const { appType, id } = req.params;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    const provider = providerService.getById(appType, id);

    if (!provider) {
      return res.status(404).json({ error: '供应商不存在' });
    }

    try {
      // 推送进度事件（如果有 io）
      if (io) {
        io.emit('provider:health-check:progress', {
          appType,
          providerId: id,
          progress: 0.5
        });
      }

      const result = await healthCheck.checkWithRetry(appType, provider);

      // 保存日志
      healthCheck.saveLog(appType, id, provider.name, result);

      // 推送完成事件
      if (io) {
        io.emit('provider:health-check:complete', {
          appType,
          providerId: id,
          result
        });
      }

      res.json({ success: true, result });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * 批量健康检查
   * POST /api/providers/:appType/health-check-all
   */
  app.post('/api/providers/:appType/health-check-all', async (req, res) => {
    const { appType } = req.params;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    const data = providerService.list(appType);
    const providers = Object.values(data.providers);

    const results = [];

    for (const provider of providers) {
      try {
        const result = await healthCheck.checkWithRetry(appType, provider);
        healthCheck.saveLog(appType, provider.id, provider.name, result);
        results.push({ id: provider.id, result });
      } catch (error) {
        results.push({
          id: provider.id,
          result: {
            status: 'failed',
            success: false,
            message: error.message,
            testedAt: Date.now()
          }
        });
      }
    }

    res.json({ success: true, results });
  });

  /**
   * 验证 API Key
   * POST /api/providers/:appType/verify-key
   * Body: { settingsConfig: { apiType, openai, claude, ... } }
   */
  app.post('/api/providers/:appType/verify-key', async (req, res) => {
    const { appType } = req.params;
    const { settingsConfig } = req.body;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    if (!settingsConfig) {
      return res.status(400).json({ error: '缺少配置信息' });
    }

    // 创建临时供应商对象用于验证
    const tempProvider = {
      id: 'temp-verify',
      name: 'Verification Test',
      settingsConfig
    };

    try {
      const result = await healthCheck.checkWithRetry(appType, tempProvider);

      if (result.success) {
        res.json({
          success: true,
          responseTimeMs: result.responseTimeMs,
          status: result.status
        });
      } else {
        res.json({
          success: false,
          error: result.message || '验证失败'
        });
      }
    } catch (error) {
      res.json({
        success: false,
        error: error.message || '验证失败'
      });
    }
  });

  /**
   * 获取检查日志
   * GET /api/providers/:appType/:id/check-logs
   */
  app.get('/api/providers/:appType/:id/check-logs', (req, res) => {
    const { appType, id } = req.params;
    const { limit = 10 } = req.query;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    const logs = healthCheck.getLogs({
      appType,
      providerId: id,
      limit: parseInt(limit)
    });

    res.json(logs);
  });

  /**
   * 获取自定义端点
   * GET /api/providers/:appType/:id/endpoints
   */
  app.get('/api/providers/:appType/:id/endpoints', (req, res) => {
    const { appType, id } = req.params;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    const endpoints = providerService.getEndpoints(appType, id);
    res.json(endpoints);
  });

  /**
   * 端点测速
   * POST /api/providers/:appType/:id/speedtest
   * Body: { endpoints?: string[] } - 可选，不传则使用供应商的自定义端点
   */
  app.post('/api/providers/:appType/:id/speedtest', async (req, res) => {
    const { appType, id } = req.params;
    let { endpoints } = req.body;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    const provider = providerService.getById(appType, id);
    if (!provider) {
      return res.status(404).json({ error: '供应商不存在' });
    }

    // 如果没有传入端点，使用供应商的自定义端点
    if (!endpoints || endpoints.length === 0) {
      const customEndpoints = providerService.getEndpoints(appType, id);
      endpoints = customEndpoints.map(e => e.url);

      // 添加当前配置的端点作为基准
      const apiType = provider.settingsConfig?.apiType || 'openai';
      const currentUrl = provider.settingsConfig?.[apiType]?.apiUrl;
      if (currentUrl && !endpoints.includes(currentUrl)) {
        endpoints.unshift(currentUrl);
      }
    }

    if (endpoints.length === 0) {
      return res.status(400).json({ error: '没有可测试的端点' });
    }

    try {
      const results = await healthCheck.speedTestEndpoints(appType, provider, endpoints);
      res.json({
        success: true,
        results,
        fastest: results.find(r => r.success) || null
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * 添加自定义端点
   * POST /api/providers/:appType/:id/endpoints
   * Body: { url: string }
   */
  app.post('/api/providers/:appType/:id/endpoints', (req, res) => {
    const { appType, id } = req.params;
    const { url } = req.body;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    if (!url) {
      return res.status(400).json({ error: '缺少 url' });
    }

    const success = providerService.addEndpoint(appType, id, url);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: '添加端点失败' });
    }
  });

  /**
   * 删除自定义端点
   * DELETE /api/providers/:appType/:id/endpoints
   * Body: { url: string }
   */
  app.delete('/api/providers/:appType/:id/endpoints', (req, res) => {
    const { appType, id } = req.params;
    const { url } = req.body;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    if (!url) {
      return res.status(400).json({ error: '缺少 url' });
    }

    const success = providerService.removeEndpoint(appType, id, url);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: '端点不存在' });
    }
  });

  // ============================================
  // 配置管理（放在通配符路由之前）
  // ============================================

  /**
   * 获取健康检查配置
   * GET /api/config/health-check
   */
  app.get('/api/config/health-check', (req, res) => {
    const config = healthCheck.getConfig();
    res.json(config);
  });

  /**
   * 更新健康检查配置
   * PUT /api/config/health-check
   * Body: { timeoutSecs?, maxRetries?, degradedThresholdMs?, testModels? }
   */
  app.put('/api/config/health-check', (req, res) => {
    const success = healthCheck.saveConfig(req.body);

    if (success) {
      const config = healthCheck.getConfig();
      res.json({ success: true, config });
    } else {
      res.status(500).json({ error: '保存配置失败' });
    }
  });

  /**
   * 获取故障转移配置
   * GET /api/config/failover
   */
  app.get('/api/config/failover', (req, res) => {
    const config = configService.getFailoverConfig();
    res.json(config);
  });

  /**
   * 更新故障转移配置
   * PUT /api/config/failover
   * Body: { enabled?, maxRetries?, retryDelayMs?, fallbackOrder?, excludeFromFailover? }
   */
  app.put('/api/config/failover', async (req, res) => {
    try {
      const config = await configService.updateFailoverConfig(req.body);
      res.json({ success: true, config });
    } catch (err) {
      console.error('[Routes] 保存故障转移配置失败:', err);
      res.status(500).json({ error: '保存配置失败' });
    }
  });

  /**
   * 获取定时检查配置
   * GET /api/config/scheduler
   */
  app.get('/api/config/scheduler', (req, res) => {
    const config = configService.getSchedulerConfig();
    res.json(config);
  });

  /**
   * 更新定时检查配置
   * PUT /api/config/scheduler
   * Body: { enabled?, intervalMinutes?, checkOnStartup?, notifyOnFailure? }
   */
  app.put('/api/config/scheduler', async (req, res) => {
    try {
      const config = await configService.updateSchedulerConfig(req.body);

      // 重启调度器以应用新配置
      if (healthCheckScheduler) {
        await healthCheckScheduler.restart();
      }

      res.json({ success: true, config });
    } catch (err) {
      console.error('[Routes] 保存定时检查配置失败:', err);
      res.status(500).json({ error: '保存配置失败' });
    }
  });

  /**
   * 获取调度器状态
   * GET /api/scheduler/status
   */
  app.get('/api/scheduler/status', (req, res) => {
    if (!healthCheckScheduler) {
      return res.status(503).json({ error: '调度器未初始化' });
    }

    const status = healthCheckScheduler.getStatus();
    res.json(status);
  });

  /**
   * 手动触发健康检查
   * POST /api/scheduler/trigger
   */
  app.post('/api/scheduler/trigger', async (req, res) => {
    if (!healthCheckScheduler) {
      return res.status(503).json({ error: '调度器未初始化' });
    }

    try {
      const results = await healthCheckScheduler.runCheck();
      res.json({ success: true, results });
    } catch (err) {
      console.error('[Routes] 手动触发健康检查失败:', err);
      res.status(500).json({ error: '触发检查失败' });
    }
  });

  // ============================================
  // 用量查询
  // ============================================

  /**
   * 获取用量查询脚本
   * GET /api/providers/:appType/:id/usage-script
   */
  app.get('/api/providers/:appType/:id/usage-script', (req, res) => {
    const { appType, id } = req.params;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    const script = providerService.getUsageScript(appType, id);
    res.json({ script });
  });

  /**
   * 设置用量查询脚本
   * PUT /api/providers/:appType/:id/usage-script
   * Body: { script: string }
   */
  app.put('/api/providers/:appType/:id/usage-script', (req, res) => {
    const { appType, id } = req.params;
    const { script } = req.body;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    if (script === undefined) {
      return res.status(400).json({ error: '缺少 script 参数' });
    }

    const success = providerService.setUsageScript(appType, id, script);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: '设置脚本失败' });
    }
  });

  /**
   * 执行用量查询
   * POST /api/providers/:appType/:id/query-usage
   */
  app.post('/api/providers/:appType/:id/query-usage', async (req, res) => {
    const { appType, id } = req.params;

    if (!['claude', 'codex', 'gemini'].includes(appType)) {
      return res.status(400).json({ error: '不支持的应用类型' });
    }

    try {
      const result = await providerService.queryUsage(appType, id);
      res.json(result);
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // ============================================
  // 存储管理 API
  // ============================================

  const storageSettingsPath = path.join(os.homedir(), '.webtmux', 'storage-settings.json');

  // 获取存储统计
  app.get('/api/storage/stats', (req, res) => {
    try {
      const recorder = getTerminalRecorder();
      const recStats = recorder.getStats();

      // 获取日志统计 - 从 webtmux.db 的 history 表读取
      const webtmuxDbPath = path.join(os.homedir(), '.webtmux', 'db', 'webtmux.db');
      let logsStats = { size: 0, count: 0, oldestTime: null };

      if (fs.existsSync(webtmuxDbPath)) {
        logsStats.size = fs.statSync(webtmuxDbPath).size;
        try {
          const logsDb = new Database(webtmuxDbPath, { readonly: true });
          const row = logsDb.prepare("SELECT COUNT(*) as count, MIN(created_at) as oldest FROM history WHERE type = 'ai_decision'").get();
          logsDb.close();
          if (row) {
            logsStats.count = row.count || 0;
            logsStats.oldestTime = row.oldest;
          }
        } catch (dbErr) {
          console.error('[API] 读取日志统计失败:', dbErr);
        }
      }

      res.json({
        recordings: {
          size: recStats.totalSize || 0,
          count: recStats.totalEvents || 0,
          oldestTime: recStats.oldestTime || null
        },
        logs: logsStats
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取按会话分组的录制统计（包含项目信息）
  app.get('/api/storage/recordings/by-session', (req, res) => {
    try {
      const recorder = getTerminalRecorder();
      const recordings = recorder.getStatsBySession();

      // 从录制数据库获取保存的会话信息
      const savedInfo = recorder.getAllSessionInfo();

      // 获取当前活跃会话信息（作为补充）
      const allSessions = sessionManager.listSessions();
      const activeMap = {};
      allSessions.forEach(s => {
        activeMap[s.id] = {
          name: s.name,
          projectName: s.projectName,
          projectDir: s.projectDir,
          projectDesc: s.projectDesc
        };
      });

      // 合并项目信息（优先使用保存的，其次使用活跃会话的）
      const result = recordings.map(r => {
        const saved = savedInfo[r.sessionId];
        const active = activeMap[r.sessionId];
        const info = saved || active || {};
        return {
          ...r,
          projectName: info.projectName || null,
          projectDir: info.projectDir || null,
          projectDesc: info.projectDesc || null,
          name: info.name || r.sessionId
        };
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 删除指定会话的录制
  app.delete('/api/storage/recordings/:sessionId', (req, res) => {
    try {
      const { minutes } = req.body || {};
      const recorder = getTerminalRecorder();
      const deleted = recorder.deleteSessionOlderThan(req.params.sessionId, minutes || 0);
      res.json({ success: true, deleted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取存储设置
  app.get('/api/storage/settings', (req, res) => {
    try {
      if (fs.existsSync(storageSettingsPath)) {
        const data = JSON.parse(fs.readFileSync(storageSettingsPath, 'utf-8'));
        res.json(data);
      } else {
        res.json({
          recordingsMaxSize: 500,
          recordingsRetentionDays: 7,
          logsMaxSize: 100,
          logsRetentionDays: 30
        });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 保存存储设置
  app.post('/api/storage/settings', (req, res) => {
    try {
      const dir = path.dirname(storageSettingsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(storageSettingsPath, JSON.stringify(req.body, null, 2));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 清理数据
  app.post('/api/storage/clean/:type', (req, res) => {
    const { type } = req.params;
    const { hours } = req.body; // 可选：清理最近多少小时的数据，不传则清理全部
    try {
      let deleted = 0;
      if (type === 'recordings') {
        const recorder = getTerminalRecorder();
        deleted = recorder.cleanRecentRecordings(hours || 0);
      } else if (type === 'logs') {
        const logsDbPath = path.join(os.homedir(), '.webtmux', 'db', 'ai-logs.db');
        if (fs.existsSync(logsDbPath)) {
          if (hours) {
            // 按时间范围删除最近N小时
            const cutoff = Date.now() - hours * 60 * 60 * 1000;
            try {
              const logsDb = new Database(logsDbPath);
              const result = logsDb.prepare('DELETE FROM ai_logs WHERE timestamp > ?').run(cutoff);
              logsDb.close();
              deleted = result.changes;
            } catch (dbErr) {
              return res.status(500).json({ error: dbErr.message });
            }
          } else {
            fs.unlinkSync(logsDbPath);
            deleted = 1;
          }
        }
      }
      res.json({ success: true, deleted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 导出数据
  app.get('/api/storage/export/:type', (req, res) => {
    const { type } = req.params;
    try {
      if (type === 'recordings') {
        const recorder = getTerminalRecorder();
        const data = recorder.exportAll();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename=recordings.json');
        res.send(JSON.stringify(data, null, 2));
      } else if (type === 'logs') {
        const logsDbPath = path.join(os.homedir(), '.webtmux', 'db', 'ai-logs.db');
        if (fs.existsSync(logsDbPath)) {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Disposition', 'attachment; filename=ai-logs.db');
          res.sendFile(logsDbPath);
        } else {
          res.status(404).json({ error: '日志文件不存在' });
        }
      } else {
        res.status(400).json({ error: '未知类型' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================
  // 依赖管理 API
  // ============================================

  /**
   * 获取所有依赖状态
   * GET /api/dependencies
   */
  app.get('/api/dependencies', (req, res) => {
    try {
      const status = dependencyManager.getStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 安装指定依赖
   * POST /api/dependencies/:name/install
   */
  app.post('/api/dependencies/:name/install', async (req, res) => {
    const { name } = req.params;

    try {
      // 通过 Socket.IO 推送安装进度
      const progressCallback = (message) => {
        if (io) {
          io.emit('dependency:progress', { name, message });
        }
      };

      await dependencyManager.install(name, progressCallback);

      // 推送安装完成
      if (io) {
        io.emit('dependency:installed', { name, success: true });
      }

      res.json({ success: true, message: `${name} 安装成功` });
    } catch (err) {
      if (io) {
        io.emit('dependency:installed', { name, success: false, error: err.message });
      }
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 安装所有依赖
   * POST /api/dependencies/install-all
   */
  app.post('/api/dependencies/install-all', async (req, res) => {
    try {
      const progressCallback = (message) => {
        if (io) {
          io.emit('dependency:progress', { name: 'all', message });
        }
      };

      const results = await dependencyManager.installAll(progressCallback);

      if (io) {
        io.emit('dependency:install-all-complete', results);
      }

      res.json({ success: true, results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 检查单个依赖是否已安装
   * GET /api/dependencies/:name/check
   */
  app.get('/api/dependencies/:name/check', (req, res) => {
    const { name } = req.params;

    try {
      const installed = dependencyManager.isInstalled(name);
      const executable = dependencyManager.getExecutable(name);
      res.json({ installed, executable });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
