/**
 * ProcessDetector - 通过 tmux 进程检测 CLI 工具运行状态
 *
 * 比纯正则匹配更可靠，可以准确判断当前会话中运行的程序
 * 支持从 CliRegistry 动态加载 CLI 工具配置
 */

import { execSync } from 'child_process';
import cliRegistry from './CliRegistry.js';

// Windows/WSL 兼容层
const isWindows = process.platform === 'win32';
const useWSL = isWindows && process.env.WEBTMUX_USE_WSL === 'true';

// 获取命令前缀（Windows 上通过 WSL 执行 Unix 命令）
function getUnixCmdPrefix() {
  return useWSL ? 'wsl ' : '';
}

class ProcessDetector {
  constructor() {
    // 未知进程的学习记录
    this.unknownProcesses = new Map();
  }

  /**
   * 获取 CLI 工具进程名映射（从 CliRegistry 动态获取）
   */
  getCliProcessNames() {
    const map = {};
    for (const tool of cliRegistry.getAllTools()) {
      map[tool.id] = tool.processNames;
    }
    return map;
  }

  /**
   * 检测 tmux 会话中运行的 CLI 工具
   * @param {string} tmuxSession - tmux 会话名称
   * @returns {object} { detected: boolean, cli: string|null, processName: string|null, pid: number|null }
   */
  detectCLI(tmuxSession) {
    if (!tmuxSession) {
      return { detected: false, cli: null, processName: null, pid: null };
    }

    const cmdPrefix = getUnixCmdPrefix();

    try {
      // 获取 tmux pane 的 PID
      const panePid = execSync(
        `${cmdPrefix}tmux list-panes -t "${tmuxSession}" -F "#{pane_pid}"`,
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      if (!panePid) {
        return { detected: false, cli: null, processName: null, pid: null };
      }

      // 获取所有子进程
      const childPids = execSync(
        `${cmdPrefix}pgrep -P ${panePid} || true`,
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      if (!childPids) {
        return { detected: false, cli: null, processName: null, pid: null };
      }

      // 获取子进程的名称
      const pidList = childPids.split('\n').filter(p => p).join(',');
      const processInfo = execSync(
        `${cmdPrefix}ps -o pid=,comm= -p ${pidList} || true`,
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      if (!processInfo) {
        return { detected: false, cli: null, processName: null, pid: null };
      }

      // 解析进程信息，检测 CLI 工具
      const lines = processInfo.split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const pid = parseInt(parts[0]);
          const processName = parts[1].toLowerCase();

          // 检查是否是已知的 CLI 工具（从 CliRegistry 动态获取）
          const cliProcessNames = this.getCliProcessNames();
          for (const [cli, names] of Object.entries(cliProcessNames)) {
            if (names.some(name => processName.includes(name))) {
              return { detected: true, cli, processName: parts[1], pid };
            }
          }

          // 记录未知进程（用于学习）
          this._recordUnknownProcess(parts[1], tmuxSession);
        }
      }

      return { detected: false, cli: null, processName: null, pid: null };
    } catch (err) {
      console.error(`[ProcessDetector] 检测失败: ${err.message}`);
      return { detected: false, cli: null, processName: null, pid: null, error: err.message };
    }
  }

  /**
   * 检测 CLI 工具是否正在运行（简化版本）
   * @param {string} tmuxSession - tmux 会话名称
   * @returns {boolean}
   */
  isCliRunning(tmuxSession) {
    return this.detectCLI(tmuxSession).detected;
  }

  /**
   * 获取运行中的 CLI 类型
   * @param {string} tmuxSession - tmux 会话名称
   * @returns {string|null} 'claude' | 'codex' | 'gemini' | null
   */
  getRunningCLI(tmuxSession) {
    return this.detectCLI(tmuxSession).cli;
  }

  /**
   * 检测 tmux 会话中的前台进程（当前正在运行的命令）
   * @param {string} tmuxSession - tmux 会话名称
   * @returns {object} { command: string|null, pid: number|null }
   */
  getForegroundProcess(tmuxSession) {
    if (!tmuxSession) {
      return { command: null, pid: null };
    }

    const cmdPrefix = getUnixCmdPrefix();

    try {
      // 使用 tmux 获取当前 pane 的命令
      const result = execSync(
        `${cmdPrefix}tmux display-message -t "${tmuxSession}" -p "#{pane_current_command}"`,
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      if (result) {
        return { command: result, pid: null };
      }

      return { command: null, pid: null };
    } catch (err) {
      return { command: null, pid: null, error: err.message };
    }
  }

  /**
   * 综合检测：结合进程检测和终端内容分析
   * @param {string} tmuxSession - tmux 会话名称
   * @param {string} terminalContent - 终端内容（可选，用于回退检测）
   * @returns {object} 检测结果
   */
  detectWithFallback(tmuxSession, terminalContent = '') {
    // 优先使用进程检测
    const processResult = this.detectCLI(tmuxSession);

    if (processResult.detected) {
      return {
        method: 'process',
        detected: true,
        cli: processResult.cli,
        processName: processResult.processName,
        pid: processResult.pid
      };
    }

    // 进程检测失败，回退到终端内容分析
    if (terminalContent) {
      const cli = this.detectFromTerminalContent(terminalContent);
      if (cli) {
        return {
          method: 'terminal',
          detected: true,
          cli,
          processName: null,
          pid: null
        };
      }
    }

    return {
      method: 'none',
      detected: false,
      cli: null,
      processName: null,
      pid: null
    };
  }

  /**
   * 从终端内容检测 CLI 工具（回退方法）
   * @param {string} terminalContent - 终端内容
   * @returns {string|null} 'claude' | 'codex' | 'gemini' | null
   */
  detectFromTerminalContent(terminalContent) {
    if (!terminalContent) return null;

    // 清理 ANSI 转义序列
    const cleanContent = terminalContent.replace(/\x1b\[[0-9;]*m/g, '');
    const last500 = cleanContent.slice(-500);

    // Claude Code 特征
    if (/claude-code|Claude Code|anthropic.*cli/i.test(last500) ||
        /esc to interrupt.*claude|claude.*esc to interrupt/i.test(last500) ||
        /\? for shortcuts.*claude/i.test(last500)) {
      return 'claude';
    }

    // Codex CLI 特征
    if (/codex-cli|Codex CLI|openai.*codex/i.test(last500) ||
        /codex.*esc to interrupt|esc to interrupt.*codex/i.test(last500)) {
      return 'codex';
    }

    // Gemini CLI 特征
    if (/gemini-cli|Gemini CLI|google.*gemini/i.test(last500) ||
        /gemini.*GoogleSearch|ReadFile.*gemini/i.test(last500)) {
      return 'gemini';
    }

    // 通用 CLI 特征（无法确定具体类型）
    if (/esc to interrupt/i.test(last500) ||
        /\? for shortcuts/i.test(last500) ||
        /Press up to edit/i.test(last500)) {
      // 尝试从更多上下文判断
      if (/claude/i.test(cleanContent)) return 'claude';
      if (/codex/i.test(cleanContent)) return 'codex';
      if (/gemini/i.test(cleanContent)) return 'gemini';
      return 'claude'; // 默认假设是 Claude
    }

    return null;
  }

  /**
   * 检测 CLI 工具是否处于空闲状态（等待输入）
   * @param {string} tmuxSession - tmux 会话名称
   * @param {string} terminalContent - 终端内容
   * @returns {object} { isIdle: boolean, cli: string|null }
   */
  isCliIdle(tmuxSession, terminalContent) {
    const detection = this.detectWithFallback(tmuxSession, terminalContent);

    if (!detection.detected) {
      return { isIdle: false, cli: null };
    }

    // 检查终端内容是否显示空闲状态
    if (terminalContent) {
      const cleanContent = terminalContent.replace(/\x1b\[[0-9;]*m/g, '');
      const last200 = cleanContent.slice(-200);

      // 检测运行中标志
      const isRunning = /esc to interrupt/i.test(last200) ||
                        /\d+m\s*\d+s\s*$/m.test(last200) ||
                        /Thinking|Generating|Processing/i.test(last200);

      // 检测空闲标志
      const isIdle = /^>\s*$/m.test(last200) ||
                     /\? for shortcuts/i.test(last200) ||
                     /Press up to edit/i.test(last200);

      return {
        isIdle: isIdle && !isRunning,
        cli: detection.cli,
        isRunning
      };
    }

    return { isIdle: false, cli: detection.cli };
  }

  /**
   * 记录未知进程（用于学习）
   * @private
   */
  _recordUnknownProcess(processName, tmuxSession) {
    const key = processName.toLowerCase();

    // 排除常见的非 CLI 进程
    const ignoredProcesses = [
      'bash', 'zsh', 'sh', 'fish', 'node', 'python', 'ruby',
      'vim', 'nvim', 'nano', 'less', 'more', 'cat', 'grep',
      'ssh', 'tmux', 'screen', 'git', 'npm', 'yarn', 'pnpm'
    ];

    if (ignoredProcesses.includes(key)) {
      return;
    }

    const existing = this.unknownProcesses.get(key) || {
      processName,
      count: 0,
      sessions: new Set(),
      firstSeen: new Date().toISOString()
    };

    existing.count++;
    existing.sessions.add(tmuxSession);
    existing.lastSeen = new Date().toISOString();

    this.unknownProcesses.set(key, existing);
  }

  /**
   * 获取未知进程列表（用于学习建议）
   */
  getUnknownProcesses() {
    const result = [];
    for (const [key, data] of this.unknownProcesses) {
      result.push({
        processName: data.processName,
        count: data.count,
        sessionCount: data.sessions.size,
        firstSeen: data.firstSeen,
        lastSeen: data.lastSeen
      });
    }
    return result.sort((a, b) => b.count - a.count);
  }

  /**
   * 清除未知进程记录
   */
  clearUnknownProcesses() {
    this.unknownProcesses.clear();
  }

  /**
   * 从未知进程学习并注册为新 CLI 工具
   */
  learnFromUnknownProcess(processName, config = {}) {
    const tool = cliRegistry.registerTool({
      id: config.id || processName.toLowerCase(),
      name: config.name || processName,
      processNames: [processName, ...(config.processNames || [])],
      terminalPatterns: config.terminalPatterns,
      commands: config.commands
    });

    if (tool.success) {
      // 从未知列表中移除
      this.unknownProcesses.delete(processName.toLowerCase());
    }

    return tool;
  }
}

// 导出单例
const processDetector = new ProcessDetector();
export default processDetector;
