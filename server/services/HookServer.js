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
import { homedir, platform } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

const isWindows = platform() === 'win32';

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

  /** 安装所有 CLI 的 hook 脚本，服务启动时调用一次 */
  install() {
    try {
      this._cleanOldScripts();          // 清理旧平台脚本
      this._installHookScripts();       // 安装当前平台脚本
      this._mergeClaudeSettings();      // Claude Code
      this._mergeGeminiSettings();      // Gemini CLI
      this._mergeCodexSettings();       // Codex CLI
      console.log(`[HookServer] Hooks 安装完成（claude/gemini/codex），端口 ${this.serverPort}，平台 ${isWindows ? 'win32/ps1' : 'unix/sh'}`);
    } catch (err) {
      console.error('[HookServer] 安装失败:', err.message);
    }
  }

  /** 清理旧平台的脚本（如从 .sh 切换到 .ps1） */
  _cleanOldScripts() {
    const oldExt = isWindows ? '.sh' : '.ps1';
    for (const base of ['pre-tool', 'post-tool', 'stop']) {
      const oldPath = join(this.hooksDir, base + oldExt);
      try { require('fs').unlinkSync(oldPath); } catch {}
    }
  }

  /**
   * 部署 OpenCode TypeScript 监控插件到指定项目目录
   * 在 OpenCode 会话启动时调用
   */
  deployOpenCodePlugin(workingDir) {
    if (!workingDir) return;
    try {
      const pluginDir = join(workingDir, '.opencode', 'plugins');
      const pluginPath = join(pluginDir, 'webtmux-monitor.ts');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(pluginPath, this._buildOpenCodePlugin());
      console.log(`[HookServer] OpenCode 插件已部署: ${pluginPath}`);
    } catch (err) {
      console.error('[HookServer] OpenCode 插件部署失败:', err.message);
    }
  }

  /** 注册事件处理器，eventName 可用 '*' 监听所有事件 */
  on(eventName, handler) {
    if (!this.handlers.has(eventName)) this.handlers.set(eventName, []);
    this.handlers.get(eventName).push(handler);
  }

  /** 分发收到的 hook 事件（由 HTTP 路由调用） */
  dispatch(rawEvent) {
    const event = this._normalizeEvent(rawEvent);
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

  /** 获取 hook 脚本扩展名 */
  _scriptExt() { return isWindows ? '.ps1' : '.sh'; }

  /** 获取 hook 脚本名 */
  _scriptName(base) { return base + this._scriptExt(); }

  _installHookScripts() {
    mkdirSync(this.hooksDir, { recursive: true });
    const script = isWindows ? this._buildPowerShellScript() : this._buildBashScript();
    const ext = this._scriptExt();
    for (const base of ['pre-tool', 'post-tool', 'stop']) {
      const p = join(this.hooksDir, base + ext);
      writeFileSync(p, script);
      if (!isWindows) chmodSync(p, 0o755);
    }
  }

  _buildBashScript() {
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

  _buildPowerShellScript() {
    return `# WhatyTerm hook script - auto-generated, do not edit manually
$input_data = [Console]::In.ReadToEnd()
try {
  $body = [System.Text.Encoding]::UTF8.GetBytes($input_data)
  $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:${this.serverPort}/hooks")
  $req.Method = "POST"
  $req.ContentType = "application/json"
  $req.Headers.Add("X-WebtmuxToken", "${this.token}")
  $req.Timeout = 2000
  $stream = $req.GetRequestStream()
  $stream.Write($body, 0, $body.Length)
  $stream.Close()
  $null = $req.GetResponse()
} catch {}
`;
  }

  _mergeGeminiSettings() {
    const settingsPath = join(homedir(), '.gemini', 'settings.json');
    let settings = {};
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
    if (!settings.hooks) settings.hooks = {};

    const ext = this._scriptExt();
    const hookMap = {
      BeforeTool: join(this.hooksDir, 'pre-tool' + ext),
      AfterTool:  join(this.hooksDir, 'post-tool' + ext),
      SessionEnd: join(this.hooksDir, 'stop' + ext),
    };

    for (const [event, scriptPath] of Object.entries(hookMap)) {
      const command = isWindows
        ? `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`
        : scriptPath;
      if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
      settings.hooks[event] = settings.hooks[event].filter(h =>
        !h.hooks?.some(c => c.command?.includes('webtmux'))
      );
      settings.hooks[event].push({
        matcher: '.*',
        hooks: [{ type: 'command', command, timeout: 5000 }],
      });
    }

    mkdirSync(join(homedir(), '.gemini'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  _mergeCodexSettings() {
    // hooks.json
    const hooksPath = join(homedir(), '.codex', 'hooks.json');
    let hooks = {};
    try { hooks = JSON.parse(readFileSync(hooksPath, 'utf8')); } catch {}

    const ext = this._scriptExt();
    const hookMap = {
      pre_tool_call:  join(this.hooksDir, 'pre-tool' + ext),
      post_tool_call: join(this.hooksDir, 'post-tool' + ext),
      session_end:    join(this.hooksDir, 'stop' + ext),
    };

    for (const [event, scriptPath] of Object.entries(hookMap)) {
      const command = isWindows
        ? `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`
        : scriptPath;
      if (!Array.isArray(hooks[event])) hooks[event] = [];
      hooks[event] = hooks[event].filter(h => !h.command?.includes('webtmux'));
      hooks[event].push({ command, timeout: 5 });
    }

    mkdirSync(join(homedir(), '.codex'), { recursive: true });
    writeFileSync(hooksPath, JSON.stringify(hooks, null, 2));

    // config.toml - ensure hooks feature is enabled
    const configPath = join(homedir(), '.codex', 'config.toml');
    let config = '';
    try { config = readFileSync(configPath, 'utf8'); } catch {}
    if (!config.includes('enable_hooks')) {
      config += '\nenable_hooks = true\n';
      writeFileSync(configPath, config);
    }
  }

  _mergeClaudeSettings() {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    let settings = {};
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
    if (!settings.hooks) settings.hooks = {};

    const ext = this._scriptExt();
    const hookMap = { PreToolUse: 'pre-tool' + ext, PostToolUse: 'post-tool' + ext, Stop: 'stop' + ext };

    for (const [event, script] of Object.entries(hookMap)) {
      const scriptPath = join(this.hooksDir, script);
      // Windows: powershell 执行 .ps1；Unix: 直接执行 .sh
      const command = isWindows
        ? `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`
        : scriptPath;
      if (!settings.hooks[event]) settings.hooks[event] = [];
      // 移除旧版条目（端口/token 可能已变），再重新加入
      settings.hooks[event] = settings.hooks[event].filter(h =>
        !h.hooks?.some(c => c.command?.includes('webtmux'))
      );
      settings.hooks[event].push({
        hooks: [{ type: 'command', command, timeout: 5 }]
      });
    }

    mkdirSync(join(homedir(), '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  /**
   * 将不同 CLI 的事件格式统一为 Claude Code 格式：
   *   hook_event_name: PreToolUse | PostToolUse | Stop
   *   tool_name, tool_input, cwd
   */
  _normalizeEvent(event) {
    // 已经是标准格式（Claude Code）
    if (event.hook_event_name) return event;

    // Gemini CLI: { eventName, toolName, arguments, workingDir }
    if (event.eventName) {
      const nameMap = { BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse', SessionEnd: 'Stop' };
      return {
        hook_event_name: nameMap[event.eventName] || event.eventName,
        tool_name: event.toolName,
        tool_input: event.arguments || {},
        cwd: event.workingDir,
        _source: 'gemini',
        _raw: event,
      };
    }

    // Codex CLI: { event, tool, args, cwd }
    if (event.event) {
      const nameMap = { pre_tool_call: 'PreToolUse', post_tool_call: 'PostToolUse', session_end: 'Stop' };
      return {
        hook_event_name: nameMap[event.event] || event.event,
        tool_name: event.tool,
        tool_input: event.args || {},
        cwd: event.cwd,
        _source: 'codex',
        _raw: event,
      };
    }

    // OpenCode plugin: { type, toolName, params, workdir }
    if (event.type) {
      const nameMap = { PreToolUse: 'PreToolUse', PostToolUse: 'PostToolUse', SessionEnd: 'Stop' };
      return {
        hook_event_name: nameMap[event.type] || event.type,
        tool_name: event.toolName,
        tool_input: event.params || {},
        cwd: event.workdir,
        _source: 'opencode',
        _raw: event,
      };
    }

    return event; // fallback
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
  _buildOpenCodePlugin() {
    return `// WhatyTerm OpenCode monitor plugin - auto-generated
import type { Plugin } from "@opencode-ai/sdk";

const PORT = ${this.serverPort};
const TOKEN = "${this.token}";

async function postEvent(type: string, toolName?: string, params?: unknown, workdir?: string) {
  try {
    await fetch(\`http://127.0.0.1:\${PORT}/hooks\`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WebtmuxToken": TOKEN,
      },
      body: JSON.stringify({ type, toolName, params, workdir }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
}

const plugin: Plugin = {
  name: "webtmux-monitor",
  async onPreToolUse({ tool, params, workdir }) {
    await postEvent("PreToolUse", tool, params, workdir);
  },
  async onPostToolUse({ tool, params, workdir }) {
    await postEvent("PostToolUse", tool, params, workdir);
  },
  async onSessionEnd({ workdir }) {
    await postEvent("SessionEnd", undefined, undefined, workdir);
  },
};

export default plugin;
`;
  }
}

export default HookServer;
