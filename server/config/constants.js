/**
 * 统一配置常量
 * 所有需要共享的常量都在这里定义，便于维护
 */

// 默认模型（选择最便宜的 Haiku）
// 当 Anthropic 发布新版本时，只需修改这里
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// Claude Code 伪装配置
export const CLAUDE_CODE_FAKE = {
  userAgent: 'claude-cli/2.0.69 (external, cli)',
  headers: {
    'x-app': 'cli',
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14',
    'anthropic-version': '2023-06-01'
  },
  systemPrompt: "You are Claude Code, Anthropic's official CLI for Claude."
};

// Codex CLI 伪装配置
export const CODEX_FAKE = {
  userAgent: 'codex_cli_rs/0.71.0',
  headers: {
    'openai-beta': 'responses'
  },
  // Codex 系统指令（简化版，完整版太长）
  instructions: "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer."
};

// AI 分析间隔（毫秒）
export const AI_ANALYSIS_INTERVAL = 30000;

// 健康检查默认模型配置
export const HEALTH_CHECK_MODELS = {
  claude: DEFAULT_MODEL,
  openai: 'gpt-4o-mini',
  gemini: 'gemini-1.5-flash'
};
