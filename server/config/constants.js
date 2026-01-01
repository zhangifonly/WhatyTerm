/**
 * 统一配置常量
 * 所有需要共享的常量都在这里定义，便于维护
 */

import { execSync } from 'child_process';

// 动态获取本机 CLI 版本号
function getLocalVersion(command, fallback) {
  try {
    // 跨平台：直接执行命令，通过 try-catch 处理错误，不依赖 shell 重定向
    const output = execSync(command, {
      timeout: 3000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']  // 捕获 stderr 避免输出
    });
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : fallback;
  } catch {
    return fallback;
  }
}

// 启动时读取本机版本（带回退默认值）
const CLAUDE_VERSION = getLocalVersion('claude --version', '2.0.76');
const CODEX_VERSION = getLocalVersion('codex --version', '0.77.0');
const GEMINI_VERSION = getLocalVersion('gemini --version', '0.21.3');

// 默认模型（选择最便宜的 Haiku）
// 当 Anthropic 发布新版本时，只需修改这里
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// Claude 模型降级列表（按优先级排序，从便宜到贵）
// 当一个模型不可用时（503 model_not_found），自动尝试下一个
export const CLAUDE_MODEL_FALLBACK_LIST = [
  'claude-haiku-4-5-20251001',      // 最便宜，优先使用
  'claude-3-5-haiku-20241022',      // 旧版 Haiku
  'claude-sonnet-4-5-20250929',     // Sonnet 4.5
  'claude-3-5-sonnet-20241022',     // 旧版 Sonnet
];

// Claude Code 伪装配置
export const CLAUDE_CODE_FAKE = {
  userAgent: `claude-cli/${CLAUDE_VERSION} (external, cli)`,
  headers: {
    'x-app': 'cli',
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14',
    'anthropic-version': '2023-06-01'
  },
  systemPrompt: "You are Claude Code, Anthropic's official CLI for Claude."
};

// Codex CLI 伪装配置
export const CODEX_FAKE = {
  userAgent: `codex_cli_rs/${CODEX_VERSION}`,
  headers: {
    'openai-beta': 'responses'
  },
  // Codex 系统指令（简化版，完整版太长）
  instructions: "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer."
};

// Gemini CLI 伪装配置
export const GEMINI_FAKE = {
  userAgent: `gemini-cli/${GEMINI_VERSION}`,
  headers: {}
};

// AI 分析间隔（毫秒）
export const AI_ANALYSIS_INTERVAL = 30000;

// 健康检查默认模型配置
export const HEALTH_CHECK_MODELS = {
  claude: DEFAULT_MODEL,
  openai: 'gpt-4o-mini',
  gemini: 'gemini-1.5-flash'
};
