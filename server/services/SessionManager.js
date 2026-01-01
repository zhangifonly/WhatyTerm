import pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Windows/WSL 兼容层
const isWindows = process.platform === 'win32';

// 检测 WSL 是否可用
let wslAvailable = false;
if (isWindows) {
  try {
    execSync('wsl --status', { stdio: 'pipe', timeout: 3000 });
    wslAvailable = true;
    console.log('[SessionManager] 检测到 WSL 可用，将使用 WSL + tmux');
  } catch {
    console.log('[SessionManager] WSL 不可用，将使用 Windows 原生终端（无会话持久化）');
  }
}

const useWSL = isWindows && wslAvailable;
const useTmux = !isWindows || useWSL;  // 非 Windows 或 Windows+WSL 时使用 tmux

// 执行 tmux 命令（在 Windows 上通过 WSL）
function execTmux(command, options = {}) {
  if (!useTmux) {
    throw new Error('tmux 不可用（Windows 原生模式）');
  }
  const fullCommand = useWSL ? `wsl ${command}` : command;
  return execSync(fullCommand, {
    encoding: 'utf-8',
    stdio: options.stdio || 'pipe',
    timeout: options.timeout || 5000,
    ...options
  });
}

// 获取 tmux 命令前缀
function getTmuxPrefix() {
  return useWSL ? 'wsl tmux' : 'tmux';
}

// 获取当前激活的 API 供应商信息
function getCurrentApiProvider() {
  try {
    const ccSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

    if (!fs.existsSync(ccSwitchDbPath)) {
      return { name: '未配置', url: '' };
    }

    const db = new Database(ccSwitchDbPath, { readonly: true });
    const row = db.prepare('SELECT * FROM providers WHERE app_type = ? AND is_current = 1').get('claude');
    db.close();

    if (!row) {
      return { name: '未配置', url: '' };
    }

    let settingsConfig = {};
    try {
      if (row.settings_config) {
        settingsConfig = JSON.parse(row.settings_config);
      }
    } catch (parseError) {
      console.error('[Session] 解析 settings_config 失败:', parseError);
    }

    // 从 env.ANTHROPIC_BASE_URL 获取 API 地址
    const url = settingsConfig.env?.ANTHROPIC_BASE_URL || settingsConfig.baseURL || '';

    return {
      name: row.name || '未命名',
      url: url
    };
  } catch (error) {
    console.error('[Session] 获取 API 供应商失败:', error);
    return { name: '未配置', url: '' };
  }
}

// 验证并清理 tmux 会话名称，防止命令注入
function sanitizeTmuxSessionName(name) {
  if (!name) return null;
  // 只允许字母、数字、连字符和下划线
  return name.replace(/[^a-zA-Z0-9_-]/g, '');
}

export class Session {
  constructor(options) {
    this.id = options.id || uuidv4();
    this.name = options.name || `session-${Date.now()}`;
    // 验证 tmuxSessionName，防止命令注入
    const rawTmuxName = options.tmuxSessionName || `webtmux-${this.id.slice(0, 8)}`;
    this.tmuxSessionName = sanitizeTmuxSessionName(rawTmuxName);
    this.goal = options.goal || '';
    this.originalGoal = options.originalGoal || options.goal || '';  // 保存原始目标
    this.systemPrompt = options.systemPrompt || '';
    this.aiEnabled = options.aiEnabled ?? true;
    this.autoMode = options.autoMode ?? false;
    this.autoActionEnabled = options.autoActionEnabled ?? false;  // 后台自动操作开关
    this.status = 'running';
    this.createdAt = options.createdAt || new Date();
    this.updatedAt = new Date();
    this.apiProvider = options.apiProvider || { name: '加载中...', url: '' }; // API 供应商信息

    this.outputBuffer = '';
    this.outputCallbacks = [];
    this.bellCallbacks = [];  // bell 事件回调（Claude Code 需要输入时触发）
    this.isAnalyzing = false;
    this.analysisTimer = null;
    this.autoActionTimer = null;  // 后台自动操作定时器
    this.autoCommandCount = 0;
    this.pty = null;
    this.attachCount = 0;

    if (!options.skipPty) {
      this._ensureTmuxSession(options.isNew);
    }

    // 如果是新会话且没有提供 apiProvider，则获取当前 API 信息
    if (options.isNew && !options.apiProvider) {
      this._loadApiProvider();
    }
  }

