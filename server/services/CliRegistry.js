/**
 * CliRegistry - CLI 工具注册表服务
 *
 * 支持动态注册和学习新的 CLI 工具，存储到 JSON 配置文件
 * 可以通过进程名、终端特征等多种方式检测 CLI 工具
 */

import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REGISTRY_PATH = join(__dirname, '../db/cli-registry.json');

// 默认内置的 CLI 工具配置
const DEFAULT_CLI_TOOLS = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    processNames: ['claude', 'claude-code'],
    terminalPatterns: {
      running: ['esc to interrupt', 'ctrl\\+t to show todos', '\\(\\d+m\\s*\\d+s\\)'],
      idle: ['^>\\s*$', 'accept edits on', '\\? for shortcuts'],
      confirm: ['Do you want to (make this edit|create|delete|run)', '1\\.\\s*Yes']
    },
    commands: {
      start: 'claude -c',
      quit: '/quit'
    },
    builtin: true,
    enabled: true,
    createdAt: '2025-01-01T00:00:00.000Z'
  },
  codex: {
    id: 'codex',
    name: 'OpenAI Codex',
    processNames: ['codex', 'codex-cli'],
    terminalPatterns: {
      running: ['esc to interrupt', 'Reviewing|Generating|Executing', '\\(\\d+s\\s*[•·]?'],
      idle: ['^>\\s*$', 'Updated Plan', 'Worked for \\d+m'],
      confirm: ['Do you want to proceed', '1\\.\\s*Yes']
    },
    commands: {
      start: 'codex',
      quit: '/quit'
    },
    builtin: true,
    enabled: true,
    createdAt: '2025-01-01T00:00:00.000Z'
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    processNames: ['gemini', 'gemini-cli'],
    terminalPatterns: {
      running: ['GoogleSearch\\s+Searching', '(ReadFile|WriteFile|Shell)\\s+(Reading|Writing|Running)', 'Thinking.*\\.\\.\\.'],
      idle: ['Ready\\s*\\(\\d+\\s*tools?\\)', '✦'],
      confirm: ['Do you want to proceed', '1\\.\\s*Yes']
    },
    commands: {
      start: 'gemini',
      quit: '/quit'
    },
    builtin: true,
    enabled: true,
    createdAt: '2025-01-01T00:00:00.000Z'
  },
  factory: {
    id: 'factory',
    name: 'Factory AI',
    processNames: ['factory', 'factory-cli'],
    terminalPatterns: {
      running: ['Running|Executing|Processing', '\\.\\.\\.$'],
      idle: ['^>\\s*$', 'factory>'],
      confirm: ['\\[y/N\\]', '\\[Y/n\\]']
    },
    commands: {
      start: 'factory',
      quit: 'exit'
    },
    builtin: true,
    enabled: true,
    createdAt: '2025-01-01T00:00:00.000Z'
  }
};

class CliRegistry {
  constructor() {
    this.tools = {};
    this.loadRegistry();
  }

  /**
   * 加载注册表
   */
  loadRegistry() {
    try {
      if (fs.existsSync(REGISTRY_PATH)) {
        const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
        // 合并内置工具和用户自定义工具
        this.tools = { ...DEFAULT_CLI_TOOLS, ...data.tools };
        console.log(`[CliRegistry] 加载了 ${Object.keys(this.tools).length} 个 CLI 工具配置`);
      } else {
        this.tools = { ...DEFAULT_CLI_TOOLS };
        this.saveRegistry();
        console.log('[CliRegistry] 创建默认注册表');
      }
    } catch (err) {
      console.error('[CliRegistry] 加载注册表失败:', err);
      this.tools = { ...DEFAULT_CLI_TOOLS };
    }
  }

  /**
   * 保存注册表
   */
  saveRegistry() {
    try {
      // 只保存非内置的工具
      const customTools = {};
      for (const [id, tool] of Object.entries(this.tools)) {
        if (!tool.builtin) {
          customTools[id] = tool;
        }
      }

      const data = {
        version: '1.0',
        updatedAt: new Date().toISOString(),
        tools: customTools
      };

      // 确保目录存在
      const dir = dirname(REGISTRY_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2));
      return true;
    } catch (err) {
      console.error('[CliRegistry] 保存注册表失败:', err);
      return false;
    }
  }

  /**
   * 获取所有已注册的 CLI 工具
   */
  getAllTools() {
    return Object.values(this.tools).filter(t => t.enabled);
  }

  /**
   * 获取指定 CLI 工具配置
   */
  getTool(id) {
    return this.tools[id] || null;
  }

  /**
   * 获取进程名到 CLI ID 的映射
   */
  getProcessNameMap() {
    const map = {};
    for (const tool of this.getAllTools()) {
      for (const processName of tool.processNames) {
        map[processName.toLowerCase()] = tool.id;
      }
    }
    return map;
  }

  /**
   * 通过进程名查找 CLI 工具
   */
  findByProcessName(processName) {
    const lowerName = processName.toLowerCase();
    for (const tool of this.getAllTools()) {
      if (tool.processNames.some(name => lowerName.includes(name.toLowerCase()))) {
        return tool;
      }
    }
    return null;
  }

  /**
   * 注册新的 CLI 工具
   */
  registerTool(config) {
    const id = config.id || config.name.toLowerCase().replace(/\s+/g, '-');

    if (this.tools[id]?.builtin) {
      return { success: false, error: '不能覆盖内置工具' };
    }

    const tool = {
      id,
      name: config.name,
      processNames: config.processNames || [id],
      terminalPatterns: config.terminalPatterns || {
        running: [],
        idle: [],
        confirm: []
      },
      commands: config.commands || {
        start: id,
        quit: 'exit'
      },
      builtin: false,
      enabled: true,
      createdAt: new Date().toISOString(),
      ...config
    };

    this.tools[id] = tool;
    this.saveRegistry();

    console.log(`[CliRegistry] 注册新工具: ${tool.name} (${id})`);
    return { success: true, tool };
  }

  /**
   * 更新 CLI 工具配置
   */
  updateTool(id, updates) {
    if (!this.tools[id]) {
      return { success: false, error: '工具不存在' };
    }

    if (this.tools[id].builtin && updates.processNames) {
      // 内置工具只允许添加进程名，不允许删除
      updates.processNames = [
        ...new Set([...this.tools[id].processNames, ...updates.processNames])
      ];
    }

    this.tools[id] = {
      ...this.tools[id],
      ...updates,
      updatedAt: new Date().toISOString()
    };

    this.saveRegistry();
    return { success: true, tool: this.tools[id] };
  }

  /**
   * 删除 CLI 工具
   */
  deleteTool(id) {
    if (!this.tools[id]) {
      return { success: false, error: '工具不存在' };
    }

    if (this.tools[id].builtin) {
      return { success: false, error: '不能删除内置工具' };
    }

    delete this.tools[id];
    this.saveRegistry();

    return { success: true };
  }

  /**
   * 启用/禁用 CLI 工具
   */
  setEnabled(id, enabled) {
    if (!this.tools[id]) {
      return { success: false, error: '工具不存在' };
    }

    this.tools[id].enabled = enabled;
    this.saveRegistry();

    return { success: true };
  }
}

// 导出单例
const cliRegistry = new CliRegistry();
export default cliRegistry;
