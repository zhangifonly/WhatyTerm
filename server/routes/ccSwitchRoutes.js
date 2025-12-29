import express from 'express';
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { DEFAULT_MODEL } from '../config/constants.js';

const router = express.Router();

// CC Switch 数据库路径
const ccSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

// ==================== Providers API ====================

// GET /api/cc-switch/providers - 列出所有 CC Switch providers
router.get('/providers', (req, res) => {
  try {
    const app = req.query.app || 'claude';

    if (!fs.existsSync(ccSwitchDbPath)) {
      return res.json({
        success: true,
        data: { providers: [] }
      });
    }

    const db = new Database(ccSwitchDbPath, { readonly: true });
    const rows = db.prepare('SELECT * FROM providers WHERE app_type = ? ORDER BY sort_index IS NULL, sort_index, created_at').all(app);
    db.close();

    // 转换为前端需要的格式
    const providers = rows.map((row, index) => {
      let settingsConfig = {};

      // 解析 settings_config JSON
      try {
        if (row.settings_config) {
          if (typeof row.settings_config === 'string') {
            settingsConfig = JSON.parse(row.settings_config);
          } else {
            settingsConfig = row.settings_config;
          }
        }
      } catch (jsonError) {
        console.error(`[CC Switch] JSON 解析失败 (${row.name}):`, jsonError);
      }

      // 解析配置，提取标准化字段
      let apiUrl = '';
      let apiKey = '';
      let model = '';
      let apiType = 'openai'; // 默认 OpenAI API

      try {
        if (row.app_type === 'claude') {
          // Claude 使用 env.ANTHROPIC_BASE_URL 和 ANTHROPIC_AUTH_TOKEN
          apiUrl = settingsConfig.env?.ANTHROPIC_BASE_URL || settingsConfig.baseURL || '';
          apiKey = settingsConfig.env?.ANTHROPIC_AUTH_TOKEN || settingsConfig.env?.ANTHROPIC_API_KEY || '';
          model = settingsConfig.env?.ANTHROPIC_MODEL || settingsConfig.model || '';
          // Claude 类型统一显示为 claude（无论是原生 API 还是 OpenAI 兼容格式）
          apiType = 'claude';
        } else if (row.app_type === 'codex') {
          // Codex 使用 auth.OPENAI_API_KEY 和 TOML 格式的 config
          apiKey = settingsConfig.auth?.OPENAI_API_KEY || settingsConfig.auth?.CODEX_API_KEY || '';
          model = '';
          // 从 TOML config 中提取 base_url 和 model
          if (settingsConfig.config) {
            // 提取 base_url（在 [model_providers.xxx] 部分）
            const baseUrlMatch = settingsConfig.config.match(/base_url\s*=\s*"([^"]+)"/);
            if (baseUrlMatch) {
              apiUrl = baseUrlMatch[1];
            }
            // 提取顶层 model
            const modelMatch = settingsConfig.config.match(/^model\s*=\s*"([^"]+)"/m);
            if (modelMatch) {
              model = modelMatch[1];
            }
          }

          // 规范化 Codex API URL：确保以 /responses 结尾
          if (apiUrl && !apiUrl.endsWith('/responses')) {
            apiUrl = apiUrl.replace(/\/+$/, '');
            apiUrl = `${apiUrl}/responses`;
          }

          apiType = 'openai';
        } else if (row.app_type === 'gemini') {
          // Gemini 使用通用字段
          apiUrl = settingsConfig.env?.GEMINI_BASE_URL || settingsConfig.baseURL || settingsConfig.env?.BASE_URL || '';
          apiKey = settingsConfig.env?.GEMINI_API_KEY || settingsConfig.env?.API_KEY || '';
          model = settingsConfig.env?.GEMINI_MODEL || settingsConfig.model || '';
          apiType = 'gemini';
        }
      } catch (parseError) {
        console.error(`[CC Switch] 解析 ${row.app_type} settings_config 失败:`, parseError);
      }

      return {
        id: row.id,
        name: row.name,
        // 下划线格式（CC Switch 需要）
        // 注意：sort_index 为 null 时设为 999999，因为 CC Switch 用 ||0 处理 null
        app_type: row.app_type,
        settings_config: settingsConfig,
        website_url: row.website_url,
        created_at: row.created_at,
        sort_index: row.sort_index ?? 999999,
        icon_color: row.icon_color,
        is_current: row.is_current === 1,
        // 驼峰格式（WebTmux 前端需要）
        appType: row.app_type,
        settingsConfig: settingsConfig,
        websiteUrl: row.website_url,
        createdAt: row.created_at,
        sortIndex: row.sort_index ?? 999999,
        iconColor: row.icon_color,
        isCurrent: row.is_current === 1,
        // 通用字段
        category: row.category,
        notes: row.notes,
        icon: row.icon,
        meta: row.meta ? JSON.parse(row.meta) : {},
        // 添加标准化字段（WebTmux AI 设置需要）
        url: apiUrl,
        apiKey: apiKey,
        model: model,
        apiType: apiType
      };
    });

    res.json({
      success: true,
      data: {
        providers,
        defaultModel: DEFAULT_MODEL  // 最便宜的默认模型
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/cc-switch/current - 获取当前激活的 provider
router.get('/current', (req, res) => {
  try {
    const app = req.query.app || 'claude';

    if (!fs.existsSync(ccSwitchDbPath)) {
      return res.json({
        success: true,
        data: { current: null }
      });
    }

    const db = new Database(ccSwitchDbPath, { readonly: true });
    const row = db.prepare('SELECT id FROM providers WHERE app_type = ? AND is_current = 1').get(app);
    db.close();

    res.json({
      success: true,
      data: {
        current: row ? row.id : null
      }
    });
  } catch (error) {
    console.error('[CC Switch] 查询当前供应商失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/cc-switch/switch - 切换 provider
router.post('/switch', (req, res) => {
  try {
    const { provider_id, app } = req.body;

    if (!provider_id || !app) {
      return res.status(400).json({
        success: false,
        error: 'provider_id and app are required'
      });
    }

    if (!fs.existsSync(ccSwitchDbPath)) {
      return res.status(404).json({
        success: false,
        error: 'CC Switch database not found'
      });
    }

    const db = new Database(ccSwitchDbPath);

    // 先取消该 app 下所有供应商的 is_current 标记
    db.prepare('UPDATE providers SET is_current = 0 WHERE app_type = ?').run(app);

    // 设置当前供应商为 current
    db.prepare('UPDATE providers SET is_current = 1 WHERE id = ? AND app_type = ?').run(provider_id, app);

    db.close();

    res.json({
      success: true,
      message: `Switched to ${app} provider: ${provider_id}`,
      data: { provider_id, app }
    });
  } catch (error) {
    console.error('[CC Switch] 切换供应商失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/cc-switch/add - 添加 provider
router.post('/add', (req, res) => {
  try {
    const { provider, app } = req.body;

    if (!provider || !app) {
      return res.status(400).json({
        success: false,
        error: 'provider and app are required'
      });
    }

    if (!fs.existsSync(ccSwitchDbPath)) {
      return res.status(404).json({
        success: false,
        error: 'CC Switch database not found'
      });
    }

    const db = new Database(ccSwitchDbPath);

    const stmt = db.prepare(`INSERT INTO providers
      (id, app_type, name, settings_config, website_url, category, created_at, sort_index, notes, icon, icon_color, meta, is_current)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    stmt.run(
      provider.id,
      app,
      provider.name,
      JSON.stringify(provider.settingsConfig || {}),
      provider.websiteUrl || null,
      provider.category || null,
      provider.createdAt || Date.now(),
      provider.sortIndex || 0,
      provider.notes || null,
      provider.icon || null,
      provider.iconColor || null,
      JSON.stringify(provider.meta || {}),
      0  // is_current default to false
    );

    db.close();

    res.json({
      success: true,
      message: 'Provider added successfully',
      data: { id: provider.id }
    });
  } catch (error) {
    console.error('[CC Switch] 添加供应商失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// PUT /api/cc-switch/update/:id - 更新 provider
router.put('/update/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { provider, app } = req.body;

    if (!provider || !app) {
      return res.status(400).json({
        success: false,
        error: 'provider and app are required'
      });
    }

    if (!fs.existsSync(ccSwitchDbPath)) {
      return res.status(404).json({
        success: false,
        error: 'CC Switch database not found'
      });
    }

    const db = new Database(ccSwitchDbPath);

    const stmt = db.prepare(`UPDATE providers SET
      name = ?,
      settings_config = ?,
      website_url = ?,
      category = ?,
      sort_index = ?,
      notes = ?,
      icon = ?,
      icon_color = ?,
      meta = ?
      WHERE id = ? AND app_type = ?`);

    const result = stmt.run(
      provider.name,
      JSON.stringify(provider.settingsConfig || {}),
      provider.websiteUrl || null,
      provider.category || null,
      provider.sortIndex || 0,
      provider.notes || null,
      provider.icon || null,
      provider.iconColor || null,
      JSON.stringify(provider.meta || {}),
      id,
      app
    );

    db.close();

    if (result.changes === 0) {
      return res.status(404).json({
        success: false,
        error: 'Provider not found'
      });
    }

    res.json({
      success: true,
      message: 'Provider updated successfully'
    });
  } catch (error) {
    console.error('[CC Switch] 更新供应商失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// DELETE /api/cc-switch/delete/:id - 删除 provider
router.delete('/delete/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { app } = req.query;

    if (!app) {
      return res.status(400).json({
        success: false,
        error: 'app parameter is required'
      });
    }

    if (!fs.existsSync(ccSwitchDbPath)) {
      return res.status(404).json({
        success: false,
        error: 'CC Switch database not found'
      });
    }

    const db = new Database(ccSwitchDbPath);

    const result = db.prepare('DELETE FROM providers WHERE id = ? AND app_type = ?').run(id, app);

    db.close();

    if (result.changes === 0) {
      return res.status(404).json({
        success: false,
        error: 'Provider not found'
      });
    }

    res.json({
      success: true,
      message: 'Provider deleted successfully'
    });
  } catch (error) {
    console.error('[CC Switch] 删除供应商失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