  async _loadApiProvider() {
    try {
      this.apiProvider = await getCurrentApiProvider();
      console.log(`[Session] ${this.id} API 供应商: ${this.apiProvider.name}`);
    } catch (error) {
      console.error('[Session] 加载 API 供应商失败:', error);
      this.apiProvider = { name: '未配置', url: '' };
    }
  }

  _ensureTmuxSession(isNew = true) {
    // Windows 原生模式：不使用 tmux，直接创建 PTY
    if (!useTmux) {
      console.log(`[Session] Windows 原生模式，跳过 tmux 初始化: ${this.tmuxSessionName}`);
      return;
    }

    const tmuxCmd = getTmuxPrefix();
    try {
      if (isNew) {
        // 创建新的 tmux 会话
        execSync(`${tmuxCmd} new-session -d -s "${this.tmuxSessionName}" -x 80 -y 24`, {
          stdio: 'ignore'
        });
        console.log(`创建 tmux 会话: ${this.tmuxSessionName}`);
        this._attachToTmux();
      } else {
        try {
          execSync(`${tmuxCmd} has-session -t "${this.tmuxSessionName}"`, {
            stdio: 'pipe'
          });
          console.log(`tmux 会话已存在: ${this.tmuxSessionName}`);
        } catch {
          execSync(`${tmuxCmd} new-session -d -s "${this.tmuxSessionName}" -x 80 -y 24`, {
            stdio: 'ignore'
          });
          console.log(`重新创建 tmux 会话: ${this.tmuxSessionName}`);
        }
      }
      // 统一设置 tmux 选项（无论新建还是已存在）
      this._configureTmuxSession();
    } catch (err) {
      console.error(`初始化 tmux 会话失败: ${err.message}`);
    }
  }

  // 配置 tmux 会话选项
  _configureTmuxSession() {
    const tmuxCmd = getTmuxPrefix();
    try {
      // 设置 history-limit 为 10000 行
      execSync(`${tmuxCmd} set-option -t "${this.tmuxSessionName}" history-limit 10000`, {
        stdio: 'ignore'
      });
      // 启用鼠标模式，支持鼠标滚轮滚动
      execSync(`${tmuxCmd} set-option -t "${this.tmuxSessionName}" mouse on`, {
        stdio: 'ignore'
      });
    } catch (err) {
      console.error(`配置 tmux 会话失败: ${err.message}`);
    }
  }

  attach() {
    this.attachCount++;
    if (!this.pty) {
      this._attachToTmux();
    }
    // 每次 attach 时确保鼠标模式开启
    this._configureTmuxSession();
  }

  detach() {
    this.attachCount = Math.max(0, this.attachCount - 1);
  }

  _attachToTmux() {
    if (this.pty) return;

    // Windows 原生模式：直接创建 PowerShell PTY
    if (!useTmux) {
      console.log(`[Session] Windows 原生模式，创建 PowerShell PTY: ${this.tmuxSessionName}`);

      // 使用 PowerShell 作为默认 shell（比 cmd.exe 更现代）
      const shell = 'powershell.exe';
      const args = ['-NoLogo'];  // 不显示 PowerShell 启动 logo

      this.pty = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.env.USERPROFILE || process.env.HOME,  // Windows 用户目录
        env: {
          ...process.env,
          TERM: 'xterm-256color'
        }
      });

      this.pty.onData((data) => {
        this.outputBuffer += data;
        if (this.outputBuffer.length > 100000) {
          this.outputBuffer = this.outputBuffer.slice(-50000);
        }
        this.outputCallbacks.forEach(cb => cb(data));

        // 检测 bell 字符（\x07）- Claude Code 需要用户输入时会发送
        if (data.includes('\x07')) {
          this.bellCallbacks.forEach(cb => cb());
        }
      });

