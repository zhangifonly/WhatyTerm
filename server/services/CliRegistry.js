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
  droid: {
    id: 'droid',
    name: 'Droid AI (Factory)',
    processNames: ['droid', 'factory', 'factory-cli'],
    terminalPatterns: {
      running: ['esc to interrupt', '\\(\\d+m\\s*\\d+s\\)', 'Thinking'],
      idle: ['^>\\s*', 'IDE\\s*⚙', '\\? for help'],
      confirm: ['Do you want to', 'Auto \\(Off\\)']
    },
    commands: {
      start: 'droid',
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
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    processNames: ['opencode', 'opencode-cli'],
    terminalPatterns: {
      running: ['esc to interrupt', '\\(\\d+m\\s*\\d+s\\)', '\\[build\\].*thinking', '\\[plan\\].*thinking', 'Thinking'],
      idle: ['^>\\s*$', '@general', '\\[build\\]\\s*$', '\\[plan\\]\\s*$', '\\? for shortcuts'],
      confirm: ['Do you want to', '1\\.\\s*Yes', 'approve this action']
    },
    commands: {
      start: 'opencode',
      quit: '/quit'
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
   * 通过命令查找 CLI 工具
   * @param {string} cmd - 用户输入的命令（如 "droid", "claude -c"）
   */
  findByCommand(cmd) {
    const cmdLower = cmd.toLowerCase().trim();
    const cmdFirst = cmdLower.split(/\s+/)[0]; // 取第一个词

    for (const tool of this.getAllTools()) {
      // 检查进程名
      if (tool.processNames.some(name => name.toLowerCase() === cmdFirst)) {
        return tool;
      }
      // 检查启动命令
      if (tool.commands?.start) {
        const startCmd = tool.commands.start.toLowerCase().split(/\s+/)[0];
        if (startCmd === cmdFirst) {
          return tool;
        }
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
