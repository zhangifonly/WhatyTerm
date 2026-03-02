/**
 * 统一配置常量
 * 所有需要共享的常量都在这里定义，便于维护
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, watchFile } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// 从 JSON 文件加载模型配置
const modelsConfigPath = join(__dirname, 'models.json');
let modelsConfig = null;

function loadModelsConfig() {
  try {
    if (existsSync(modelsConfigPath)) {
      const content = readFileSync(modelsConfigPath, 'utf-8');
      modelsConfig = JSON.parse(content);
      console.log('[Constants] 已加载模型配置:', modelsConfigPath, '更新时间:', modelsConfig.lastUpdated);
    }
  } catch (err) {
    console.error('[Constants] 加载模型配置失败:', err.message);
  }
}

// 初始加载
loadModelsConfig();

// 监听文件变化，热更新
if (existsSync(modelsConfigPath)) {
  watchFile(modelsConfigPath, { interval: 5000 }, () => {
    console.log('[Constants] 检测到模型配置变化，重新加载...');
    loadModelsConfig();
  });
}

// 启动时读取本机版本（带回退默认值）
const CLAUDE_VERSION = getLocalVersion('claude --version', '2.0.76');
const CODEX_VERSION = getLocalVersion('codex --version', '0.77.0');
const GEMINI_VERSION = getLocalVersion('gemini --version', '0.21.3');

// 默认模型（从配置文件读取，回退到硬编码值）
export const DEFAULT_MODEL = modelsConfig?.claude?.default || 'claude-sonnet-4-6';

// Claude 模型降级列表（从配置文件读取）
export const CLAUDE_MODEL_FALLBACK_LIST = modelsConfig?.claude?.fallback || [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-6',
  'claude-opus-4-5-20251101',
];

// 获取最新的模型配置（支持热更新）
export function getModelsConfig() {
  return modelsConfig;
}

// 获取指定类型的模型列表
export function getModelList(type = 'claude') {
  return modelsConfig?.[type]?.fallback || [];
}

// 获取模型显示名称
export function getModelDisplayName(type, modelId) {
  return modelsConfig?.[type]?.display?.[modelId] || modelId;
}

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