      this.pty.onExit(({ exitCode }) => {
        console.log(`PTY 退出: ${this.tmuxSessionName}, code=${exitCode}`);
        this.pty = null;

        // Windows 原生模式：PTY 退出后重新创建
        if (this.attachCount > 0) {
          console.log(`重新创建 Windows PTY: ${this.tmuxSessionName}`);
          this.outputCallbacks.forEach(cb => cb('\r\n\x1b[33m[终端已重启]\x1b[0m\r\n'));
          setTimeout(() => {
            this._attachToTmux();
          }, 1000);
        }
      });

      return;
    }

    // tmux 模式（Linux/macOS 或 Windows+WSL）
    const shell = useWSL ? 'wsl' : 'tmux';
    const args = useWSL
      ? ['tmux', 'attach-session', '-t', this.tmuxSessionName]
      : ['attach-session', '-t', this.tmuxSessionName];

    this.pty = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: isWindows ? undefined : process.env.HOME,
      env: {
        ...process.env,
        TERM: 'xterm-256color'
      }
    });

    this.pty.onData((data) => {
      this.outputBuffer += data;
      if (this.outputBuffer.length > 100000) {
        this.outputBuffer = this.outputBuffer.slice(-50000);
      }
      this.outputCallbacks.forEach(cb => cb(data));

      // 检测 bell 字符（\x07）- Claude Code 需要用户输入时会发送
      if (data.includes('\x07')) {
        this.bellCallbacks.forEach(cb => cb());
      }
    });

    this.pty.onExit(({ exitCode }) => {
      console.log(`PTY 退出: ${this.tmuxSessionName}, code=${exitCode}`);
      this.pty = null;

      // 检查 tmux 会话是否还存在，如果不存在则重新创建
      if (this.attachCount > 0) {
        try {
          execSync(`${getTmuxPrefix()} has-session -t "${this.tmuxSessionName}"`, { stdio: 'pipe' });
        } catch {
          // tmux 会话已退出，重新创建
          console.log(`重新创建 tmux 会话: ${this.tmuxSessionName}`);
          try {
            execSync(`${getTmuxPrefix()} new-session -d -s "${this.tmuxSessionName}" -x 80 -y 24`, {
              stdio: 'ignore'
            });
            // 通知客户端会话已重启
            this.outputCallbacks.forEach(cb => cb('\r\n\x1b[33m[会话已重启]\x1b[0m\r\n'));
            // 重新连接
            this._attachToTmux();
          } catch (err) {
            console.error(`重新创建 tmux 会话失败: ${err.message}`);
          }
        }
      }
    });
  }

  write(data) {
    if (!this.pty) {
      this._attachToTmux();
    }
    if (this.pty) {
      this.pty.write(data);
    }
  }

  resize(cols, rows) {
    if (this.pty) {
      this.pty.resize(cols, rows);
    }

    // Windows 原生模式：只调整 PTY 大小，无需调整 tmux
    if (!useTmux) {
      return;
    }

    // 同时调整 tmux 窗口大小
    try {
      execSync(`${getTmuxPrefix()} resize-window -t "${this.tmuxSessionName}" -x ${cols} -y ${rows}`, {
        stdio: 'ignore'
      });
    } catch {}
  }

  onOutput(callback) {
    this.outputCallbacks.push(callback);
    return callback;
  }

  offOutput(callback) {
    const index = this.outputCallbacks.indexOf(callback);
    if (index > -1) {
      this.outputCallbacks.splice(index, 1);
    }
  }

  clearOutputCallbacks() {
    this.outputCallbacks = [];
  }

  onBell(callback) {
    this.bellCallbacks.push(callback);
    return callback;
  }

  offBell(callback) {
    const index = this.bellCallbacks.indexOf(callback);
    if (index > -1) {
      this.bellCallbacks.splice(index, 1);
    }
  }

  updateSettings(settings) {
    if (settings.goal !== undefined) this.goal = settings.goal;
    if (settings.systemPrompt !== undefined) this.systemPrompt = settings.systemPrompt;
    if (settings.aiEnabled !== undefined) this.aiEnabled = settings.aiEnabled;
    if (settings.autoMode !== undefined) {
      this.autoMode = settings.autoMode;
      if (settings.autoMode) {
        this.autoCommandCount = 0;
      }
    }
    if (settings.autoActionEnabled !== undefined) {
      this.autoActionEnabled = settings.autoActionEnabled;
    }
    this.updatedAt = new Date();
  }

  getRecentOutput(lines = 50) {
    const allLines = this.outputBuffer.split('\n');
    return allLines.slice(-lines).join('\n');
  }

  // 获取 tmux 面板的当前可见内容
  capturePane() {
    // Windows 原生模式：返回输出缓冲区内容
    if (!useTmux) {
      return this.getRecentOutput(50);
    }

    try {
      const content = execSync(
        `tmux capture-pane -t "${this.tmuxSessionName}" -p -e`,
        { encoding: 'utf-8' }
      );
      return content.replace(/\n/g, '\r\n');
    } catch {
      return '';
    }
  }

  // 获取 tmux 面板的完整内容（包含滚动历史）
  captureFullPane() {
    // Windows 原生模式：返回完整输出缓冲区
    if (!useTmux) {
      return this.outputBuffer;
    }

    try {
      const content = execSync(
        `tmux capture-pane -t "${this.tmuxSessionName}" -p -e -S -`,
        { encoding: 'utf-8' }
      );
      return content.replace(/\n/g, '\r\n');
    } catch {
      return '';
    }
  }

  // 获取滚动历史行数
  getHistorySize() {
    // Windows 原生模式：返回缓冲区行数
    if (!useTmux) {
      return this.outputBuffer.split('\n').length;
    }

    try {
      const size = execSync(
        `tmux display-message -t "${this.tmuxSessionName}" -p "#{history_size}"`,
        { encoding: 'utf-8' }
      ).trim();
      return parseInt(size, 10) || 0;
    } catch {
      return 0;
    }
  }


  // 获取光标位置
  getCursorPosition() {
    // Windows 原生模式：无法获取光标位置
    if (!useTmux) {
      return null;
    }

    try {
      const info = execSync(
        `tmux display-message -t "${this.tmuxSessionName}" -p "#{cursor_x},#{cursor_y}"`,
        { encoding: 'utf-8' }
      ).trim();
      const [x, y] = info.split(',').map(n => parseInt(n, 10));
      return { x: x + 1, y: y + 1 }; // 转为 1-based
    } catch {
      return null;
    }
  }

  refreshScreen() {
    // Windows 原生模式：无需刷新
    if (!useTmux) {
      return;
    }

    // 发送 tmux 刷新命令，让 tmux 重新绘制整个屏幕
    try {
      execSync(`${getTmuxPrefix()} refresh-client -t "${this.tmuxSessionName}"`, {
        stdio: 'ignore'
      });
    } catch {}
  }

  getScreenContent() {
    return this.capturePane();
  }

  destroy() {
    if (this.pty) {
      try {
        // 先尝试优雅终止
        this.pty.kill('SIGTERM');
        // 设置超时强制终止
        const ptyRef = this.pty;
        setTimeout(() => {
          try {
            if (ptyRef && !ptyRef.killed) {
              ptyRef.kill('SIGKILL');
            }
          } catch (e) {
            // 忽略强制终止错误
          }
        }, 3000);
      } catch (err) {
        console.error(`[Session] PTY 终止失败: ${err.message}`);
      }
      this.pty = null;
    }
    if (this.analysisTimer) {
      clearTimeout(this.analysisTimer);
      this.analysisTimer = null;
    }
    if (this.autoActionTimer) {
      clearTimeout(this.autoActionTimer);
      this.autoActionTimer = null;
    }
    // 清理回调
    this.outputCallbacks = [];
    // 不删除 tmux session，保留以便恢复
  }

  killTmuxSession() {
    // Windows 原生模式：无 tmux 会话需要杀掉
    if (!useTmux) {
      return;
    }

    try {
      execSync(`${getTmuxPrefix()} kill-session -t "${this.tmuxSessionName}"`, {
        stdio: 'ignore'
      });
    } catch {}
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      tmuxSessionName: this.tmuxSessionName,
      goal: this.goal,
      originalGoal: this.originalGoal,  // 原始目标
      systemPrompt: this.systemPrompt,
      aiEnabled: this.aiEnabled,
      autoMode: this.autoMode,
      autoActionEnabled: this.autoActionEnabled,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      projectName: this.projectName,
      projectDesc: this.projectDesc,
      workingDir: this.workingDir,
      apiProvider: this.apiProvider,  // 添加 API 供应商信息
      // CLI 工具类型和供应商信息（用于监控面板顶部显示）
      aiType: this.aiType || null,
      claudeProvider: this.claudeProvider || null,
      codexProvider: this.codexProvider || null,
      geminiProvider: this.geminiProvider || null,
      // 操作统计
      stats: this.stats || { total: 0, success: 0, failed: 0, aiAnalyzed: 0, preAnalyzed: 0 }
    };
  }
}

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this._initDb();
    this._loadSessions();
  }

  /**
   * 获取数据库文件路径
   * 与 ProviderService 使用相同的逻辑，确保数据库文件在同一目录
   */
  _getDbPath() {
    // 如果设置了环境变量，优先使用
    if (process.env.WEBTMUX_DB_DIR) {
      return join(process.env.WEBTMUX_DB_DIR, 'webtmux.db');
    }

    // 统一使用用户数据目录
    const homeDir = os.homedir();
    const userDataDir = join(homeDir, '.webtmux', 'db');

    // 如果用户数据目录存在，使用它
    if (fs.existsSync(userDataDir)) {
      return join(userDataDir, 'webtmux.db');
    }

    // 否则检查项目目录的数据库是否存在（向后兼容）
    const projectDbPath = join(__dirname, '../db/webtmux.db');

    if (fs.existsSync(projectDbPath)) {
      // 如果项目目录有数据库，迁移到用户数据目录
      console.log('[SessionManager] 检测到项目目录数据库，准备迁移到用户数据目录');

      // 确保目标目录存在
      if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
      }

      const userDbPath = join(userDataDir, 'webtmux.db');

      // 复制数据库文件
      try {
        fs.copyFileSync(projectDbPath, userDbPath);
        console.log('[SessionManager] 数据库迁移完成');
        console.log(`[SessionManager] 新数据库位置: ${userDbPath}`);
      } catch (error) {
        console.error('[SessionManager] 数据库迁移失败:', error);
        // 迁移失败，继续使用项目目录
        return projectDbPath;
      }

      return userDbPath;
    }

    // 都不存在，使用用户数据目录（新安装）
    // 确保目录存在
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    return join(userDataDir, 'webtmux.db');
  }

  _initDb() {
    const dbPath = this._getDbPath();
    this.db = new Database(dbPath);
    console.log(`[SessionManager] 使用数据库: ${dbPath}`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        tmux_session_name TEXT,
        goal TEXT,
        system_prompt TEXT,
        ai_enabled INTEGER DEFAULT 1,
        auto_mode INTEGER DEFAULT 0,
        auto_action_enabled INTEGER DEFAULT 0,
        status TEXT DEFAULT 'running',
        created_at TEXT,
        updated_at TEXT
      )
    `);

    // 创建关闭会话表（用于恢复功能）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS closed_sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        tmux_session_name TEXT,
        goal TEXT,
        system_prompt TEXT,
        ai_enabled INTEGER DEFAULT 1,
        auto_mode INTEGER DEFAULT 0,
        auto_action_enabled INTEGER DEFAULT 0,
        ai_type TEXT DEFAULT 'claude',
        project_name TEXT,
        project_desc TEXT,
        work_dir TEXT,
        closed_at INTEGER NOT NULL
      )
    `);

    // 添加新字段（如果不存在）
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN auto_action_enabled INTEGER DEFAULT 0`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN ai_type TEXT DEFAULT 'claude'`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN claude_provider TEXT`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN codex_provider TEXT`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN gemini_provider TEXT`);
    } catch {}
    // 添加操作统计字段
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN stats_total INTEGER DEFAULT 0`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN stats_success INTEGER DEFAULT 0`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN stats_failed INTEGER DEFAULT 0`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN stats_ai_analyzed INTEGER DEFAULT 0`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN stats_pre_analyzed INTEGER DEFAULT 0`);
    } catch {}
    // 添加原始目标字段
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN original_goal TEXT`);
    } catch {}
    // 修复旧数据：如果 original_goal 为空但 goal 有值，则复制 goal 到 original_goal
    try {
      this.db.exec(`UPDATE sessions SET original_goal = goal WHERE original_goal IS NULL AND goal IS NOT NULL AND goal <> ''`);
    } catch {}
  }

  _loadSessions() {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE status = ?').all('running');
    for (const row of rows) {
      const session = new Session({
        id: row.id,
        name: row.name,
        tmuxSessionName: row.tmux_session_name,
        goal: row.goal,
        originalGoal: row.original_goal || row.goal,
        systemPrompt: row.system_prompt,
        aiEnabled: !!row.ai_enabled,
        autoMode: !!row.auto_mode,
        autoActionEnabled: !!row.auto_action_enabled,
        createdAt: new Date(row.created_at),
        skipPty: false,
        isNew: false  // 恢复已有会话
      });

      // 恢复 AI 类型和供应商信息
      session.aiType = row.ai_type || 'claude';
      try {
        session.claudeProvider = row.claude_provider ? JSON.parse(row.claude_provider) : null;
      } catch (e) {
        session.claudeProvider = null;
      }
      try {
        session.codexProvider = row.codex_provider ? JSON.parse(row.codex_provider) : null;
      } catch (e) {
        session.codexProvider = null;
      }
      try {
        session.geminiProvider = row.gemini_provider ? JSON.parse(row.gemini_provider) : null;
      } catch (e) {
        session.geminiProvider = null;
      }

      // 恢复操作统计
      session.stats = {
        total: row.stats_total || 0,
        success: row.stats_success || 0,
        failed: row.stats_failed || 0,
        aiAnalyzed: row.stats_ai_analyzed || 0,
        preAnalyzed: row.stats_pre_analyzed || 0
      };

      this.sessions.set(session.id, session);
      console.log(`恢复会话: ${session.name} (tmux: ${session.tmuxSessionName}, AI: ${session.aiType}, 自动操作: ${session.autoActionEnabled ? '开' : '关'})`);
    }
  }

  _saveSession(session) {
    const stats = session.stats || { total: 0, success: 0, failed: 0, aiAnalyzed: 0, preAnalyzed: 0 };
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions
      (id, name, tmux_session_name, goal, original_goal, system_prompt, ai_enabled, auto_mode, auto_action_enabled, status, created_at, updated_at, ai_type, claude_provider, codex_provider, gemini_provider, stats_total, stats_success, stats_failed, stats_ai_analyzed, stats_pre_analyzed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      session.id,
      session.name,
      session.tmuxSessionName,
      session.goal,
      session.originalGoal || session.goal,
      session.systemPrompt,
      session.aiEnabled ? 1 : 0,
      session.autoMode ? 1 : 0,
      session.autoActionEnabled ? 1 : 0,
      session.status,
      session.createdAt.toISOString(),
      session.updatedAt.toISOString(),
      session.aiType || 'claude',
      session.claudeProvider ? JSON.stringify(session.claudeProvider) : null,
      session.codexProvider ? JSON.stringify(session.codexProvider) : null,
      session.geminiProvider ? JSON.stringify(session.geminiProvider) : null,
      stats.total,
      stats.success,
      stats.failed,
      stats.aiAnalyzed,
      stats.preAnalyzed
    );
  }

  async createSession(options) {
    const session = new Session({ ...options, isNew: true });
    this.sessions.set(session.id, session);
    this._saveSession(session);
    return session;
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  listSessions() {
    return Array.from(this.sessions.values()).map(s => s.toJSON());
  }

  updateSession(session) {
    this._saveSession(session);
  }

  /**
   * 更新会话统计并保存
   * @param {string} sessionId - 会话 ID
   * @param {object} statUpdate - 统计更新 { success?: boolean, aiAnalyzed?: boolean, preAnalyzed?: boolean }
   */
  updateSessionStats(sessionId, statUpdate) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // 初始化 stats（如果不存在）
    if (!session.stats) {
      session.stats = { total: 0, success: 0, failed: 0, aiAnalyzed: 0, preAnalyzed: 0 };
    }

    // 更新统计
    session.stats.total++;
    if (statUpdate.success === true) {
      session.stats.success++;
    } else if (statUpdate.success === false) {
      session.stats.failed++;
    }
    if (statUpdate.aiAnalyzed) {
      session.stats.aiAnalyzed++;
    }
    if (statUpdate.preAnalyzed) {
      session.stats.preAnalyzed++;
    }

    // 保存到数据库
    this._saveSession(session);
  }

  /**
   * 关闭会话（可恢复）
   * 保留 tmux 会话，将会话信息保存到 closed_sessions 表
   */
  closeSession(id) {
    const session = this.sessions.get(id);
    if (!session) {
      return { success: false, error: '会话不存在' };
    }

    try {
      // 停止 pty 但不杀 tmux 会话
      session.destroy();

      // 保存到 closed_sessions 表
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO closed_sessions
        (id, name, tmux_session_name, goal, system_prompt, ai_enabled, auto_mode, auto_action_enabled, ai_type, project_name, project_desc, work_dir, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        session.id,
        session.name,
        session.tmuxSessionName,
        session.goal || '',
        session.systemPrompt || '',
        session.aiEnabled ? 1 : 0,
        session.autoMode ? 1 : 0,
        session.autoActionEnabled ? 1 : 0,
        session.aiType || 'claude',
        session.projectName || '',
        session.projectDesc || '',
        session.workDir || '',
        Date.now()
      );

      // 从 sessions 表中删除
      const deleteStmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
      deleteStmt.run(id);

      // 从内存中移除
      this.sessions.delete(id);

      console.log(`[SessionManager] 会话已关闭（可恢复）: ${session.name}`);
      return { success: true, closedSession: this._getClosedSessionById(id) };
    } catch (error) {
      console.error('[SessionManager] 关闭会话失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 恢复关闭的会话
   */
  restoreSession(closedSessionId) {
    try {
      const closedSession = this._getClosedSessionById(closedSessionId);
      if (!closedSession) {
        return { success: false, error: '关闭的会话不存在' };
      }

      // Windows 原生模式：无需检查 tmux 会话，直接恢复
      if (!useTmux) {
        const session = new Session({
          id: closedSession.id,
          name: closedSession.name,
          tmuxSessionName: closedSession.tmuxSessionName,
          goal: closedSession.goal,
          systemPrompt: closedSession.systemPrompt,
          aiEnabled: closedSession.aiEnabled,
          autoMode: closedSession.autoMode,
          autoActionEnabled: closedSession.autoActionEnabled,
          aiType: closedSession.aiType,
          projectName: closedSession.projectName,
          projectDesc: closedSession.projectDesc,
          workDir: closedSession.workDir,
          isNew: true,  // Windows 原生模式：创建新的 PTY
          skipPty: false
        });

        this.sessions.set(session.id, session);
        this._saveSession(session);

        const deleteStmt = this.db.prepare('DELETE FROM closed_sessions WHERE id = ?');
        deleteStmt.run(closedSessionId);

        console.log(`[SessionManager] 会话已恢复（Windows 原生模式）: ${session.name}`);
        return { success: true, session: session.toJSON() };
      }

      // tmux 模式：检查 tmux 会话是否还存在
      let tmuxExists = false;
      try {
        execSync(`${getTmuxPrefix()} has-session -t ${closedSession.tmuxSessionName}`, { stdio: 'pipe' });
        tmuxExists = true;
      } catch {
        tmuxExists = false;
      }

      if (!tmuxExists) {
        // tmux 会话已失效，删除记录并返回错误
        this.deleteClosedSession(closedSessionId);
        return { success: false, error: '会话已失效，tmux 进程不存在', expired: true };
      }

      // 创建新的 Session 对象并恢复
      const session = new Session({
        id: closedSession.id,
        name: closedSession.name,
        tmuxSessionName: closedSession.tmuxSessionName,
        goal: closedSession.goal,
        systemPrompt: closedSession.systemPrompt,
        aiEnabled: closedSession.aiEnabled,
        autoMode: closedSession.autoMode,
        autoActionEnabled: closedSession.autoActionEnabled,
        aiType: closedSession.aiType,
        projectName: closedSession.projectName,
        projectDesc: closedSession.projectDesc,
        workDir: closedSession.workDir,
        isNew: false,
        skipPty: false
      });

      // 添加到内存
      this.sessions.set(session.id, session);

      // 保存到 sessions 表
      this._saveSession(session);

      // 从 closed_sessions 表中删除
      const deleteStmt = this.db.prepare('DELETE FROM closed_sessions WHERE id = ?');
      deleteStmt.run(closedSessionId);

      console.log(`[SessionManager] 会话已恢复: ${session.name}`);
      return { success: true, session: session.toJSON() };
    } catch (error) {
      console.error('[SessionManager] 恢复会话失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取关闭的会话列表
   */
  getClosedSessions() {
    try {
      // 清理超过24小时的旧记录
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      this.db.prepare('DELETE FROM closed_sessions WHERE closed_at < ?').run(oneDayAgo);

      // 获取最近的关闭会话（最多10个）
      const stmt = this.db.prepare(`
        SELECT * FROM closed_sessions
        ORDER BY closed_at DESC
        LIMIT 10
      `);
      const rows = stmt.all();

      // Windows 原生模式：直接返回所有会话（无需检查 tmux）
      if (!useTmux) {
        return rows.map(row => ({
          id: row.id,
          name: row.name,
          tmuxSessionName: row.tmux_session_name,
          goal: row.goal,
          aiType: row.ai_type,
          projectName: row.project_name,
          projectDesc: row.project_desc,
          workDir: row.work_dir,
          closedAt: row.closed_at
        }));
      }

      // tmux 模式：检查每个会话的 tmux 是否还存在
      const validSessions = [];
      for (const row of rows) {
        let tmuxExists = false;
        try {
          execSync(`${getTmuxPrefix()} has-session -t ${row.tmux_session_name}`, { stdio: 'pipe' });
          tmuxExists = true;
        } catch {
          tmuxExists = false;
        }

        if (tmuxExists) {
          validSessions.push({
            id: row.id,
            name: row.name,
            tmuxSessionName: row.tmux_session_name,
            goal: row.goal,
            aiType: row.ai_type,
            projectName: row.project_name,
            projectDesc: row.project_desc,
            workDir: row.work_dir,
            closedAt: row.closed_at
          });
        } else {
          // tmux 已不存在，删除记录
          this.db.prepare('DELETE FROM closed_sessions WHERE id = ?').run(row.id);
        }
      }

      return validSessions;
    } catch (error) {
      console.error('[SessionManager] 获取关闭会话列表失败:', error);
      return [];
    }
  }

  /**
   * 永久删除关闭的会话
   */
  deleteClosedSession(closedSessionId) {
    try {
      const closedSession = this._getClosedSessionById(closedSessionId);
      if (!closedSession) {
        return { success: false, error: '会话不存在' };
      }

      // Windows 原生模式：无需杀 tmux 会话
      if (!useTmux) {
        const stmt = this.db.prepare('DELETE FROM closed_sessions WHERE id = ?');
        stmt.run(closedSessionId);
        console.log(`[SessionManager] 已永久删除关闭的会话（Windows 原生模式）: ${closedSession.name}`);
        return { success: true };
      }

      // tmux 模式：尝试杀掉 tmux 会话
      try {
        execSync(`${getTmuxPrefix()} kill-session -t ${closedSession.tmuxSessionName}`, { stdio: 'pipe' });
      } catch {
        // tmux 会话可能已经不存在，忽略错误
      }

      // 从数据库中删除
      const stmt = this.db.prepare('DELETE FROM closed_sessions WHERE id = ?');
      stmt.run(closedSessionId);

      console.log(`[SessionManager] 已永久删除关闭的会话: ${closedSession.name}`);
      return { success: true };
    } catch (error) {
      console.error('[SessionManager] 永久删除会话失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取单个关闭会话的详情
   */
  _getClosedSessionById(id) {
    const stmt = this.db.prepare('SELECT * FROM closed_sessions WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      tmuxSessionName: row.tmux_session_name,
      goal: row.goal,
      systemPrompt: row.system_prompt,
      aiEnabled: Boolean(row.ai_enabled),
      autoMode: Boolean(row.auto_mode),
      autoActionEnabled: Boolean(row.auto_action_enabled),
      aiType: row.ai_type,
      projectName: row.project_name,
      projectDesc: row.project_desc,
      workDir: row.work_dir,
      closedAt: row.closed_at
    };
  }

  deleteSession(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.destroy();
      session.killTmuxSession();
      session.status = 'deleted';
      this._saveSession(session);
      this.sessions.delete(id);
      return true;
    }
    return false;
  }
}
