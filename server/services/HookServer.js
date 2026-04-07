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
   * 部署 OpenCode 监控插件到指定项目目录
   * 在 OpenCode 会话启动时调用
   * 官方文档: https://opencode.ai/docs/plugins/
   */
  deployOpenCodePlugin(workingDir) {
    if (!workingDir) return;
    try {
      const pluginDir = join(workingDir, '.opencode', 'plugins');
      // 使用 .js 避免 TypeScript 编译问题
      const pluginPath = join(pluginDir, 'webtmux-monitor.js');
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
    // Gemini CLI hooks: ~/.gemini/settings.json
    // 官方文档: https://geminicli.com/docs/hooks/reference/
    // 事件名: BeforeTool / AfterTool / SessionEnd（与 Claude Code 不同）
    // timeout 单位: 毫秒（默认 60000）
    const settingsPath = join(homedir(), '.gemini', 'settings.json');
    let settings = {};
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
    if (!settings.hooks) settings.hooks = {};

    const ext = this._scriptExt();
    // BeforeTool/AfterTool 支持 matcher（按工具名匹配），SessionEnd 不需要
    const eventConfigs = [
      { event: 'BeforeTool', script: 'pre-tool' + ext, matcher: '.*' },
      { event: 'AfterTool',  script: 'post-tool' + ext, matcher: '.*' },
      { event: 'SessionEnd', script: 'stop' + ext, matcher: null },
    ];

    for (const cfg of eventConfigs) {
      const scriptPath = join(this.hooksDir, cfg.script);
      const command = isWindows
        ? `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`
        : scriptPath;
      if (!Array.isArray(settings.hooks[cfg.event])) settings.hooks[cfg.event] = [];
      // 移除旧的 webtmux 条目
      settings.hooks[cfg.event] = settings.hooks[cfg.event].filter(h =>
        !h.hooks?.some(c => c.command?.includes('webtmux') || c.command?.includes('.webtmux'))
      );
      const entry = {
        hooks: [{ name: 'webtmux-monitor', type: 'command', command, timeout: 5000 }],
      };
      if (cfg.matcher) entry.matcher = cfg.matcher;
      settings.hooks[cfg.event].push(entry);
    }

    mkdirSync(join(homedir(), '.gemini'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  _mergeCodexSettings() {
    // Codex CLI hooks: ~/.codex/hooks.json + [features] codex_hooks = true
    // 官方文档: https://developers.openai.com/codex/hooks
    // 事件名: SessionStart / PreToolUse / PostToolUse / UserPromptSubmit / Stop
    // 仅 SessionStart/PreToolUse/PostToolUse 支持 matcher
    // timeout 单位: 秒（默认 600）
    if (isWindows) {
      console.log('[HookServer] Codex hooks 暂不支持 Windows，跳过');
      return;
    }

    const hooksPath = join(homedir(), '.codex', 'hooks.json');
    let settings = {};
    try { settings = JSON.parse(readFileSync(hooksPath, 'utf8')); } catch {}
    if (!settings.hooks) settings.hooks = {};

    const ext = this._scriptExt();
    const eventConfigs = [
      { event: 'PreToolUse',  script: 'pre-tool' + ext,  matcher: '.*' },
      { event: 'PostToolUse', script: 'post-tool' + ext, matcher: '.*' },
      { event: 'Stop',        script: 'stop' + ext,      matcher: null }, // Stop 不支持 matcher
    ];

    for (const cfg of eventConfigs) {
      const scriptPath = join(this.hooksDir, cfg.script);
      if (!Array.isArray(settings.hooks[cfg.event])) settings.hooks[cfg.event] = [];
      settings.hooks[cfg.event] = settings.hooks[cfg.event].filter(h =>
        !h.hooks?.some(c => c.command?.includes('webtmux') || c.command?.includes('.webtmux'))
      );
      const entry = {
        hooks: [{ type: 'command', command: scriptPath, timeout: 5, statusMessage: 'webtmux-monitor' }],
      };
      if (cfg.matcher) entry.matcher = cfg.matcher;
      settings.hooks[cfg.event].push(entry);
    }

    mkdirSync(join(homedir(), '.codex'), { recursive: true });
    writeFileSync(hooksPath, JSON.stringify(settings, null, 2));

    // config.toml - 启用 codex_hooks 实验特性
    const configPath = join(homedir(), '.codex', 'config.toml');
    let config = '';
    try { config = readFileSync(configPath, 'utf8'); } catch {}
    // 清理旧的错误配置
    config = config.replace(/^enable_hooks\s*=.*$/gm, '').replace(/\n{3,}/g, '\n\n');
    if (!/\[features\][\s\S]*?codex_hooks\s*=\s*true/.test(config)) {
      if (/\[features\]/.test(config)) {
        config = config.replace(/\[features\]/, '[features]\ncodex_hooks = true');
      } else {
        config += '\n[features]\ncodex_hooks = true\n';
      }
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
   *
   * Claude Code / Codex CLI / Gemini CLI 的字段名完全一致（hook_event_name/tool_name/tool_input/cwd），
   * 只是 Gemini CLI 的 event 名不同（BeforeTool/AfterTool/SessionEnd），需要翻译。
   */
  _normalizeEvent(event) {
    if (event.hook_event_name) {
      // Gemini CLI 的 event 名翻译为 Claude Code 标准
      const geminiNameMap = { BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse', SessionEnd: 'Stop' };
      if (geminiNameMap[event.hook_event_name]) {
        return { ...event, hook_event_name: geminiNameMap[event.hook_event_name], _source: 'gemini' };
      }
      // Claude Code 和 Codex CLI 的 event 名已经是标准格式
      return event;
    }

    // 注：OpenCode 插件已直接发送 Claude Code 格式（hook_event_name），由首个分支处理
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
    // OpenCode 插件官方文档: https://opencode.ai/docs/plugins/
    // - 入口: 命名导出的 async 函数，接收 { project, client, $, directory, worktree }
    // - 工具事件: tool.execute.before / tool.execute.after，参数 (input, output)
    //   input.tool = 工具名，output.args = 工具参数
    // - 会话事件: 通过 event 处理器接收 { event }，event.type 形如 "session.idle"
    return `// WhatyTerm OpenCode monitor plugin - auto-generated
// 直接发送 Claude Code 标准格式到 server 的 /hooks 端点
const PORT = ${this.serverPort};
const TOKEN = ${JSON.stringify(this.token)};

async function postEvent(eventName, toolName, toolInput, cwd) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    await fetch("http://127.0.0.1:" + PORT + "/hooks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WebtmuxToken": TOKEN },
      body: JSON.stringify({
        hook_event_name: eventName,
        tool_name: toolName || "",
        tool_input: toolInput || {},
        cwd: cwd || "",
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch (e) {}
}

export const WebtmuxMonitor = async ({ directory }) => {
  return {
    "tool.execute.before": async (input, output) => {
      await postEvent("PreToolUse", input && input.tool, output && output.args, directory);
    },
    "tool.execute.after": async (input, output) => {
      await postEvent("PostToolUse", input && input.tool, output && output.args, directory);
    },
    event: async ({ event }) => {
      if (event && (event.type === "session.idle" || event.type === "session.deleted")) {
        await postEvent("Stop", "", {}, directory);
      }
    },
  };
};
`;
  }
}

export default HookServer;
