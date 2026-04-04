/**
 * HookServer - Claude Code 官方 Hooks 集成
 *
 * 负责：
 * 1. 生成并持久化 auth token（防止外部伪造事件）
 * 2. 安装 hook 脚本到 ~/.webtmux/hooks/（端口变更时自动重写）
 * 3. 合并 hook 配置到 ~/.claude/settings.json
 * 4. 提供事件分发（dispatch / on）
 * 5. 将收到的事件写入 ~/.webtmux/hook-events.log（最近 200 条）
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

const MAX_LOG_LINES = 200;

class HookServer {
  constructor(serverPort = 3928) {
    this.serverPort = serverPort;
    this.webtmuxDir = join(homedir(), '.webtmux');
    this.hooksDir = join(this.webtmuxDir, 'hooks');
    this.tokenPath = join(this.webtmuxDir, 'hook-token');
    this.logPath = join(this.webtmuxDir, 'hook-events.log');
    this.token = this._loadOrCreateToken();
    this.handlers = new Map(); // eventName -> handler[]
    this._logBuffer = [];
  }

  /** 安装 hook 脚本并注入 Claude 配置，服务启动时调用一次 */
  install() {
    try {
      this._installHookScripts();
      this._mergeClaudeSettings();
      console.log(`[HookServer] Hook 安装完成，端口 ${this.serverPort}，日志: ${this.logPath}`);
    } catch (err) {
      console.error('[HookServer] 安装失败:', err.message);
    }
  }

  /** 注册事件处理器，eventName 可用 '*' 监听所有事件 */
  on(eventName, handler) {
    if (!this.handlers.has(eventName)) this.handlers.set(eventName, []);
    this.handlers.get(eventName).push(handler);
  }

  /** 分发收到的 hook 事件（由 HTTP 路由调用） */
  dispatch(event) {
    this._writeLog(event);
    const specific = this.handlers.get(event.hook_event_name) || [];
    const wildcard = this.handlers.get('*') || [];
    for (const h of [...specific, ...wildcard]) {
      try { h(event); } catch (e) {
        console.error('[HookServer] 事件处理异常:', e.message);
      }
    }
  }

  /** 验证请求 token */
  validateToken(token) {
    return token && token === this.token;
  }

  /** 读取最近 N 条日志（供调试端点使用） */
  recentLogs(n = 50) {
    try {
      const lines = readFileSync(this.logPath, 'utf8').trim().split('\n');
      return lines.slice(-n).join('\n');
    } catch { return '(暂无日志)'; }
  }

  // ─── 内部方法 ──────────────────────────────────────────────

  _loadOrCreateToken() {
    try {
      return readFileSync(this.tokenPath, 'utf8').trim();
    } catch {
      mkdirSync(this.webtmuxDir, { recursive: true });
      const token = randomBytes(32).toString('hex');
      writeFileSync(this.tokenPath, token, { mode: 0o600 });
      return token;
    }
  }

  _installHookScripts() {
    mkdirSync(this.hooksDir, { recursive: true });
    const script = this._buildScript();
    for (const name of ['pre-tool.sh', 'post-tool.sh', 'stop.sh']) {
      const p = join(this.hooksDir, name);
      // 始终重写（确保端口和 token 是最新的）
      writeFileSync(p, script);
      chmodSync(p, 0o755);
    }
  }

  _buildScript() {
    return `#!/bin/bash
# WhatyTerm hook script - auto-generated, do not edit manually
INPUT=$(cat)
curl -s --max-time 2 -X POST "http://127.0.0.1:${this.serverPort}/hooks" \\
  -H "Content-Type: application/json" \\
  -H "X-WebtmuxToken: ${this.token}" \\
  -d "$INPUT" &
exit 0
`;
  }

  _mergeClaudeSettings() {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    let settings = {};
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
    if (!settings.hooks) settings.hooks = {};

    const hookMap = { PreToolUse: 'pre-tool.sh', PostToolUse: 'post-tool.sh', Stop: 'stop.sh' };

    for (const [event, script] of Object.entries(hookMap)) {
      const scriptPath = join(this.hooksDir, script);
      if (!settings.hooks[event]) settings.hooks[event] = [];
      // 移除旧版同路径条目（端口/token 可能已变），再重新加入
      settings.hooks[event] = settings.hooks[event].filter(h =>
        !h.hooks?.some(c => c.command === scriptPath)
      );
      settings.hooks[event].push({
        hooks: [{ type: 'command', command: scriptPath, timeout: 5 }]
      });
    }

    mkdirSync(join(homedir(), '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  _writeLog(event) {
    const ts = new Date().toISOString();
    const ev = event.hook_event_name;
    const tool = event.tool_name ? ` tool=${event.tool_name}` : '';
    const file = event.tool_input?.file_path ? ` file=${event.tool_input.file_path}` : '';
    const cwd = event.cwd ? ` cwd=${event.cwd}` : '';
    const line = `${ts} [${ev}]${tool}${file}${cwd}`;
    console.log(`[HookServer] ${line}`);
    try {
      appendFileSync(this.logPath, line + '\n');
      // 滚动：超过阈值时截断前半部分
      const content = readFileSync(this.logPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length > MAX_LOG_LINES) {
        writeFileSync(this.logPath, lines.slice(-MAX_LOG_LINES).join('\n') + '\n');
      }
    } catch {}
  }
}

export default HookServer;
