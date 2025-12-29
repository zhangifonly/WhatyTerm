import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 内置供应商数据库服务
 *
 * 优先使用 CC-Switch 数据库，如果不存在则使用内置数据库
 */
class BuiltinProviderDB {
  constructor() {
    // CC-Switch 外部数据库路径
    this.ccSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
    // 内置数据库路径
    this.builtinDbPath = path.join(__dirname, '../db/providers.db');
    // 当前使用的数据库路径
    this.currentDbPath = null;
    // 是否使用内置数据库
    this.isBuiltin = false;
  }

  /**
   * 初始化数据库
   * 优先使用 CC-Switch，不存在则创建内置数据库
   */
  init() {
    if (fs.existsSync(this.ccSwitchDbPath)) {
      console.log('[BuiltinProviderDB] 使用 CC-Switch 数据库:', this.ccSwitchDbPath);
      this.currentDbPath = this.ccSwitchDbPath;
      this.isBuiltin = false;
    } else {
      console.log('[BuiltinProviderDB] CC-Switch 未安装，使用内置数据库:', this.builtinDbPath);
      this.currentDbPath = this.builtinDbPath;
      this.isBuiltin = true;
      this._ensureBuiltinDB();
    }
  }

  /**
   * 确保内置数据库存在并初始化表结构
   */
  _ensureBuiltinDB() {
    const db = new Database(this.builtinDbPath);

    // 创建 providers 表（与 CC-Switch 兼容的结构）
    db.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        app_type TEXT NOT NULL DEFAULT 'claude',
        name TEXT NOT NULL,
        settings_config TEXT,
        website_url TEXT,
        category TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        sort_index INTEGER,
        notes TEXT,
        icon TEXT,
        icon_color TEXT,
        meta TEXT,
        is_current INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_providers_app_type ON providers(app_type);
      CREATE INDEX IF NOT EXISTS idx_providers_is_current ON providers(is_current);
    `);

    // 检查是否需要初始化默认数据
    const count = db.prepare('SELECT COUNT(*) as count FROM providers').get();
    if (count.count === 0) {
      console.log('[BuiltinProviderDB] 初始化默认供应商配置...');
      this._insertDefaultProviders(db);
    }

    db.close();
    console.log('[BuiltinProviderDB] 内置数据库初始化完成');
  }

  /**
   * 插入默认供应商配置
   */
  _insertDefaultProviders(db) {
    const now = Date.now();

    // 默认 Claude 供应商（官方 API）
    const defaultProviders = [
      {
        id: 'anthropic-official',
        app_type: 'claude',
        name: 'Anthropic 官方',
        settings_config: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
            ANTHROPIC_AUTH_TOKEN: '',
            ANTHROPIC_MODEL: 'claude-sonnet-4-20250514'
          }
        }),
        website_url: 'https://console.anthropic.com/',
        category: 'official',
        created_at: now,
        sort_index: 0,
        notes: 'Anthropic 官方 API，需要填写 API Key',
        icon: 'claude',
        icon_color: '#D97706',
        is_current: 1
      },
      {
        id: 'openai-official',
        app_type: 'codex',
        name: 'OpenAI 官方',
        settings_config: JSON.stringify({
          auth: {
            OPENAI_API_KEY: ''
          },
          config: `model = "gpt-4o"

[model_providers.openai]
name = "openai"
base_url = "https://api.openai.com/v1"
`
        }),
        website_url: 'https://platform.openai.com/',
        category: 'official',
        created_at: now,
        sort_index: 0,
        notes: 'OpenAI 官方 API，需要填写 API Key',
        icon: 'openai',
        icon_color: '#10A37F',
        is_current: 1
      },
      {
        id: 'google-official',
        app_type: 'gemini',
        name: 'Google 官方',
        settings_config: JSON.stringify({
          env: {
            GEMINI_API_KEY: '',
            GEMINI_MODEL: 'gemini-2.0-flash-exp'
          }
        }),
        website_url: 'https://aistudio.google.com/',
        category: 'official',
        created_at: now,
        sort_index: 0,
        notes: 'Google AI Studio API，需要填写 API Key',
        icon: 'gemini',
        icon_color: '#4285F4',
        is_current: 1
      }
    ];

    const stmt = db.prepare(`
      INSERT INTO providers (id, app_type, name, settings_config, website_url, category, created_at, sort_index, notes, icon, icon_color, is_current)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const provider of defaultProviders) {
      stmt.run(
        provider.id,
        provider.app_type,
        provider.name,
        provider.settings_config,
        provider.website_url,
        provider.category,
        provider.created_at,
        provider.sort_index,
        provider.notes,
        provider.icon,
        provider.icon_color,
        provider.is_current
      );
    }

    console.log('[BuiltinProviderDB] 已添加', defaultProviders.length, '个默认供应商');
  }

  /**
   * 获取数据库连接
   * @param {boolean} readonly - 是否只读模式
   * @returns {Database} SQLite 数据库实例
   */
  getDB(readonly = false) {
    if (!this.currentDbPath) {
      this.init();
    }
    return new Database(this.currentDbPath, { readonly });
  }

  /**
   * 检查是否使用内置数据库
   */
  isUsingBuiltin() {
    return this.isBuiltin;
  }

  /**
   * 获取当前数据库路径
   */
  getDbPath() {
    return this.currentDbPath;
  }

  /**
   * 检查数据库是否可用
   */
  isAvailable() {
    if (!this.currentDbPath) {
      this.init();
    }
    return fs.existsSync(this.currentDbPath);
  }

  /**
   * 重新检测数据库（用于 CC-Switch 安装后切换）
   */
  refresh() {
    this.currentDbPath = null;
    this.isBuiltin = false;
    this.init();
  }
}

// 导出单例
export default new BuiltinProviderDB();
