import express from 'express';
import ConfigManager from '../services/ConfigManager.js';
import sqlite3 from 'sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const router = express.Router();
const configManager = new ConfigManager();

// ==================== Profiles API ====================

// GET /api/config/profiles - 列出所有 profiles (包括 CC Switch 数据库中的 providers)
router.get('/profiles', (req, res) => {
  try {
    // 首先获取 Claude Code profiles
    const profiles = configManager.listProfiles();

    // 然后尝试读取 CC Switch 数据库中的 providers
    try {
      const ccSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

      if (fs.existsSync(ccSwitchDbPath)) {
        const db = new sqlite3.Database(ccSwitchDbPath, sqlite3.OPEN_READONLY);

        db.all('SELECT * FROM providers', [], (err, rows) => {
          db.close();

          if (err) {
            console.error('[CC Switch] 读取数据库失败:', err);
            // 如果读取失败，只返回 Claude Code profiles
            return res.json({
              success: true,
              data: { profiles }
            });
          }

          // 合并 CC Switch providers 和 Claude Code profiles
          const ccSwitchProviders = rows.map(row => ({
            name: row.id,
            display_name: row.name,
            app_type: row.app_type,
            path: `cc-switch://${row.id}`,
            is_current: row.is_current === 1,
            created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
            modified_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
            category: row.category,
            icon: row.icon,
            icon_color: row.icon_color,
            settings_config: row.settings_config ? JSON.parse(row.settings_config) : {},
            source: 'cc-switch'
          }));

          // 标记 Claude Code profiles 的来源
          const claudeProfiles = profiles.map(p => ({
            ...p,
            source: 'claude-code'
          }));

          // 合并两个列表
          const allProfiles = [...ccSwitchProviders, ...claudeProfiles];

          res.json({
            success: true,
            data: { profiles: allProfiles }
          });
        });
      } else {
        // 如果 CC Switch 数据库不存在，只返回 Claude Code profiles
        res.json({
          success: true,
          data: { profiles }
        });
      }
    } catch (ccSwitchError) {
      console.error('[CC Switch] 读取失败:', ccSwitchError);
      // 如果读取 CC Switch 失败，只返回 Claude Code profiles
      res.json({
        success: true,
        data: { profiles }
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/config/profiles - 创建 profile
router.post('/profiles', (req, res) => {
  try {
    const { name, template = 'default', content } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Profile name is required'
      });
    }

    configManager.validateProfileName(name);

    const profile = configManager.createProfile(name, template, content);

    res.json({
      success: true,
      data: profile,
      message: `Profile '${name}' created successfully`
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/config/profiles/:name - 查看 profile
router.get('/profiles/:name', (req, res) => {
  try {
    const { name } = req.params;
    const profile = configManager.viewProfile(name);

    res.json({
      success: true,
      data: profile
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

// PUT /api/config/profiles/:name - 更新 profile
router.put('/profiles/:name', (req, res) => {
  try {
    const { name } = req.params;
    const content = req.body;

    configManager.updateProfile(name, content);

    res.json({
      success: true,
      message: `Profile '${name}' updated successfully`
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// DELETE /api/config/profiles/:name - 删除 profile
router.delete('/profiles/:name', (req, res) => {
  try {
    const { name } = req.params;
    const { force } = req.query;

    configManager.deleteProfile(name, force === 'true');

    res.json({
      success: true,
      message: `Profile '${name}' deleted successfully`
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/config/profiles/:name/move - 重命名 profile
router.post('/profiles/:name/move', (req, res) => {
  try {
    const { name } = req.params;
    const { new_name } = req.body;

    if (!new_name) {
      return res.status(400).json({
        success: false,
        error: 'New profile name is required'
      });
    }

    configManager.validateProfileName(new_name);
    configManager.moveProfile(name, new_name);

    res.json({
      success: true,
      message: `Profile renamed from '${name}' to '${new_name}' successfully`,
      data: {
        old_name: name,
        new_name
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/config/profiles/:name/copy - 复制 profile
router.post('/profiles/:name/copy', (req, res) => {
  try {
    const { name } = req.params;
    const { dest_name } = req.body;

    if (!dest_name) {
      return res.status(400).json({
        success: false,
        error: 'Destination name is required'
      });
    }

    configManager.validateProfileName(dest_name);
    configManager.copyProfile(name, dest_name);

    res.json({
      success: true,
      message: `Profile '${name}' copied to '${dest_name}' successfully`
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== Current & Switch API ====================

// GET /api/config/current - 获取当前 profile
router.get('/current', (req, res) => {
  try {
    const app = req.query.app || 'claude';
    const currentProfile = configManager.getCurrentProfile();
    const isEmptyMode = configManager.isEmptyMode();

    // 检查 CC Switch 数据库中是否有当前激活的供应商
    const ccSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

    if (fs.existsSync(ccSwitchDbPath)) {
      const db = new sqlite3.Database(ccSwitchDbPath, sqlite3.OPEN_READONLY);

      db.get('SELECT id FROM providers WHERE app_type = ? AND is_current = 1',
        [app],
        (err, row) => {
          db.close();

          if (err) {
            console.error('[CC Switch] 查询当前供应商失败:', err);
          }

          const response = {
            current: row ? row.id : currentProfile,
            empty_mode: isEmptyMode
          };

          if (isEmptyMode) {
            const status = configManager.getEmptyModeStatus();
            response.empty_mode_status = status;
          }

          res.json({
            success: true,
            data: response
          });
        });
    } else {
      const response = {
        current: currentProfile,
        empty_mode: isEmptyMode
      };

      if (isEmptyMode) {
        const status = configManager.getEmptyModeStatus();
        response.empty_mode_status = status;
      }

      res.json({
        success: true,
        data: response
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/config/switch - 切换 profile
router.post('/switch', (req, res) => {
  try {
    const { profile, restore, app } = req.body;

    let message;

    if (restore) {
      configManager.restoreFromEmptyMode();
      message = 'Configuration restored from empty mode';
    } else if (profile === '' || profile === null) {
      configManager.useEmptyMode();
      message = 'Switched to empty mode';
    } else {
      // 检查是否是 CC Switch 供应商
      const ccSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

      if (fs.existsSync(ccSwitchDbPath)) {
        const db = new sqlite3.Database(ccSwitchDbPath, sqlite3.OPEN_READWRITE);

        // 检查该 profile 是否存在于 CC Switch 数据库中
        db.get('SELECT id, app_type FROM providers WHERE id = ? AND app_type = ?',
          [profile, app || 'claude'],
          (err, row) => {
            if (err) {
              db.close();
              console.error('[CC Switch] 查询失败:', err);
              // 如果查询失败，回退到 Claude Code 模式
              configManager.applyProfile(profile);
              message = `Switched to configuration: ${profile}`;

              return res.json({
                success: true,
                message,
                data: { profile }
              });
            }

            if (row) {
              // 是 CC Switch 供应商，更新数据库
              const appType = row.app_type;

              // 先取消该 app_type 下所有供应商的 is_current 标记
              db.run('UPDATE providers SET is_current = 0 WHERE app_type = ?',
                [appType],
                (updateErr) => {
                  if (updateErr) {
                    db.close();
                    console.error('[CC Switch] 更新失败:', updateErr);
                    return res.status(500).json({
                      success: false,
                      error: updateErr.message
                    });
                  }

                  // 设置当前供应商为 current
                  db.run('UPDATE providers SET is_current = 1 WHERE id = ? AND app_type = ?',
                    [profile, appType],
                    (setErr) => {
                      db.close();

                      if (setErr) {
                        console.error('[CC Switch] 设置当前供应商失败:', setErr);
                        return res.status(500).json({
                          success: false,
                          error: setErr.message
                        });
                      }

                      message = `Switched to ${appType} provider: ${profile}`;
                      return res.json({
                        success: true,
                        message,
                        data: { profile }
                      });
                    });
                });
            } else {
              // 不是 CC Switch 供应商，使用 Claude Code 配置管理
              db.close();
              configManager.applyProfile(profile);
              message = `Switched to configuration: ${profile}`;

              return res.json({
                success: true,
                message,
                data: { profile }
              });
            }
          });
      } else {
        // CC Switch 数据库不存在，使用 Claude Code 配置管理
        configManager.applyProfile(profile);
        message = `Switched to configuration: ${profile}`;

        return res.json({
          success: true,
          message,
          data: { profile }
        });
      }

      // 注意：由于数据库操作是异步的，上面的代码会通过回调返回响应
      // 所以这里不需要再返回响应
      return;
    }

    res.json({
      success: true,
      message,
      data: {
        profile: profile || null
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== Templates API ====================

// GET /api/config/templates - 列出所有 templates
router.get('/templates', (req, res) => {
  try {
    const templates = configManager.listTemplates();
    res.json({
      success: true,
      data: { templates }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/config/templates - 创建 template
router.post('/templates', (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Template name is required'
      });
    }

    configManager.validateTemplateName(name);

    const template = configManager.createTemplate(name);

    res.json({
      success: true,
      data: template,
      message: `Template '${name}' created successfully`
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/config/templates/:name - 查看 template
router.get('/templates/:name', (req, res) => {
  try {
    const { name } = req.params;
    const template = configManager.viewTemplate(name);

    res.json({
      success: true,
      data: template
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

// PUT /api/config/templates/:name - 更新 template
router.put('/templates/:name', (req, res) => {
  try {
    const { name } = req.params;
    const content = req.body;

    configManager.updateTemplate(name, content);

    res.json({
      success: true,
      message: `Template '${name}' updated successfully`
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// DELETE /api/config/templates/:name - 删除 template
router.delete('/templates/:name', (req, res) => {
  try {
    const { name } = req.params;

    configManager.deleteTemplate(name);

    res.json({
      success: true,
      message: `Template '${name}' deleted successfully`
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/config/templates/:name/move - 重命名 template
router.post('/templates/:name/move', (req, res) => {
  try {
    const { name } = req.params;
    const { new_name } = req.body;

    if (!new_name) {
      return res.status(400).json({
        success: false,
        error: 'New template name is required'
      });
    }

    configManager.validateTemplateName(new_name);
    configManager.moveTemplate(name, new_name);

    res.json({
      success: true,
      message: `Template renamed from '${name}' to '${new_name}' successfully`,
      data: {
        old_name: name,
        new_name
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/config/templates/:name/copy - 复制 template
router.post('/templates/:name/copy', (req, res) => {
  try {
    const { name } = req.params;
    const { dest_name, to_config } = req.body;

    if (!dest_name) {
      return res.status(400).json({
        success: false,
        error: 'Destination name is required'
      });
    }

    if (to_config) {
      // 从模板创建配置
      configManager.validateProfileName(dest_name);
      configManager.createProfile(dest_name, name);

      res.json({
        success: true,
        message: `Configuration '${dest_name}' created from template '${name}' successfully`,
        data: {
          name: dest_name,
          type: 'configuration'
        }
      });
    } else {
      // 复制模板
      if (dest_name === 'default') {
        return res.status(400).json({
          success: false,
          error: 'Cannot create template with reserved name "default"'
        });
      }

      configManager.validateTemplateName(dest_name);
      configManager.copyTemplate(name, dest_name);

      res.json({
        success: true,
        message: `Template '${name}' copied to '${dest_name}' successfully`,
        data: {
          name: dest_name,
          type: 'template'
        }
      });
    }
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== Health API ====================

// GET /api/config/health - 健康检查
router.get('/health', (req, res) => {
  try {
    const currentProfile = configManager.getCurrentProfile();
    const isEmptyMode = configManager.isEmptyMode();

    res.json({
      success: true,
      data: {
        status: 'ok',
        initialized: currentProfile !== null || isEmptyMode,
        current_profile: currentProfile,
        empty_mode: isEmptyMode,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
