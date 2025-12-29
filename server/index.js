import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, watch } from 'fs';
import session from 'express-session';
import crypto from 'crypto';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';

// Windows/WSL 兼容层
const isWindows = process.platform === 'win32';
const useWSL = isWindows && process.env.WEBTMUX_USE_WSL === 'true';

// 获取 tmux 命令前缀（Windows 上通过 WSL）
function getTmuxPrefix() {
  return useWSL ? 'wsl tmux' : 'tmux';
}
import { SessionManager } from './services/SessionManager.js';
import { HistoryLogger } from './services/HistoryLogger.js';
import { AIEngine } from './services/AIEngine.js';
import { AuthService } from './services/AuthService.js';
import { ProviderService } from './services/ProviderService.js';
import ScheduleManager from './services/ScheduleManager.js';
import HealthCheckScheduler from './services/HealthCheckScheduler.js';
import { setupRoutes } from './routes/index.js';
import claudeSessionFixer from './services/ClaudeSessionFixer.js';
import configRoutes from './routes/configRoutes.js';
import ccSwitchRoutes from './routes/ccSwitchRoutes.js';
import { DEFAULT_MODEL } from './config/constants.js';
import cloudflareTunnel from './services/CloudflareTunnel.js';
import frpTunnel from './services/FrpTunnel.js';
import projectTaskReader from './services/ProjectTaskReader.js';
import RecentProjectsService from './services/RecentProjectsService.js';
import processDetector from './services/ProcessDetector.js';
import { getTerminalRecorder } from './services/TerminalRecorder.js';
import cliRegistry from './services/CliRegistry.js';
import cliLearner from './services/CliLearner.js';
import tokenStatsService from './services/TokenStatsService.js';
import builtinProviderDB from './services/BuiltinProviderDB.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 初始化内置供应商数据库（优先使用 CC-Switch，不存在则创建内置数据库）
builtinProviderDB.init();

// API 密钥脱敏函数，防止敏感信息泄露
function maskApiKey(key) {
  if (!key || key.length < 12) return key ? '***' : '';
  return key.substring(0, 8) + '***' + key.substring(key.length - 4);
}

// 从 CLAUDE.md 或 README.md 提取项目描述
// 返回格式：标题 + 详细描述（如果有）
async function extractProjectDesc(workingDir) {
  if (!workingDir) return '';

  try {
    const fs = await import('fs/promises');
    const claudeMdPath = `${workingDir}/CLAUDE.md`;
    const readmePath = `${workingDir}/README.md`;

    // 提取描述的逻辑：标题 + 第一段有意义的文本
    const extractFromContent = (content) => {
      const lines = content.split('\n');
      let title = '';
      let firstText = '';

      for (let i = 0; i < Math.min(lines.length, 30); i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('```')) continue;

        // 找第一个标题
        if (!title && line.startsWith('# ')) {
          let extractedTitle = line.slice(2).trim();
          extractedTitle = extractedTitle.replace(/^(CLAUDE\.md|README\.md)\s*[-–—:：]\s*/i, '');
          title = extractedTitle.slice(0, 100);
        }
        // 找第一个有意义的文本（非标题、非列表、非代码块、非表格、非图片）
        if (!firstText &&
            !line.startsWith('#') &&
            !line.startsWith('-') &&
            !line.startsWith('*') &&
            !line.startsWith('|') &&
            !line.startsWith('!') &&
            !line.startsWith('[') &&
            !line.startsWith('<') &&
            !line.match(/^\*\*[^*]+\*\*:/) &&
            !line.match(/!\[.*\]\(.*\)/) &&
            !line.match(/^\[.*\]:/) &&
            !line.match(/^<[^>]+>/) &&
            !line.endsWith('：') &&
            !line.endsWith(':') &&
            line.length > 15) {
          let text = line.startsWith('>') ? line.slice(1).trim() : line;
          if (text.length > 15) {
            firstText = text.slice(0, 150);
          }
        }

        // 如果都找到了就退出
        if (title && firstText) break;
      }

      // 组合标题和描述
      if (title && firstText) {
        return `${title} - ${firstText}`;
      }
      return title || firstText;
    };

    // 优先读取 CLAUDE.md
    try {
      const content = await fs.readFile(claudeMdPath, 'utf-8');
      const desc = extractFromContent(content);
      if (desc) return desc;
    } catch {}

    // CLAUDE.md 不存在或无有效内容，尝试 README.md
    try {
      const content = await fs.readFile(readmePath, 'utf-8');
      return extractFromContent(content);
    } catch {}
  } catch {}

  return '';
}

// 从 goal.md、CLAUDE.md 或 README.md 提取项目目标
async function extractProjectGoal(workingDir) {
  if (!workingDir) return '';

  const fs = await import('fs/promises');

  // 从内容中提取目标的通用函数
  const extractGoalFromContent = (content) => {
    const lines = content.split('\n');
    let inOverviewSection = false;
    let goalLines = [];

    for (let i = 0; i < Math.min(lines.length, 50); i++) {
      const line = lines[i].trim();

      // 检测概览/目标章节（扩展匹配）
      if (line.match(/^##\s*(概览|Overview|目标|Goal|简介|Introduction|About|项目概述|Description)/i)) {
        inOverviewSection = true;
        continue;
      }

      // 遇到下一个二级标题时停止
      if (inOverviewSection && line.startsWith('## ')) {
        break;
      }

      // 收集概览章节的内容（过滤表格行）
      if (inOverviewSection && line &&
          !line.startsWith('#') &&
          !line.startsWith('```') &&
          !line.startsWith('|') &&
          !line.match(/^[-|:]+$/)) {  // 过滤表格分隔线
        goalLines.push(line);
        if (goalLines.join('').length > 200) break;
      }

      // 如果没有概览章节，收集第一段普通文本
      if (!inOverviewSection && goalLines.length === 0 && line &&
          !line.startsWith('#') &&
          !line.startsWith('-') &&
          !line.startsWith('*') &&
          !line.startsWith('```') &&
          !line.startsWith('>') &&
          !line.startsWith('|') &&
          line.length > 15) {
        goalLines.push(line);
      }
    }

    return goalLines.join(' ').slice(0, 300);
  };

  // 首先尝试从 goal.md 读取
  try {
    const goalMdPath = `${workingDir}/goal.md`;
    const content = await fs.readFile(goalMdPath, 'utf-8');
    const goal = extractGoalFromContent(content);
    if (goal) return goal;
  } catch {
    // goal.md 不存在
  }

  // 尝试从 CLAUDE.md 读取
  try {
    const claudeMdPath = `${workingDir}/CLAUDE.md`;
    const content = await fs.readFile(claudeMdPath, 'utf-8');
    const goal = extractGoalFromContent(content);
    if (goal) return goal;
  } catch {
    // CLAUDE.md 不存在
  }

  // 尝试从 README.md 读取
  try {
    const readmePath = `${workingDir}/README.md`;
    const content = await fs.readFile(readmePath, 'utf-8');
    const goal = extractGoalFromContent(content);
    if (goal) return goal;
  } catch {
    // README.md 也不存在
  }

  return '';
}

// 注意：refreshSessionMetadata 和 refreshAllSessionsMetadata 功能已合并到 updateAllSessionsProjectInfo() 中
// 该函数从 tmux 获取 workingDir，并刷新 projectName、projectDesc、goal

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' ? false : ['http://localhost:5173'],
    methods: ['GET', 'POST']
  }
});

// Session 密钥（生产环境应使用环境变量）
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Session 中间件
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,  // 开发环境使用 HTTP
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000  // 7 天
  }
});

app.use(express.json());
app.use(sessionMiddleware);

const sessionManager = new SessionManager();
const historyLogger = new HistoryLogger();
const terminalRecorder = getTerminalRecorder();
const aiEngine = new AIEngine();
const authService = new AuthService();
const providerService = new ProviderService(io);
const healthCheckScheduler = new HealthCheckScheduler(io);
const scheduleManager = new ScheduleManager();

// 启动时执行数据库维护
(async () => {
  try {
    const stats = historyLogger.getStats();
    console.log(`[数据库] 历史记录统计: 总记录 ${stats.totalRecords}, 7天内 ${stats.activeRecords}, 超过7天 ${stats.oldRecords}`);

    let needOptimize = false;

    // 清理超过1天的输出记录（output 记录量大，需要更频繁清理）
    if (stats.totalRecords > 100000) {
      console.log('[数据库] 清理超过1天的输出记录...');
      const deletedOutputs = historyLogger.cleanOldOutputs(1);
      console.log(`[数据库] 已删除 ${deletedOutputs} 条超过1天的输出记录`);
      if (deletedOutputs > 0) {
        needOptimize = true;
      }
    }

    // 清理超过7天的其他类型记录
    if (stats.oldRecords > 10000) {
      console.log('[数据库] 清理超过7天的其他记录...');
      const deleted = historyLogger.cleanOldHistory(7);
      console.log(`[数据库] 已删除 ${deleted} 条超过7天的记录`);
      if (deleted > 0) {
        needOptimize = true;
      }
    }

    // 清理后优化数据库
    if (needOptimize) {
      historyLogger.optimizeDatabase();
    }
  } catch (err) {
    console.error('[数据库] 维护失败:', err);
  }
})();

// 获取 AIEngine 当前使用的供应商信息（用于终端状态分析）
function getAIProviderInfo() {
  const providerInfo = aiEngine.getCurrentProviderInfo();
  const settings = aiEngine.getSettings();
  const apiType = settings?.apiType || 'claude';

  // 根据 apiType 选择正确的配置
  let config;
  let defaultModel;
  if (apiType === 'codex') {
    config = settings?.codex || {};
    defaultModel = 'gpt-5-codex';
  } else if (apiType === 'openai') {
    config = settings?.openai || {};
    defaultModel = 'gpt-4o';
  } else {
    config = settings?.claude || {};
    defaultModel = DEFAULT_MODEL;
  }

  return {
    providerName: providerInfo?.name || '未配置',
    providerUrl: config?.apiUrl || '未配置',
    providerModel: config?.model || defaultModel,
    providerApiType: apiType
  };
}

// 获取 Claude Code 实际使用的供应商信息（从 ~/.claude/settings.json 读取）
// 这个是 Claude Code CLI 实际使用的配置，与 AI 监控引擎的配置不同
function getClaudeCodeProviderInfo() {
  const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let claudeApiUrl = '';
  let claudeApiKey = '';
  let claudeModel = '';

  if (existsSync(claudeSettingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf8'));
      claudeApiUrl = settings.env?.ANTHROPIC_BASE_URL || '';
      claudeApiKey = settings.env?.ANTHROPIC_AUTH_TOKEN || '';
      claudeModel = settings.model || '';
    } catch (e) {
      console.error('[getClaudeCodeProviderInfo] 读取配置失败:', e.message);
    }
  }

  return {
    claudeCodeApiUrl: claudeApiUrl,
    claudeCodeApiKey: maskApiKey(claudeApiKey),
    claudeCodeModel: claudeModel
  };
}

// 检查是否为本机访问
function isLocalRequest(req) {
  // 优先检查 X-Forwarded-For（Cloudflare Tunnel 等代理会设置）
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    // 有代理头，说明是外部访问
    return false;
  }

  // 检查 CF-Connecting-IP（Cloudflare 特有）
  if (req.headers['cf-connecting-ip']) {
    return false;
  }

  const ip = req.ip || req.connection?.remoteAddress || '';
  // 本机 IP 地址列表
  const localIPs = ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'];
  return localIPs.includes(ip);
}

// 获取当前供应商信息（从实际配置文件读取，然后匹配 CC Switch 数据库）
// workingDir: 可选，用于检测项目本地配置
function getCurrentProvider(appType, workingDir = null) {
  return new Promise((resolve) => {
    const ccSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

    // 首先读取实际的配置文件，获取当前使用的 API URL
    let actualApiUrl = '';
    let actualApiKey = '';
    let actualModel = '';
    let configSource = 'global'; // 'global' 或 'local'

    // 始终读取全局配置（用于显示和同步参考）
    let globalApiUrl = '';
    let globalApiKey = '';
    let globalModel = '';
    let globalName = '';

    if (appType === 'claude') {
      // 先读取全局配置 ~/.claude/settings.json
      const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      if (existsSync(claudeSettingsPath)) {
        try {
          const settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf8'));
          globalApiUrl = settings.env?.ANTHROPIC_BASE_URL || '';
          globalApiKey = settings.env?.ANTHROPIC_AUTH_TOKEN || '';
          globalModel = settings.model || '';
        } catch (e) {
          console.error('[getCurrentProvider] 读取 Claude 全局配置失败:', e);
        }
      }

      // 再读取项目本地配置 <workingDir>/.claude/settings.local.json
      if (workingDir) {
        const localConfigPath = path.join(workingDir, '.claude', 'settings.local.json');
        if (existsSync(localConfigPath)) {
          try {
            const localSettings = JSON.parse(readFileSync(localConfigPath, 'utf8'));
            if (localSettings.env?.ANTHROPIC_BASE_URL) {
              actualApiUrl = localSettings.env.ANTHROPIC_BASE_URL;
              actualApiKey = localSettings.env?.ANTHROPIC_AUTH_TOKEN || '';
              actualModel = localSettings.model || '';
              configSource = 'local';
            }
          } catch (e) {
            console.error('[getCurrentProvider] 读取项目本地配置失败:', e.message);
          }
        }
      }

      // 如果没有本地配置，使用全局配置
      if (!actualApiUrl) {
        actualApiUrl = globalApiUrl;
        actualApiKey = globalApiKey;
        actualModel = globalModel;
        configSource = 'global';
      }
    } else if (appType === 'codex') {
      // 读取 ~/.codex/config.toml 或类似配置
      // TODO: 实现 Codex 配置读取
    } else if (appType === 'gemini') {
      // 读取 Gemini 配置
      // TODO: 实现 Gemini 配置读取
    }

    // 辅助函数：根据 URL 在 CC Switch 数据库中查找供应商名称
    const findProviderName = (url, rows) => {
      if (!url || !rows) return '未知供应商';
      const normalizedUrl = url.replace(/\/+$/, '');
      for (const row of rows) {
        try {
          if (row.settings_config) {
            const config = JSON.parse(row.settings_config);
            const providerUrl = (config.env?.ANTHROPIC_BASE_URL || config.baseURL || '').replace(/\/+$/, '');
            if (normalizedUrl === providerUrl) {
              return row.name || '未命名';
            }
          }
        } catch (e) {}
      }
      return '未知供应商';
    };

    // 构建全局配置信息对象
    const buildGlobalInfo = (rows) => {
      if (!globalApiUrl) return null;
      return {
        name: findProviderName(globalApiUrl, rows),
        url: globalApiUrl,
        apiKey: maskApiKey(globalApiKey),
        model: globalModel
      };
    };

    // 检查 CC Switch 数据库是否存在
    if (!existsSync(ccSwitchDbPath)) {
      return resolve({
        name: actualApiUrl ? '未知供应商' : '未配置',
        url: actualApiUrl,
        apiKey: maskApiKey(actualApiKey),
        model: actualModel,
        app: appType,
        exists: !!actualApiUrl,
        configSource: configSource,
        globalConfig: configSource === 'local' ? buildGlobalInfo(null) : null
      });
    }

    // 使用 better-sqlite3 同步读取
    try {
      const db = new Database(ccSwitchDbPath, { readonly: true });

      // 如果有实际的 API URL，尝试在数据库中匹配
      if (actualApiUrl) {
        const rows = db.prepare('SELECT * FROM providers WHERE app_type = ?').all(appType);
        db.close();

        const globalInfo = configSource === 'local' ? buildGlobalInfo(rows) : null;

        if (!rows || rows.length === 0) {
          return resolve({
            name: '未知供应商',
            url: actualApiUrl,
            apiKey: maskApiKey(actualApiKey),
            model: actualModel,
            app: appType,
            exists: true,
            configSource: configSource,
            globalConfig: globalInfo
          });
        }

        // 遍历供应商，找到 URL 精确匹配的
        for (const row of rows) {
          try {
            if (row.settings_config) {
              const config = JSON.parse(row.settings_config);
              const providerUrl = config.env?.ANTHROPIC_BASE_URL || config.baseURL || '';

              // 比较 URL（忽略末尾斜杠）
              const normalizedActual = actualApiUrl.replace(/\/+$/, '');
              const normalizedProvider = providerUrl.replace(/\/+$/, '');

              // 精确匹配
              if (normalizedActual === normalizedProvider) {
                return resolve({
                  id: row.id,
                  name: row.name || '未命名',
                  url: actualApiUrl,
                  apiKey: maskApiKey(actualApiKey),
                  model: actualModel,
                  apiType: actualApiUrl.includes('/v1/messages') ? 'claude' : 'openai',
                  app: appType,
                  exists: true,
                  configSource: configSource,
                  globalConfig: globalInfo
                });
              }
            }
          } catch (parseError) {
            // 忽略解析错误，继续下一个
          }
        }

        // 没有找到匹配的供应商
        return resolve({
          name: '未知供应商',
          url: actualApiUrl,
          apiKey: maskApiKey(actualApiKey),
          model: actualModel,
          app: appType,
          exists: true,
          configSource: configSource,
          globalConfig: globalInfo
        });
      } else {
        // 没有实际配置，回退到查询 is_current = 1
        const row = db.prepare('SELECT * FROM providers WHERE app_type = ? AND is_current = 1').get(appType);
        db.close();

        if (!row) {
          return resolve({
            name: '未配置',
            url: '',
            app: appType,
            exists: false,
            configSource: 'global'
          });
        }

        // 解析 settings_config 获取完整配置
        let apiUrl = '';
        let apiKey = '';
        let model = '';
        let apiType = 'openai';

        try {
          if (row.settings_config) {
            const config = JSON.parse(row.settings_config);

            if (appType === 'claude') {
              apiUrl = config.env?.ANTHROPIC_BASE_URL || config.baseURL || '';
              apiKey = config.env?.ANTHROPIC_AUTH_TOKEN || config.env?.ANTHROPIC_API_KEY || '';
              model = config.env?.ANTHROPIC_MODEL || config.model || '';
              apiType = apiUrl.includes('/v1/messages') ? 'claude' : 'openai';
            } else if (appType === 'codex') {
              apiUrl = config.env?.OPENAI_BASE_URL || config.baseURL || '';
              apiKey = config.env?.OPENAI_API_KEY || config.env?.OPENAI_AUTH_TOKEN || '';
              model = config.env?.OPENAI_MODEL || config.model || '';
              apiType = 'openai';
            } else if (appType === 'gemini') {
              apiUrl = config.env?.GEMINI_BASE_URL || config.baseURL || config.env?.BASE_URL || '';
              apiKey = config.env?.GEMINI_API_KEY || config.env?.API_KEY || '';
              model = config.env?.GEMINI_MODEL || config.model || '';
              apiType = 'openai';
            }
          }
        } catch (parseError) {
          console.error(`[getCurrentProvider] 解析 ${appType} settings_config 失败:`, parseError);
        }

        resolve({
          id: row.id,
          name: row.name || '未命名',
          url: apiUrl,
          apiKey: maskApiKey(apiKey),
          model: model,
          apiType: apiType,
          app: appType,
          exists: true,
          configSource: 'global'
        });
      }
    } catch (dbError) {
      console.error('[getCurrentProvider] 数据库读取失败:', dbError);
      return resolve({
        name: actualApiUrl ? '未知供应商' : '未配置',
        url: actualApiUrl,
        apiKey: maskApiKey(actualApiKey),
        model: actualModel,
        app: appType,
        exists: !!actualApiUrl,
        configSource: configSource
      });
    }
  });
}

// 获取所有可用的供应商列表（用于自动切换）
function getAllProviders(appType) {
  const ccSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

  if (!existsSync(ccSwitchDbPath)) {
    return [];
  }

  try {
    const db = new Database(ccSwitchDbPath, { readonly: true });
    const rows = db.prepare('SELECT * FROM providers WHERE app_type = ?').all(appType);
    db.close();

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      settingsConfig: row.settings_config
    }));
  } catch (err) {
    console.error('[getAllProviders] 数据库读取失败:', err);
    return [];
  }
}

// Claude 供应商优先级列表（按优先级排序）
const CLAUDE_PROVIDER_PRIORITY = [
  '88codepaid',      // 主力付费账号
  'crs.whaty.org',   // 自建 Claude Relay
  'FoxCode',         // 备用
];

// 启动时从配置文件加载优先级
(function loadProviderPriority() {
  const configPath = path.join(os.homedir(), '.webtmux', 'provider-priority.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      if (config.claude && Array.isArray(config.claude)) {
        CLAUDE_PROVIDER_PRIORITY.length = 0;
        CLAUDE_PROVIDER_PRIORITY.push(...config.claude);
        console.log('[ProviderPriority] 已加载配置:', config.claude);
      }
    } catch (e) {
      console.error('[ProviderPriority] 加载配置失败:', e);
    }
  }
})();

// 尝试自动切换供应商（仅在服务器不可用或余额不足时调用）
async function tryAutoSwitchProvider(session, sessionData, status) {
  const aiType = sessionData.aiType || 'claude';
  const currentProvider = aiType === 'claude' ? session.claudeProvider :
                          aiType === 'codex' ? session.codexProvider :
                          session.geminiProvider;

  console.log(`[自动修复] 需要切换供应商，当前: ${currentProvider?.name || '未知'}`);
  console.log(`[自动修复] 错误原因: ${status.isServerUnavailable ? '服务器不可用' : status.isInsufficientBalance ? '余额不足' : 'thinking不兼容'}`);

  // 获取所有可用供应商
  const allProviders = await getAllProviders(aiType);
  if (allProviders.length <= 1) {
    console.log(`[自动修复] 只有一个供应商，无法切换`);
    return null;
  }

  // 按优先级排序供应商
  const sortedProviders = [...allProviders].sort((a, b) => {
    const priorityA = CLAUDE_PROVIDER_PRIORITY.indexOf(a.id);
    const priorityB = CLAUDE_PROVIDER_PRIORITY.indexOf(b.id);
    // 不在列表中的放最后
    const orderA = priorityA === -1 ? 999 : priorityA;
    const orderB = priorityB === -1 ? 999 : priorityB;
    return orderA - orderB;
  });

  // 打印供应商切换顺序
  console.log(`[自动修复] 供应商切换顺序:`);
  sortedProviders.forEach((p, i) => {
    const isCurrent = p.id === currentProvider?.id;
    console.log(`  ${i + 1}. ${p.name} (${p.id})${isCurrent ? ' ← 当前' : ''}`);
  });

  // 找到当前供应商在排序列表中的位置
  const currentIndex = sortedProviders.findIndex(p => p.id === currentProvider?.id);

  // 选择下一个供应商
  let nextProvider = null;
  for (let i = 1; i < sortedProviders.length; i++) {
    const nextIndex = (currentIndex + i) % sortedProviders.length;
    const candidate = sortedProviders[nextIndex];
    if (candidate.id !== currentProvider?.id) {
      nextProvider = candidate;
      break;
    }
  }

  if (!nextProvider) {
    console.log(`[自动修复] 无法找到其他供应商`);
    return null;
  }

  console.log(`[自动修复] 建议切换到: ${nextProvider.name} (${nextProvider.id})`);

  return {
    success: true,
    newProvider: nextProvider.name,
    newProviderId: nextProvider.id,
    allProviders: sortedProviders.map(p => ({
      id: p.id,
      name: p.name,
      isCurrent: p.id === currentProvider?.id
    })),
    message: `建议切换到 ${nextProvider.name}`
  };
}

// 认证中间件
const authMiddleware = (req, res, next) => {
  // 登录相关路由不需要认证
  if (req.path === '/api/auth/login' ||
      req.path === '/api/auth/status' ||
      req.path === '/api/auth/logout') {
    return next();
  }

  // 如果未启用认证，直接通过
  if (!authService.isAuthRequired()) {
    return next();
  }

  // 本机访问自动放行
  if (isLocalRequest(req)) {
    return next();
  }

  // 检查 session
  if (req.session && req.session.authenticated) {
    return next();
  }

  // 未认证
  res.status(401).json({ error: '需要登录', requireAuth: true });
};

// 认证 API 路由
app.get('/api/auth/status', (req, res) => {
  const status = authService.getStatus();
  const isLocal = isLocalRequest(req);
  res.json({
    ...status,
    isLocal,
    // 本机访问视为已认证
    authenticated: isLocal || req.session?.authenticated || false
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const result = authService.authenticate(username, password);

  if (result.success) {
    req.session.authenticated = true;
    req.session.username = username;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: result.error });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.post('/api/auth/setup', (req, res) => {
  // 设置密码（需要已登录或首次设置，本机访问自动放行）
  const isLocal = isLocalRequest(req);
  if (authService.isAuthRequired() && !isLocal && !req.session?.authenticated) {
    return res.status(401).json({ error: '需要登录' });
  }

  const { username, password, disable } = req.body;

  if (disable) {
    authService.disableAuth();
    req.session.authenticated = true;  // 禁用后自动登录
    return res.json({ success: true, message: '认证已禁用' });
  }

  if (!password || password.length < 4) {
    return res.status(400).json({ error: '密码至少 4 位' });
  }

  authService.setPassword(username, password);
  req.session.authenticated = true;
  res.json({ success: true, message: '密码已设置' });
});

// Tunnel URL API - 直接从 ai-settings.json 读取，不依赖 ProviderService
const AI_SETTINGS_PATH = join(__dirname, 'db/ai-settings.json');

app.get('/api/tunnel/url', (req, res) => {
  try {
    if (existsSync(AI_SETTINGS_PATH)) {
      const settings = JSON.parse(readFileSync(AI_SETTINGS_PATH, 'utf-8'));
      res.json({ tunnelUrl: settings.tunnelUrl || '' });
    } else {
      res.json({ tunnelUrl: '' });
    }
  } catch (err) {
    res.json({ tunnelUrl: '' });
  }
});

app.post('/api/tunnel/url', (req, res) => {
  const { tunnelUrl } = req.body;
  try {
    let settings = {};
    if (existsSync(AI_SETTINGS_PATH)) {
      settings = JSON.parse(readFileSync(AI_SETTINGS_PATH, 'utf-8'));
    }
    settings.tunnelUrl = tunnelUrl;
    writeFileSync(AI_SETTINGS_PATH, JSON.stringify(settings, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// FRP 服务器状态 API
app.get('/api/frp/status', async (req, res) => {
  try {
    const status = await frpTunnel.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 同步全局 Claude Code 配置到项目级别 settings.local.json
// 只允许从全局复制到项目，不允许反向写入全局配置
app.post('/api/claude-code/config', async (req, res) => {
  try {
    const { projectPath } = req.body;

    // 必须提供项目路径，不允许写入全局配置
    if (!projectPath) {
      return res.status(400).json({ error: '必须指定项目路径，不允许修改全局配置' });
    }

    // 从全局配置读取 API URL 和 Key
    const globalConfigPath = join(os.homedir(), '.claude', 'settings.json');
    if (!existsSync(globalConfigPath)) {
      return res.status(400).json({ error: '全局配置文件不存在: ~/.claude/settings.json' });
    }

    let globalConfig;
    try {
      globalConfig = JSON.parse(readFileSync(globalConfigPath, 'utf-8'));
    } catch (e) {
      return res.status(400).json({ error: '读取全局配置失败: ' + e.message });
    }

    const apiUrl = globalConfig.env?.ANTHROPIC_BASE_URL;
    const apiKey = globalConfig.env?.ANTHROPIC_AUTH_TOKEN;

    if (!apiUrl || !apiKey) {
      return res.status(400).json({ error: '全局配置中缺少 ANTHROPIC_BASE_URL 或 ANTHROPIC_AUTH_TOKEN' });
    }

    // 写入项目级别配置：<projectPath>/.claude/settings.local.json
    const projectClaudeDir = join(projectPath, '.claude');
    if (!existsSync(projectClaudeDir)) {
      mkdirSync(projectClaudeDir, { recursive: true });
    }
    const configPath = join(projectClaudeDir, 'settings.local.json');

    let config = {};
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch (e) {
        console.error('[Claude Code Config] 读取项目配置失败:', e.message);
      }
    }

    // 保存本地的 permissions（本地权限优先）
    const localPermissions = config.permissions;

    // 同步全局配置的关键字段
    // 1. env（API 配置）
    config.env = { ...globalConfig.env };

    // 2. model（模型选择）
    if (globalConfig.model) {
      config.model = globalConfig.model;
    }

    // 3. alwaysThinkingEnabled（思考模式）
    if (globalConfig.alwaysThinkingEnabled !== undefined) {
      config.alwaysThinkingEnabled = globalConfig.alwaysThinkingEnabled;
    }

    // 4. CLAUDE_CODE_MAX_OUTPUT_TOKENS（最大输出 token）
    if (globalConfig.CLAUDE_CODE_MAX_OUTPUT_TOKENS !== undefined) {
      config.CLAUDE_CODE_MAX_OUTPUT_TOKENS = globalConfig.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    }

    // 5. MAX_THINKING_TOKENS（最大思考 token）
    if (globalConfig.MAX_THINKING_TOKENS !== undefined) {
      config.MAX_THINKING_TOKENS = globalConfig.MAX_THINKING_TOKENS;
    }

    // 6. maxContextTokens（最大上下文 token）
    if (globalConfig.maxContextTokens !== undefined) {
      config.maxContextTokens = globalConfig.maxContextTokens;
    }

    // 7. enabledPlugins（启用的插件）
    if (globalConfig.enabledPlugins) {
      config.enabledPlugins = { ...globalConfig.enabledPlugins };
    }

    // 8. permissions（合并：本地优先，全局补充）
    if (localPermissions || globalConfig.permissions) {
      config.permissions = {
        allow: [...(localPermissions?.allow || []), ...(globalConfig.permissions?.allow || [])].filter((v, i, a) => a.indexOf(v) === i),
        deny: [...(localPermissions?.deny || []), ...(globalConfig.permissions?.deny || [])].filter((v, i, a) => a.indexOf(v) === i),
        ask: [...(localPermissions?.ask || []), ...(globalConfig.permissions?.ask || [])].filter((v, i, a) => a.indexOf(v) === i)
      };
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`[Claude Code Config] 已同步全局配置到项目: ${configPath}`);

    // 同步成功后，重新获取供应商信息并通知前端更新
    const provider = await getCurrentProvider('claude', projectPath);
    console.log(`[Claude Code Config] 新的供应商信息: configSource=${provider.configSource}`);

    // 找到使用该 workingDir 的会话并更新
    const sessions = sessionManager.listSessions();
    for (const sessionData of sessions) {
      const session = sessionManager.getSession(sessionData.id);
      if (session && session.workingDir === projectPath) {
        session.claudeProvider = provider;
        sessionManager.updateSession(session);
        // 通知前端更新该会话
        io.emit('session:updated', {
          id: session.id,
          claudeProvider: provider
        });
        console.log(`[Claude Code Config] 已更新会话 ${session.name} 的供应商信息`);
      }
    }

    // 广播会话列表更新
    io.emit('sessions:updated', sessionManager.listSessions());

    res.json({ success: true, path: configPath, provider });
  } catch (err) {
    console.error('[Claude Code Config] 同步失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 删除项目级别的 Claude Code 本地配置，恢复使用全局配置
app.delete('/api/claude-code/config/local', async (req, res) => {
  try {
    const { projectPath } = req.body;

    if (!projectPath) {
      return res.status(400).json({ error: '缺少 projectPath 参数' });
    }

    // 构建本地配置文件路径
    const localConfigPath = join(projectPath, '.claude', 'settings.local.json');

    // 检查文件是否存在
    if (!existsSync(localConfigPath)) {
      return res.json({ success: true, message: '本地配置文件不存在，已使用全局配置' });
    }

    // 删除本地配置文件
    unlinkSync(localConfigPath);
    console.log('[Claude Code Config] 已删除本地配置:', localConfigPath);

    // 重新获取供应商信息（现在应该是全局配置）
    const provider = await getCurrentProvider('claude', projectPath);
    console.log(`[Claude Code Config] 删除后的供应商信息: configSource=${provider.configSource}`);

    // 找到使用该 workingDir 的会话并更新
    const sessions = sessionManager.listSessions();
    for (const sessionData of sessions) {
      const session = sessionManager.getSession(sessionData.id);
      if (session && session.workingDir === projectPath) {
        session.claudeProvider = provider;
        sessionManager.updateSession(session);
        // 通知前端更新该会话
        io.emit('session:updated', {
          id: session.id,
          claudeProvider: provider
        });
        console.log(`[Claude Code Config] 已更新会话 ${session.name} 的供应商信息`);
      }
    }

    // 广播会话列表更新
    io.emit('sessions:updated', sessionManager.listSessions());

    res.json({ success: true, message: '已删除本地配置，恢复使用全局配置', provider });
  } catch (err) {
    console.error('[Claude Code Config] 删除本地配置失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 读取 Claude Code 本地配置文件
app.get('/api/claude-code/config', (req, res) => {
  try {
    const configPath = join(os.homedir(), '.claude', 'settings.json');
    if (!existsSync(configPath)) {
      return res.json({ exists: false });
    }

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    res.json({
      exists: true,
      apiUrl: config.env?.ANTHROPIC_BASE_URL || '',
      apiKey: config.env?.ANTHROPIC_AUTH_TOKEN ? '***已配置***' : '',
      path: configPath
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// 供应商优先级配置 API
// ============================================

// 获取供应商列表和优先级配置
app.get('/api/provider-priority', async (req, res) => {
  try {
    // 获取所有 Claude 供应商
    const providers = await getAllProviders('claude');

    // 从配置文件读取优先级
    const configPath = path.join(os.homedir(), '.webtmux', 'provider-priority.json');
    let priority = CLAUDE_PROVIDER_PRIORITY; // 默认值

    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        priority = config.claude || priority;
      } catch (e) {
        console.error('[ProviderPriority] 读取配置失败:', e);
      }
    }

    res.json({
      success: true,
      providers: providers.map(p => ({ id: p.id, name: p.name })),
      priority
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 保存供应商优先级配置
app.post('/api/provider-priority', (req, res) => {
  try {
    const { priority } = req.body;
    if (!Array.isArray(priority)) {
      return res.status(400).json({ error: '优先级必须是数组' });
    }

    const configDir = path.join(os.homedir(), '.webtmux');
    const configPath = path.join(configDir, 'provider-priority.json');

    // 确保目录存在
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    // 保存配置
    const config = { claude: priority, updatedAt: new Date().toISOString() };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // 更新内存中的优先级
    CLAUDE_PROVIDER_PRIORITY.length = 0;
    CLAUDE_PROVIDER_PRIORITY.push(...priority);

    console.log('[ProviderPriority] 已保存供应商优先级:', priority);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// CLI 工具注册表 API（支持自动学习新 CLI 工具）
// ============================================

// 获取所有已注册的 CLI 工具
app.get('/api/cli-tools', (req, res) => {
  try {
    const tools = cliRegistry.getAllTools();
    res.json({ success: true, tools });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取单个 CLI 工具配置
app.get('/api/cli-tools/:id', (req, res) => {
  try {
    const tool = cliRegistry.getTool(req.params.id);
    if (!tool) {
      return res.status(404).json({ error: '工具不存在' });
    }
    res.json({ success: true, tool });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 注册新的 CLI 工具
app.post('/api/cli-tools', (req, res) => {
  try {
    const result = cliRegistry.registerTool(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 更新 CLI 工具配置
app.put('/api/cli-tools/:id', (req, res) => {
  try {
    const result = cliRegistry.updateTool(req.params.id, req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除 CLI 工具
app.delete('/api/cli-tools/:id', (req, res) => {
  try {
    const result = cliRegistry.deleteTool(req.params.id);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取未知进程列表（用于学习建议）
app.get('/api/cli-tools/learn/unknown', (req, res) => {
  try {
    const unknownProcesses = processDetector.getUnknownProcesses();
    res.json({ success: true, processes: unknownProcesses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 从未知进程学习并注册为新 CLI 工具
app.post('/api/cli-tools/learn/:processName', (req, res) => {
  try {
    const result = processDetector.learnFromUnknownProcess(
      req.params.processName,
      req.body
    );
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 从 URL 自动学习 CLI 工具配置
app.post('/api/cli-tools/learn/url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: '缺少 URL 参数' });
    }

    const result = await cliLearner.learnAndRegister('url', { url });
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 从终端内容学习 CLI 工具特征
app.post('/api/cli-tools/learn/terminal', async (req, res) => {
  try {
    const { content, processName } = req.body;
    if (!content || !processName) {
      return res.status(400).json({ error: '缺少参数' });
    }

    const result = await cliLearner.learnAndRegister('terminal', { content, processName });
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Token 统计 API ====================

// 获取全局 Token 统计摘要
app.get('/api/token-stats/summary', (req, res) => {
  try {
    const summary = tokenStatsService.getGlobalSummary();
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取今日 Token 统计
app.get('/api/token-stats/today', (req, res) => {
  try {
    const stats = tokenStatsService.getTodayStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取最近 N 天的每日统计
app.get('/api/token-stats/daily', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const stats = tokenStatsService.getRecentDailyStats(days);
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取所有供应商的 Token 统计
app.get('/api/token-stats/providers', (req, res) => {
  try {
    const stats = tokenStatsService.getProviderStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取指定供应商的 Token 统计
app.get('/api/token-stats/providers/:name', (req, res) => {
  try {
    const stats = tokenStatsService.getProviderStats(req.params.name);
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取供应商按时间统计
app.get('/api/token-stats/providers/:name/timeline', (req, res) => {
  try {
    const { granularity = 'day', startTime, endTime } = req.query;
    const stats = tokenStatsService.getProviderStatsByTime(
      req.params.name,
      granularity,
      startTime ? parseInt(startTime) : null,
      endTime ? parseInt(endTime) : null
    );
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取会话的 Token 统计
app.get('/api/token-stats/sessions/:sessionId', (req, res) => {
  try {
    const summary = tokenStatsService.getSessionSummary(req.params.sessionId);
    const byProvider = tokenStatsService.getSessionStats(req.params.sessionId);
    res.json({ success: true, data: { summary, byProvider } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取会话按时间统计
app.get('/api/token-stats/sessions/:sessionId/timeline', (req, res) => {
  try {
    const { granularity = 'hour', startTime, endTime } = req.query;
    const stats = tokenStatsService.getSessionStatsByTime(
      req.params.sessionId,
      granularity,
      startTime ? parseInt(startTime) : null,
      endTime ? parseInt(endTime) : null
    );
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取模型统计
app.get('/api/token-stats/models', (req, res) => {
  try {
    const { provider } = req.query;
    const stats = tokenStatsService.getModelStats(provider || null);
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 路由使用认证中间件
app.use('/api', authMiddleware);

// Config 路由（管理配置文件）
app.use('/api/config', configRoutes);

// CC Switch 路由（管理 CC Switch 供应商）
app.use('/api/cc-switch', ccSwitchRoutes);

// 静态文件（登录页面需要访问）
app.use(express.static(join(__dirname, '../dist')));

// CC Switch 静态文件
app.use('/cc-switch', express.static(join(__dirname, '../public/cc-switch')));

// 传递 io 实例以支持 Socket.IO 事件推送，传递 aiEngine 以支持供应商切换时重新加载配置
setupRoutes(app, sessionManager, historyLogger, io, aiEngine, healthCheckScheduler);

// 记录每个会话最后执行的操作和时间，用于防止重复执行
const lastActionMap = new Map();

// 记录每个会话的检测状态，用于动态调整检测周期
const sessionCheckState = new Map();

// 清理会话相关的缓存数据（会话删除时调用）
function cleanupSessionCache(sessionId) {
  lastActionMap.delete(sessionId);
  sessionCheckState.delete(sessionId);
  // aiStatusCache 和 aiContentHashCache 在后面定义，这里先声明清理函数
}

// 定期清理过期的缓存数据（每 10 分钟执行一次）
setInterval(() => {
  const now = Date.now();
  const expireTime = 60 * 60 * 1000; // 1 小时过期

  // 清理 lastActionMap 中超过 1 小时的数据
  for (const [sessionId, data] of lastActionMap.entries()) {
    if (now - data.time > expireTime) {
      lastActionMap.delete(sessionId);
    }
  }

  // 清理 sessionCheckState 中超过 1 小时未更新的数据
  for (const [sessionId, state] of sessionCheckState.entries()) {
    if (state.lastCheck && now - state.lastCheck > expireTime) {
      sessionCheckState.delete(sessionId);
    }
  }

  console.log(`[内存清理] lastActionMap: ${lastActionMap.size}, sessionCheckState: ${sessionCheckState.size}`);
}, 10 * 60 * 1000);
// 检测周期配置（毫秒）
const CHECK_INTERVALS = {
  BURST: 3 * 1000,     // 爆发模式 3 秒（执行操作后立即快速检测）
  FAST: 8 * 1000,      // 快速模式 8 秒（连续操作期间）
  MIN: 15 * 1000,      // 最小 15 秒（正常模式）
  DEFAULT: 30 * 1000,  // 默认 30 秒
  MAX: 30 * 60 * 1000, // 最大 30 分钟
  BURST_COUNT: 3       // 爆发模式持续次数（执行操作后连续快速检测3次）
};

// AI 服务健康状态跟踪
const aiHealthState = {
  status: 'healthy',        // 'healthy' | 'degraded' | 'failed'
  networkStatus: 'online',  // 'online' | 'offline' - 网络状态
  consecutiveErrors: 0,     // 连续错误次数
  consecutiveNetworkErrors: 0, // 连续网络错误次数
  lastError: null,          // 最后一次错误信息
  lastErrorTime: 0,         // 最后一次错误时间
  lastSuccessTime: Date.now(), // 最后一次成功时间
  recoveryCheckInterval: 5 * 60 * 1000,  // 故障后恢复检查间隔：5分钟
  networkCheckInterval: 2 * 60 * 1000,   // 网络离线后检查间隔：2分钟
  nextRecoveryCheck: 0,     // 下次恢复检查时间
  errorThreshold: 3,        // 连续错误阈值，超过则标记为故障
  networkErrorThreshold: 2, // 连续网络错误阈值，超过则标记为离线
};

// AI 操作统计
const aiOperationStats = {
  total: 0,       // 总操作次数
  success: 0,     // 成功次数
  failed: 0,      // 失败次数
  aiAnalyzed: 0,  // AI分析次数
  preAnalyzed: 0, // 程序预判断次数
  startTime: Date.now()  // 统计开始时间
};

// 判断是否是网络错误
function isNetworkError(error) {
  if (!error) return false;
  const errorMsg = error.message || String(error);
  const networkErrorPatterns = [
    'ECONNREFUSED',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'fetch failed',
    'network error',
    'Failed to fetch'
  ];
  return networkErrorPatterns.some(pattern =>
    errorMsg.toLowerCase().includes(pattern.toLowerCase())
  );
}

// 更新 AI 健康状态
function updateAiHealthState(success, error = null, isPreAnalyzed = false, sessionId = null) {
  const now = Date.now();

  // 更新全局操作统计
  aiOperationStats.total++;
  if (success) {
    aiOperationStats.success++;
  } else {
    aiOperationStats.failed++;
  }

  // 区分AI判断和程序预判断
  if (isPreAnalyzed) {
    aiOperationStats.preAnalyzed++;
  } else {
    aiOperationStats.aiAnalyzed++;
  }

  // 更新会话统计（如果提供了 sessionId）
  if (sessionId) {
    sessionManager.updateSessionStats(sessionId, {
      success,
      aiAnalyzed: !isPreAnalyzed,
      preAnalyzed: isPreAnalyzed
    });
  }

  if (success) {
    // 成功：重置所有错误计数，恢复健康状态
    const wasOffline = aiHealthState.networkStatus === 'offline';
    const wasFailed = aiHealthState.status !== 'healthy';

    if (wasOffline) {
      console.log(`[AI健康] 网络已恢复在线`);
    }
    if (wasFailed) {
      console.log(`[AI健康] 服务已恢复正常，之前状态: ${aiHealthState.status}`);
    }

    aiHealthState.status = 'healthy';
    aiHealthState.networkStatus = 'online';
    aiHealthState.consecutiveErrors = 0;
    aiHealthState.consecutiveNetworkErrors = 0;
    aiHealthState.lastSuccessTime = now;
    aiHealthState.lastError = null;
  } else {
    // 失败：判断是网络错误还是API错误
    const isNetError = isNetworkError(error);

    aiHealthState.consecutiveErrors++;
    aiHealthState.lastError = error?.message || String(error);
    aiHealthState.lastErrorTime = now;

    if (isNetError) {
      // 网络错误
      aiHealthState.consecutiveNetworkErrors++;

      if (aiHealthState.consecutiveNetworkErrors >= aiHealthState.networkErrorThreshold) {
        if (aiHealthState.networkStatus !== 'offline') {
          console.log(`[AI健康] 网络标记为离线，连续网络错误 ${aiHealthState.consecutiveNetworkErrors} 次`);
          aiHealthState.nextRecoveryCheck = now + aiHealthState.networkCheckInterval;
        }
        aiHealthState.networkStatus = 'offline';
        aiHealthState.status = 'failed';
      }
    } else {
      // API 错误（非网络问题）
      aiHealthState.consecutiveNetworkErrors = 0; // 重置网络错误计数

      if (aiHealthState.consecutiveErrors >= aiHealthState.errorThreshold) {
        if (aiHealthState.status !== 'failed') {
          console.log(`[AI健康] 服务标记为故障，连续错误 ${aiHealthState.consecutiveErrors} 次: ${aiHealthState.lastError}`);
          aiHealthState.nextRecoveryCheck = now + aiHealthState.recoveryCheckInterval;
        }
        aiHealthState.status = 'failed';
      } else {
        aiHealthState.status = 'degraded';
        console.log(`[AI健康] 服务降级，连续错误 ${aiHealthState.consecutiveErrors}/${aiHealthState.errorThreshold} 次`);
      }
    }
  }

  // 通过 Socket.IO 广播健康状态和统计信息
  if (io) {
    io.emit('ai:healthStatus', {
      status: aiHealthState.status,
      networkStatus: aiHealthState.networkStatus,
      consecutiveErrors: aiHealthState.consecutiveErrors,
      consecutiveNetworkErrors: aiHealthState.consecutiveNetworkErrors,
      lastError: aiHealthState.lastError,
      lastSuccessTime: aiHealthState.lastSuccessTime,
      nextRecoveryCheck: aiHealthState.nextRecoveryCheck
    });

    io.emit('ai:operationStats', {
      total: aiOperationStats.total,
      success: aiOperationStats.success,
      failed: aiOperationStats.failed,
      aiAnalyzed: aiOperationStats.aiAnalyzed,
      preAnalyzed: aiOperationStats.preAnalyzed,
      startTime: aiOperationStats.startTime
    });
  }
}

// 检查是否应该跳过 AI 请求（故障状态下等待恢复检查）
function shouldSkipAiRequest() {
  if (aiHealthState.status !== 'failed') {
    return false;
  }

  const now = Date.now();
  if (now >= aiHealthState.nextRecoveryCheck) {
    // 到了恢复检查时间，允许一次请求
    aiHealthState.nextRecoveryCheck = now + aiHealthState.recoveryCheckInterval;
    console.log(`[AI健康] 尝试恢复检查...`);
    return false;
  }

  return true; // 跳过请求
}

// 获取会话的下次检测时间
function getNextCheckTime(sessionId) {
  const state = sessionCheckState.get(sessionId);
  if (!state) return 0;
  // 优先使用 nextCheckTime（内容变化时会设置为 now，实现立即检测）
  if (state.nextCheckTime) {
    return state.nextCheckTime;
  }
  return state.lastCheck + state.interval;
}

// 触发立即检测（bell 事件触发时调用）
function triggerImmediateCheck(sessionId) {
  const state = sessionCheckState.get(sessionId) || {
    interval: CHECK_INTERVALS.DEFAULT,
    lastCheck: 0,
    noActionCount: 0,
    burstRemaining: 0,
    lastActionTime: 0
  };
  state.nextCheckTime = Date.now();
  sessionCheckState.set(sessionId, state);
  console.log(`[Bell] 会话 ${sessionId}: 收到 bell 信号，触发立即检测`);
}

// 为会话注册 bell 回调
function registerBellCallback(session) {
  if (!session) return;
  session.onBell(() => {
    if (session.autoActionEnabled) {
      triggerImmediateCheck(session.id);
    }
  });
}

// 更新会话检测状态
function updateCheckState(sessionId, hadAction, status) {
  const now = Date.now();
  const state = sessionCheckState.get(sessionId) || {
    interval: CHECK_INTERVALS.DEFAULT,
    lastCheck: 0,
    noActionCount: 0,
    burstRemaining: 0,  // 爆发模式剩余次数
    lastActionTime: 0   // 上次操作时间
  };

  state.lastCheck = now;
  // 清除立即检测标记（已完成本次检测）
  state.nextCheckTime = 0;

  if (hadAction) {
    // 有操作时，进入爆发模式
    state.burstRemaining = CHECK_INTERVALS.BURST_COUNT;
    state.interval = CHECK_INTERVALS.BURST;
    state.noActionCount = 0;
    state.lastActionTime = now;
    console.log(`[检测周期] 会话 ${sessionId}: 执行操作，进入爆发模式，下次检测间隔: ${state.interval / 1000}秒`);
  } else if (state.burstRemaining > 0) {
    // 爆发模式中，但本次无操作
    state.burstRemaining--;
    if (state.burstRemaining > 0) {
      // 继续爆发模式
      state.interval = CHECK_INTERVALS.BURST;
      console.log(`[检测周期] 会话 ${sessionId}: 爆发模式 (剩余${state.burstRemaining}次)，下次检测间隔: ${state.interval / 1000}秒`);
    } else {
      // 爆发模式结束，恢复到默认周期（30秒）
      state.interval = CHECK_INTERVALS.DEFAULT;
      console.log(`[检测周期] 会话 ${sessionId}: 爆发模式结束，恢复默认周期，下次检测间隔: ${state.interval / 1000}秒`);
    }
  } else {
    // 正常模式，无操作时逐步增加间隔
    state.noActionCount++;
    // 根据上次操作时间决定增长速度
    const timeSinceLastAction = now - (state.lastActionTime || 0);
    if (timeSinceLastAction < 60000) {
      // 1分钟内有过操作，保持快速模式
      state.interval = CHECK_INTERVALS.FAST;
    } else if (timeSinceLastAction < 5 * 60000) {
      // 5分钟内有过操作，使用最小间隔
      state.interval = CHECK_INTERVALS.MIN;
    } else {
      // 超过5分钟无操作，间隔翻倍
      state.interval = Math.min(state.interval * 2, CHECK_INTERVALS.MAX);
    }
    const intervalStr = state.interval >= 60000
      ? `${(state.interval / 60000).toFixed(1)}分钟`
      : `${state.interval / 1000}秒`;
    console.log(`[检测周期] 会话 ${sessionId}: 无操作 (连续${state.noActionCount}次), 下次检测间隔: ${intervalStr}`);
  }

  sessionCheckState.set(sessionId, state);
  return state;
}

// 更新所有会话的项目信息（工作目录、项目名称、项目说明）
async function updateAllSessionsProjectInfo() {
  const sessions = sessionManager.listSessions();

  for (const sessionData of sessions) {
    const session = sessionManager.getSession(sessionData.id);
    if (!session || !session.tmuxSessionName) continue;

    // 从 tmux 获取当前工作目录
    let workingDir = '';
    try {
      workingDir = execSync(`${getTmuxPrefix()} display-message -t "${session.tmuxSessionName}" -p "#{pane_current_path}"`, { encoding: 'utf-8' }).trim();
    } catch { continue; }

    // 设置 workingDir（即使没有变化也要设置，确保刷新时可用）
    const workingDirChanged = workingDir && workingDir !== session.workingDir;
    if (workingDir) {
      session.workingDir = workingDir;
    }

    // 如果工作目录没有变化，尝试刷新 goal（因为 goal.md 内容可能变化）
    if (!workingDirChanged && session.workingDir) {
      const goalFromFile = await extractProjectGoal(session.workingDir);
      if (goalFromFile && goalFromFile !== session.goal) {
        session.goal = goalFromFile;
        session.originalGoal = goalFromFile;
        sessionManager.updateSession(session);
        io.emit('session:updated', {
          id: session.id,
          goal: session.goal
        });
      }
    }

    if (!workingDirChanged) continue;

    const projectName = workingDir.split('/').filter(Boolean).pop() || workingDir;

    if (session.projectName === projectName) continue;

    session.projectName = projectName;

    // 尝试读取项目说明
    const projectDesc = await extractProjectDesc(workingDir);
    if (projectDesc) {
      session.projectDesc = projectDesc;
    }

    // 尝试读取项目目标
    const projectGoal = await extractProjectGoal(workingDir);
    if (projectGoal && (session.goal.startsWith('Continue ') || !session.goal)) {
      session.goal = projectGoal;
      session.originalGoal = projectGoal;
    }

    console.log(`[会话信息] ${session.name}: 项目=${projectName}, 说明=${session.projectDesc || '无'}`);

    // 通知前端更新
    io.emit('session:updated', {
      id: session.id,
      projectName: session.projectName,
      projectDesc: session.projectDesc,
      goal: session.goal,
      workingDir: session.workingDir
    });
  }
}

// 每 30 秒更新一次所有会话的项目信息
setInterval(updateAllSessionsProjectInfo, 30000);
// 启动时立即执行一次
setTimeout(updateAllSessionsProjectInfo, 3000);

// 后台自动操作：定时检查所有启用了自动操作的会话
async function runBackgroundAutoAction() {
  const sessions = sessionManager.listSessions();
  const now = Date.now();

  // === 独立的错误检测循环（不依赖自动操作开关）===
  for (const sessionData of sessions) {
    const session = sessionManager.getSession(sessionData.id);
    if (!session) continue;

    // 跳过正在修复中的会话
    if (session.isFixingClaudeError) continue;
    // 如果有待处理的修复建议，且自动操作已开启，则清除建议并继续执行修复
    if (session.pendingFixSuggestion && sessionData.autoActionEnabled) {
      console.log(`[错误修复] 会话 ${session.name}: 自动操作已开启，清除待处理的修复建议，直接执行修复`);
      session.pendingFixSuggestion = false;
      session.pendingFixContext = null;
    }
    // 跳过已经发送过修复建议的会话（等待用户确认，仅非自动模式）
    if (session.pendingFixSuggestion) continue;

    const terminalContent = session.getScreenContent();
    if (!terminalContent || terminalContent.length < 50) continue;

    // 检测 Claude Code API 错误
    const terminalLines = terminalContent.split('\n');
    const last20Lines = terminalLines.slice(-20).join('\n');

    // 检测 CLI 工具是否在运行 - 使用统一的 ProcessDetector 服务
    const tmuxSession = session.tmuxSessionName;
    const cliDetection = processDetector.detectWithFallback(tmuxSession, last20Lines);
    const isClaudeCodePresent = cliDetection.detected;

    const lastFixTime = session.lastClaudeFixTime || 0;
    const fixAttempts = session.fixAttempts || 0;
    // 冷却时间：根据修复次数递增（5分钟、15分钟、30分钟...）
    const baseCooldown = 5 * 60 * 1000;
    const fixCooldown = baseCooldown * Math.pow(2, Math.min(fixAttempts, 3));
    const canFix = now - lastFixTime > fixCooldown;
    const hasApiError = claudeSessionFixer.detectApiError(terminalContent);

    // 调试日志
    if (hasApiError) {
      console.log(`[错误检测] 会话 ${session.name}: 检测到API错误, CLI=${cliDetection.cli || 'none'}(${cliDetection.method}), canFix=${canFix}, fixAttempts=${fixAttempts}, cooldown=${fixCooldown/60000}分钟, autoAction=${sessionData.autoActionEnabled}`);
    }

    // 如果修复次数过多（3次以上），延长冷却时间但不关闭自动开关
    if (hasApiError && fixAttempts >= 3) {
      // 计算更长的等待时间（30分钟 * 修复次数，最长2小时）
      const extendedCooldown = Math.min(30 * 60 * 1000 * (fixAttempts - 2), 2 * 60 * 60 * 1000);
      const remainingCooldown = Math.max(0, (lastFixTime + extendedCooldown) - now);

      if (remainingCooldown > 0) {
        const remainingMinutes = Math.ceil(remainingCooldown / 60000);
        console.log(`[错误检测] 会话 ${session.name}: 修复次数过多(${fixAttempts}次)，等待 ${remainingMinutes} 分钟后重试`);
        // 不关闭自动开关，只是跳过本次检查
        continue;
      }

      // 冷却时间已过，重置修复次数并继续尝试
      console.log(`[错误检测] 会话 ${session.name}: 冷却时间已过，重置修复次数，继续尝试修复`);
      session.fixAttempts = 0;
      historyLogger.log(session.id, {
        type: 'system',
        content: `冷却时间已过，重置修复计数，继续自动修复`
      });
    }

    if (isClaudeCodePresent && canFix && hasApiError) {
      // 获取 tmux 会话名和工作目录
      const tmuxSession = session.tmuxSessionName;
      let actualWorkingDir = session.workingDir;
      try {
        actualWorkingDir = execSync(`${getTmuxPrefix()} display-message -t "${tmuxSession}" -p "#{pane_current_path}"`, { encoding: 'utf-8' }).trim();
      } catch (e) {
        console.log(`[错误检测] 会话 ${session.name}: 无法从 tmux 获取工作目录，使用缓存值`);
      }

      // 自动模式开启时，直接执行修复；否则发送建议等待用户确认
      if (sessionData.autoActionEnabled) {
        // 增加修复次数计数
        session.fixAttempts = (session.fixAttempts || 0) + 1;
        console.log(`[错误修复] 会话 ${session.name}: 检测到 API 错误，自动模式开启，第 ${session.fixAttempts} 次修复...`);

        // 开始修复流程
        session.isFixingClaudeError = true;
        session.fixingStep = 1;
        session.fixContext = {
          workingDir: actualWorkingDir,
          tmuxSession,
          startTime: now
        };

        // 步骤1: 发送 /quit 退出 Claude Code
        console.log(`[错误修复] 会话 ${session.name}: 步骤1 - 发送 /quit 退出 Claude Code`);
        try {
          execSync(`${getTmuxPrefix()} send-keys -t "${tmuxSession}" "/quit"`);
          setTimeout(() => {
            try {
              execSync(`${getTmuxPrefix()} send-keys -t "${tmuxSession}" Enter`);
            } catch (e) {
              session.write('\r');
            }
          }, 100);
        } catch (e) {
          session.write('/quit');
          setTimeout(() => session.write('\r'), 100);
        }

        historyLogger.log(session.id, {
          type: 'system',
          content: `检测到 Claude Code API 错误，自动模式已开启，正在自动修复...`
        });

        io.to(`session:${session.id}`).emit('claude:fixStarted', {
          sessionId: session.id,
          message: '检测到 API 错误，正在自动修复...'
        });
      } else {
        console.log(`[错误检测] 会话 ${session.name}: 检测到 API 错误，发送修复建议等待用户确认...`);

        // 标记已发送建议，保存上下文
        session.pendingFixSuggestion = true;
        session.pendingFixContext = {
          workingDir: actualWorkingDir,
          tmuxSession,
          detectedAt: now
        };

        // 通知前端显示修复建议
        io.to(`session:${session.id}`).emit('claude:fixSuggestion', {
          sessionId: session.id,
          message: '检测到 Claude Code API 错误（thinking block 签名无效），建议修复会话历史记录',
          workingDir: actualWorkingDir
        });

        historyLogger.log(session.id, {
          type: 'system',
          content: `检测到 Claude Code API 错误，等待用户确认修复...`
        });
      }
    }
  }

  // === 处理正在进行的修复流程（不依赖自动操作开关）===
  for (const sessionData of sessions) {
    const session = sessionManager.getSession(sessionData.id);
    if (!session || !session.isFixingClaudeError || !session.fixContext) continue;

    const ctx = session.fixContext;
    const terminalContent = session.getScreenContent();
    const lines = terminalContent?.trim().split('\n') || [];
    const lastLines = lines.slice(-5).join('\n');
    const lastLine = lines[lines.length - 1] || '';

    // 检测状态
    const isShellPrompt = /[$#%>]\s*$/.test(lastLine) && !/esc to interrupt/i.test(lastLines);
    // Claude Code 运行中（包括工作中和空闲等待输入状态）
    const isClaudeRunning = /esc to interrupt|Context left|claude.*thinking/i.test(lastLines);
    const isClaudeReady = /^>\s*$/m.test(lastLines) || /accept edits/i.test(lastLines) || /\? for shortcuts/i.test(lastLines);

    // 检查超时（2分钟）
    if (now - ctx.startTime > 120000) {
      console.log(`[错误修复] 会话 ${session.name}: 修复超时，重置状态`);
      session.isFixingClaudeError = false;
      session.fixingStep = 0;
      session.fixContext = null;
      continue;
    }

    // 步骤1完成：Claude 已退出
    if (session.fixingStep === 1 && isShellPrompt) {
      console.log(`[错误修复] 会话 ${session.name}: 步骤1完成 - Claude 已退出，开始修复会话文件`);
      session.fixingStep = 2;

      // 步骤2: 先查找会话文件，再修复
      const sessionFile = await claudeSessionFixer.findSessionFile(ctx.workingDir);
      if (!sessionFile) {
        console.error(`[错误修复] 会话 ${session.name}: 未找到 Claude Code 会话文件`);
        historyLogger.log(session.id, {
          type: 'system',
          content: `修复失败: 未找到 Claude Code 会话文件。请手动执行 claude -c`
        });
        session.isFixingClaudeError = false;
        session.fixContext = null;
        io.emit('claude:sessionFixed', {
          sessionId: session.id,
          success: false,
          message: '未找到 Claude Code 会话文件'
        });
        continue;
      }

      console.log(`[错误修复] 会话 ${session.name}: 找到会话文件 ${sessionFile}`);
      const fixResult = await claudeSessionFixer.fixSessionFile(sessionFile);

      if (fixResult.success) {
        console.log(`[错误修复] 会话 ${session.name}: 步骤2完成 - 修复成功，移除了 ${fixResult.removedCount} 个 thinking blocks`);
        session.fixingStep = 3;
        session.lastClaudeFixTime = now;

        // 步骤3: 重启 Claude Code
        console.log(`[错误修复] 会话 ${session.name}: 步骤3 - 发送 claude -c 继续开发`);
        try {
          execSync(`${getTmuxPrefix()} send-keys -t "${ctx.tmuxSession}" "claude -c"`);
          setTimeout(() => {
            try {
              execSync(`${getTmuxPrefix()} send-keys -t "${ctx.tmuxSession}" Enter`);
            } catch (e) {
              session.write('\r');
            }
          }, 100);
        } catch (e) {
          session.write('claude -c');
          setTimeout(() => session.write('\r'), 100);
        }

        historyLogger.log(session.id, {
          type: 'system',
          content: `已自动修复（移除 ${fixResult.removedCount} 个 thinking blocks），正在重启 Claude Code...`
        });

        // 通知前端
        io.emit('claude:sessionFixed', {
          sessionId: session.id,
          success: true,
          message: `已修复 ${fixResult.removedCount} 个 thinking blocks，正在重启...`
        });
      } else {
        console.error(`[错误修复] 会话 ${session.name}: 修复失败 - ${fixResult.error}`);
        historyLogger.log(session.id, {
          type: 'system',
          content: `修复失败: ${fixResult.error}。请手动执行 claude -c`
        });
        session.isFixingClaudeError = false;
        session.fixContext = null;

        io.emit('claude:sessionFixed', {
          sessionId: session.id,
          success: false,
          message: fixResult.error
        });
      }
      continue;
    }

    // 步骤3完成：Claude 已重启（运行中或空闲等待输入），发送"继续"恢复工作
    if (session.fixingStep === 3 && (isClaudeRunning || isClaudeReady)) {
      console.log(`[错误修复] 会话 ${session.name}: 步骤3完成 - Claude 已重启，发送"继续"恢复工作`);

      // 延迟发送"继续"，等待 Claude Code 完全启动
      const tmuxSession = session.tmuxSessionName;
      setTimeout(() => {
        try {
          // 使用分开发送的方式（模拟人工输入）
          execSync(`${getTmuxPrefix()} send-keys -t "${tmuxSession}" "继续"`);
          setTimeout(() => {
            try {
              execSync(`${getTmuxPrefix()} send-keys -t "${tmuxSession}" Enter`);
            } catch (e) {
              session.write('\r');
            }
          }, 100);
          console.log(`[错误修复] 会话 ${session.name}: 已发送"继续"命令`);
        } catch (e) {
          session.write('继续');
          setTimeout(() => session.write('\r'), 100);
        }
      }, 1000);  // 等待 1 秒让 Claude Code 完全启动

      historyLogger.log(session.id, {
        type: 'system',
        content: `Claude Code 已成功重启，正在发送"继续"恢复工作...`
      });

      session.isFixingClaudeError = false;
      session.fixingStep = 0;
      session.fixContext = null;
      session.lastClaudeFixTime = now;  // 更新修复时间，避免重复触发
    }
  }

  // === 原有的自动操作逻辑（需要开启自动操作开关）===
  for (const sessionData of sessions) {
    if (!sessionData.autoActionEnabled) continue;

    const session = sessionManager.getSession(sessionData.id);
    if (!session || session.isAutoActioning) continue;

    // 先快速检查终端内容是否变化（每次循环都检查）
    const quickContent = session.getScreenContent();
    if (quickContent && quickContent.length >= 10) {
      const contentHash = computeContentHash(quickContent, 1000);
      const state = sessionCheckState.get(sessionData.id) || {
        noActionCount: 0,
        nextCheckTime: 0,
        interval: CHECK_INTERVALS.DEFAULT,
        lastCheck: 0
      };
      if (state.lastContentHash && state.lastContentHash !== contentHash) {
        // 内容变化了，重置检测间隔
        state.noActionCount = 0;
        state.nextCheckTime = now;
        sessionCheckState.set(sessionData.id, state);
        console.log(`[检测周期] 会话 ${sessionData.id}: 终端内容变化，重置检测间隔`);
      }
      state.lastContentHash = contentHash;
      sessionCheckState.set(sessionData.id, state);
    }

    // 检查是否到了下次检测时间
    const nextCheck = getNextCheckTime(sessionData.id);
    if (now < nextCheck) {
      continue; // 还没到检测时间，跳过
    }

    session.isAutoActioning = true;

    try {
      const terminalContent = quickContent || session.getScreenContent();
      if (!terminalContent || terminalContent.length < 10) {
        session.isAutoActioning = false;
        updateCheckState(sessionData.id, false, null);
        continue;
      }

      // 先尝试 preAnalyze（不需要 AI API）- 传入 tmuxSession 用于进程检测
      const preResult = aiEngine.preAnalyzeStatus(terminalContent, sessionData.aiType || 'claude', session.tmuxSessionName);
      if (preResult) {
        console.log(`[后台自动操作] 会话 ${session.name}: 预判断成功 - ${preResult.currentState}`);
        // 使用预判断结果，跳过 AI 调用
        let status = preResult;
        updateAiHealthState(true, null, true, sessionData.id);

        // 检查是否需要 AI 错误分析（检测到 API 错误但需要判断类型）
        if (status.needsErrorAnalysis && status.errorContent) {
          console.log(`[后台自动操作] 会话 ${session.name}: 需要 AI 分析错误类型`);
          try {
            const errorAnalysis = await aiEngine.analyzeApiError(status.errorContent);
            console.log(`[后台自动操作] AI 错误分析结果: ${errorAnalysis.errorType} -> ${errorAnalysis.action}`);

            // 合并分析结果到 status
            status = {
              ...status,
              ...errorAnalysis,
              needsAction: true,
              actionType: 'auto_fix',
              actionReason: `AI分析: ${errorAnalysis.reason}`,
              suggestion: errorAnalysis.reason
            };
          } catch (err) {
            console.error(`[后台自动操作] AI 错误分析失败:`, err.message);
            // 分析失败时使用默认策略
            status = {
              ...status,
              shouldAutoFix: true,
              autoFixAction: 'wait_and_retry',
              needsAction: true,
              actionType: 'auto_fix',
              actionReason: 'AI 分析失败，默认等待重试',
              suggestion: '等待 60 秒后重试'
            };
          }
        }

        // 检查是否需要自动修复（连续错误等情况）- 不再关闭自动开关
        if (status.shouldAutoFix) {
          console.log(`[后台自动操作] 会话 ${session.name}: 检测到连续错误，启动自动修复 (${status.autoFixAction})`);

          // 根据错误类型执行不同的修复策略
          if (status.autoFixAction === 'switch_provider') {
            // 服务器不可用或余额不足：尝试切换 API 供应商
            const switched = await tryAutoSwitchProvider(session, sessionData, status);
            if (switched) {
              historyLogger.log(session.id, {
                type: 'system',
                content: `检测到 API 不可用，建议切换供应商: ${switched.newProvider}\n供应商列表: ${switched.allProviders.map(p => p.name + (p.isCurrent ? '(当前)' : '')).join(' → ')}`
              });
            }
          } else if (status.autoFixAction === 'run_fixer') {
            // thinking 错误：启动 ClaudeSessionFixer 修复程序
            console.log(`[后台自动操作] 会话 ${session.name}: thinking 错误，启动修复程序`);
            const tmuxSession = session.tmuxSessionName;
            const workingDir = session.workingDir;

            // 标记正在修复
            session.isFixingClaudeError = true;
            session.fixAttempts = (session.fixAttempts || 0) + 1;

            // 调用 ClaudeSessionFixer
            const fixResult = await claudeSessionFixer.fix(tmuxSession, workingDir);

            historyLogger.log(session.id, {
              type: 'system',
              content: `thinking 错误，启动修复程序 (第${session.fixAttempts}次): ${fixResult.success ? '成功' : fixResult.error}`
            });

            session.isFixingClaudeError = false;
            session.lastClaudeFixTime = Date.now();
          } else if (status.autoFixAction === 'wait_and_retry') {
            // 频率限制：等待后重试
            console.log(`[后台自动操作] 会话 ${session.name}: 频率限制，等待 60 秒后重试`);
            session.nextAutoCheckTime = Date.now() + 60000;
            historyLogger.log(session.id, {
              type: 'system',
              content: `API 请求频率受限，等待 60 秒后自动重试`
            });
          }

          // 通知前端（但不关闭自动开关）
          io.to(`session:${session.id}`).emit('session:autoFixing', {
            sessionId: session.id,
            reason: status.actionReason,
            suggestion: status.suggestion,
            fixAction: status.autoFixAction
          });

          session.isAutoActioning = false;
          updateCheckState(sessionData.id, false, status);
          continue;
        }

        // 处理需要操作的情况
        if (status.needsAction && status.suggestedAction) {
          // 跳转到操作执行逻辑（复用后面的代码）
          // 这里直接处理
          const action = status.suggestedAction;
          const lastAction = lastActionMap.get(session.id);
          const contentHash = computeContentHash(terminalContent, 500);

          // 对于选项选择操作，使用更短的冷却时间（3秒）
          // 因为如果内容没变化，可能是操作没成功，需要重试
          const cooldownTime = status.actionType === 'select' ? 3000 : 30000;

          if (lastAction && lastAction.action === action && lastAction.contentHash === contentHash && (now - lastAction.time) < cooldownTime) {
            console.log(`[后台自动操作] 会话 ${session.name}: 跳过重复操作 "${action}" (冷却${cooldownTime/1000}秒)`);
            session.isAutoActioning = false;
            updateCheckState(sessionData.id, false, status);
            continue;
          }

          // 执行操作
          const keyMap = { 'Enter': '\r', 'Tab': '\t', 'Escape': '\x1b' };
          if (keyMap[action]) {
            console.log(`[后台自动操作] 会话 ${session.name}: 发送特殊按键 "${action}"`);
            session.write(keyMap[action]);
          } else if (status.actionType === 'select' && /^[1-9]$/.test(action)) {
            const tmuxSession = session.tmuxSessionName;
            console.log(`[后台自动操作] 会话 ${session.name}: 选项菜单选择第${action}项`);
            try {
              execSync(`${getTmuxPrefix()} send-keys -t "${tmuxSession}" "${action}"`);
            } catch (e) {
              session.write(action);
            }
          } else if (status.actionType === 'text_input' || action.length > 1) {
            // Claude Code 文本输入模式：分两次发送，模拟人工输入
            console.log(`[后台自动操作] 会话 ${session.name}: 分开发送文本 "${action}" + CR`);
            session.write(action);
            // 延迟 200ms 后发送回车
            setTimeout(() => {
              session.write('\r');
            }, 200);
          } else {
            // 单个字符（如 y/n）：不加回车，直接发送
            console.log(`[后台自动操作] 会话 ${session.name}: 发送单字符 "${action}"`);
            session.write(action);
          }

          lastActionMap.set(session.id, { action, time: now, contentHash });
          historyLogger.log(session.id, {
            type: 'ai_decision',
            content: `[预判断自动操作] ${action}`,
            aiGenerated: true,
            aiReasoning: status.actionReason
          });
          io.to(`session:${session.id}`).emit('ai:autoActionExecuted', {
            sessionId: session.id,
            action,
            reason: status.actionReason,
            status
          });
          updateCheckState(sessionData.id, true, status);
        } else {
          updateCheckState(sessionData.id, false, status);
        }

        session.isAutoActioning = false;
        continue;
      }

      // preAnalyze 失败，需要 AI 分析
      // 检查 AI 服务健康状态
      if (shouldSkipAiRequest()) {
        console.log(`[后台自动操作] 会话 ${session.name}: AI 服务故障，跳过分析`);
        session.isAutoActioning = false;
        continue;
      }

      // 跳过正在修复中的会话（修复逻辑已独立处理）
      if (session.isFixingClaudeError) {
        session.isAutoActioning = false;
        continue;
      }

      console.log(`[后台自动操作] 会话 ${session.name}: 分析终端状态...`);
      const status = await aiEngine.analyzeStatus(terminalContent, session.aiType || 'claude', sessionData.id);

      // AI 分析成功，更新健康状态（区分AI判断和程序预判断）
      updateAiHealthState(true, null, status?.preAnalyzed || false, sessionData.id);

      // 更新会话信息（工作目录、名称、项目说明）
      // 直接从 tmux 获取当前工作目录，比 AI 分析更准确
      let workingDir = '';
      try {
        workingDir = execSync(`${getTmuxPrefix()} display-message -t "${session.tmuxSessionName}" -p "#{pane_current_path}"`, { encoding: 'utf-8' }).trim();
      } catch {}

      if (workingDir && workingDir !== session.workingDir) {
        const projectName = workingDir.split('/').filter(Boolean).pop() || workingDir;

        // 只在名称变化时更新
        if (session.projectName !== projectName) {
          session.projectName = projectName;
          session.workingDir = workingDir;

          // 尝试读取项目说明
          const projectDesc = await extractProjectDesc(workingDir);
          if (projectDesc) {
            session.projectDesc = projectDesc;
          }

          // 通知前端更新
          io.emit('session:updated', {
            id: session.id,
            projectName: session.projectName,
            projectDesc: session.projectDesc || '',
            workingDir: session.workingDir
          });

          console.log(`[会话信息] ${session.name}: 项目=${projectName}, 说明=${session.projectDesc || '无'}`);
        }
      }

      // 情况1：需要交互操作（如确认、选择、文本输入等）
      if (status && status.needsAction && status.suggestedAction && status.actionType !== 'input') {
        const action = status.suggestedAction;

        // 检查是否在冷却时间内
        // 对于选项选择操作，使用更短的冷却时间（3秒），因为内容未变可能是操作失败
        // 其他操作使用 30 秒冷却
        const lastAction = lastActionMap.get(session.id);
        const now = Date.now();
        const contentHash = computeContentHash(terminalContent, 500);
        const cooldownTime = status.actionType === 'select' ? 3000 : 30000;

        if (lastAction && lastAction.action === action && lastAction.contentHash === contentHash && (now - lastAction.time) < cooldownTime) {
          console.log(`[后台自动操作] 会话 ${session.name}: 跳过重复操作 "${action}" (冷却${cooldownTime/1000}秒，剩余 ${Math.ceil((cooldownTime - (now - lastAction.time)) / 1000)}秒)`);
          session.isAutoActioning = false;
          continue;
        }

        // 处理特殊按键名称
        const keyMap = {
          'Enter': '\r',
          'enter': '\r',
          'Tab': '\t',
          'tab': '\t',
          'Escape': '\x1b',
          'escape': '\x1b',
          'Esc': '\x1b',
          'esc': '\x1b',
        };

        if (keyMap[action]) {
          // 如果是特殊按键名称，转换为实际按键，直接发送
          console.log(`[后台自动操作] 会话 ${session.name}: 发送特殊按键 "${action}"`);
          session.write(keyMap[action]);
        } else if (status.actionType === 'select' && /^[1-9]$/.test(action)) {
          // Claude Code 选项菜单（如 "Do you want to proceed?"）：
          // 使用 tmux send-keys 直接发送数字，更可靠
          const tmuxSession = session.tmuxSessionName;
          console.log(`[后台自动操作] 会话 ${session.name}: 选项菜单选择第${action}项，通过 tmux 发送`);
          try {
            execSync(`${getTmuxPrefix()} send-keys -t "${tmuxSession}" "${action}"`);
            console.log(`[后台自动操作] 会话 ${session.name}: tmux send-keys 执行成功`);
          } catch (e) {
            console.error(`[后台自动操作] 会话 ${session.name}: tmux send-keys 失败:`, e.message);
            // 回退到 session.write
            session.write(action);
          }
        } else if (status.actionType === 'text_input' || action.length > 1) {
          // Claude Code 文本输入模式或多字符操作：
          // 关键：分两次发送，模拟人工输入！
          console.log(`[后台自动操作] 会话 ${session.name}: 分开发送文本 "${action}" + CR`);
          session.write(action);
          // 延迟 200ms 后发送回车
          setTimeout(() => {
            session.write('\r');
          }, 200);
        } else {
          // 单个字符（如 y/n）：不加回车，直接发送
          console.log(`[后台自动操作] 会话 ${session.name}: 发送单字符 "${action}"`);
          session.write(action);
        }

        // 记录本次操作（包含内容哈希，用于检测终端内容变化）
        lastActionMap.set(session.id, { action, time: now, contentHash });

        historyLogger.log(session.id, {
          type: 'ai_decision',
          content: `[自动操作] ${action}`,
          aiGenerated: true,
          aiReasoning: status.actionReason || '后台自动执行'
        });

        io.to(`session:${session.id}`).emit('ai:autoActionExecuted', {
          sessionId: session.id,
          action: action,
          reason: status.actionReason,
          status: status
        });

        // 有操作，重置检测周期为最小值
        updateCheckState(sessionData.id, true, status);
      } else {
        // 无操作，增加检测周期
        updateCheckState(sessionData.id, false, status);
      }
    } catch (err) {
      console.error(`[后台自动操作] 会话 ${session.name} 错误:`, err.message);
      // 更新 AI 健康状态（记录错误）
      updateAiHealthState(false, err, false, sessionData.id);
      // 出错也更新状态，避免频繁重试
      updateCheckState(sessionData.id, false, null);
    } finally {
      session.isAutoActioning = false;
    }
  }
}

// 每 1 秒检查一次（实际检测由 sessionCheckState 控制，支持爆发模式的 3 秒间隔）
setInterval(runBackgroundAutoAction, 1000);

// 后台 AI 状态分析：定期分析所有会话的状态（不依赖前端请求）
const aiStatusCache = new Map(); // 缓存每个会话的最新 AI 状态
const aiContentHashCache = new Map(); // 缓存每个会话的终端内容哈希，用于检测内容变化
const AI_ANALYSIS_INTERVAL = 30000; // 30秒

// 扩展 cleanupSessionCache 函数，清理所有会话相关缓存
function cleanupAllSessionCache(sessionId) {
  lastActionMap.delete(sessionId);
  sessionCheckState.delete(sessionId);
  aiStatusCache.delete(sessionId);
  aiContentHashCache.delete(sessionId);
}
let nextAiAnalysisTime = Date.now() + AI_ANALYSIS_INTERVAL; // 下次分析时间

// 计算内容哈希（用于检测终端内容是否变化）
// sliceLength: 可选，截取最后 N 个字符计算哈希（用于快速检测）
function computeContentHash(content, sliceLength = 0) {
  const text = content || '';
  const hashContent = sliceLength > 0 ? text.slice(-sliceLength) : text;
  return crypto.createHash('md5').update(hashContent).digest('hex');
}

async function runBackgroundStatusAnalysis() {
  // 先更新下次分析时间，确保倒计时正常显示
  nextAiAnalysisTime = Date.now() + AI_ANALYSIS_INTERVAL;
  if (io) {
    io.emit('ai:nextAnalysisTime', { nextTime: nextAiAnalysisTime });
  }

  // 检查 AI 服务健康状态
  if (shouldSkipAiRequest()) {
    console.log('[后台AI分析] AI 服务故障中，跳过本次分析');
    return;
  }

  const sessions = sessionManager.listSessions();

  // 串行处理会话，避免并发请求导致 429 错误
  for (const sessionData of sessions) {
    const session = sessionManager.getSession(sessionData.id);
    if (!session) continue;

    // 只分析开启了 AI 自动操作的会话
    if (!session.aiEnabled) {
      console.log(`[后台AI分析] 会话 ${session.name}: AI 自动操作已关闭，跳过分析`);
      continue;
    }

    try {
      const terminalContent = session.getScreenContent();
      if (!terminalContent || terminalContent.length < 10) {
        continue;
      }

      // 计算内容哈希，检测是否有变化
      const contentHash = computeContentHash(terminalContent);
      const lastHash = aiContentHashCache.get(sessionData.id);
      const cachedStatus = aiStatusCache.get(sessionData.id);

      // 如果内容没有变化且有缓存结果，跳过 API 调用
      if (lastHash === contentHash && cachedStatus) {
        console.log(`[后台AI分析] 会话 ${session.name}: 内容无变化，跳过分析`);
        // 仍然广播缓存的状态（更新时间戳）
        io.emit('ai:status', {
          sessionId: sessionData.id,
          ...cachedStatus,
          ...getAIProviderInfo(),
          skippedReason: '内容无变化'
        });
        continue;
      }

      // 更新内容哈希缓存
      aiContentHashCache.set(sessionData.id, contentHash);

      console.log(`[后台AI分析] 会话 ${session.name}: 分析状态...`);
      const status = await aiEngine.analyzeStatus(terminalContent, session.aiType || 'claude', sessionData.id);

      // AI 分析成功，更新健康状态（区分AI判断和程序预判断）
      updateAiHealthState(true, null, status?.preAnalyzed || false, sessionData.id);

      if (status) {
        // 如果检测到 CLI 工具运行，动态更新 session 的供应商信息
        // 仅在 CLI 类型切换时或供应商未设置时更新，不覆盖用户手动设置的配置
        const cliType = status.detectedCLI || session.aiType;
        if (cliType) {
          // CLI 类型切换时更新 session.aiType
          const cliTypeChanged = status.detectedCLI && status.detectedCLI !== session.aiType;
          if (cliTypeChanged) {
            console.log(`[后台AI分析] 检测到 CLI 工具切换: ${session.aiType} -> ${status.detectedCLI}`);
            session.aiType = status.detectedCLI;
          }

          // 仅在供应商未设置或 CLI 类型切换时才更新供应商
          // 不要每次都刷新，以保留用户手动设置的配置
          const currentProvider = cliType === 'claude' ? session.claudeProvider :
                                  cliType === 'codex' ? session.codexProvider :
                                  session.geminiProvider;

          if (!currentProvider || cliTypeChanged) {
            const provider = await getCurrentProvider(cliType, session.workingDir);
            if (cliType === 'claude') {
              session.claudeProvider = provider;
            } else if (cliType === 'codex') {
              session.codexProvider = provider;
            } else if (cliType === 'gemini') {
              session.geminiProvider = provider;
            }

            // 通知前端更新 session 信息（包括供应商）
            io.emit('sessions:updated', sessionManager.listSessions());
            console.log(`[后台AI分析] 已更新 session 供应商: ${provider.name} (${provider.url})`);
          }
        }

        // 缓存分析结果
        aiStatusCache.set(sessionData.id, {
          ...status,
          updatedAt: new Date().toISOString()
        });

        // 获取当前会话的 CLI 供应商信息（Claude Code/Codex/Gemini 实际使用的配置）
        const cliProvider = status.detectedCLI === 'claude' ? session.claudeProvider :
                            status.detectedCLI === 'codex' ? session.codexProvider :
                            status.detectedCLI === 'gemini' ? session.geminiProvider : null;

        // 广播给所有连接的客户端（使用 io.emit 而不是 io.to(room).emit）
        // 因为后台分析是对所有会话进行的，前端会根据 sessionId 过滤
        io.emit('ai:status', {
          sessionId: sessionData.id,
          ...status,
          ...getAIProviderInfo(),
          // Claude Code/Codex/Gemini 实际使用的供应商信息
          cliProviderName: cliProvider?.name || null,
          cliProviderUrl: cliProvider?.url || null,
          cliProviderModel: cliProvider?.model || null
        });

        console.log(`[后台AI分析] 会话 ${session.name}: 分析完成`);
      }

      // 会话之间延迟 2 秒，避免并发请求
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err) {
      console.error(`[后台AI分析] 会话 ${session.name} 错误:`, err.message);
      // 更新 AI 健康状态（记录错误）
      updateAiHealthState(false, err, false, sessionData.id);
      // 出错后也延迟，避免频繁重试
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// 每 30 秒运行一次后台 AI 状态分析
setInterval(runBackgroundStatusAnalysis, AI_ANALYSIS_INTERVAL);
// 启动后 5 秒执行第一次分析
setTimeout(runBackgroundStatusAnalysis, 5000);

/**
 * 切换供应商 - 简化版：直接将选中供应商的配置写入本地配置文件
 */
async function switchProviderStateMachine(session, appType, providerId, socket) {
  const sessionId = session.id;
  const emitStatus = (step, message, progress) => {
    socket.emit('provider:switchStatus', { sessionId, step, message, progress });
  };

  try {
    // 检查是否有工作目录
    if (!session.workingDir) {
      throw new Error('会话没有工作目录，无法设置本地配置');
    }

    // 从 CC Switch 数据库读取供应商信息
    const ccSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
    if (!existsSync(ccSwitchDbPath)) {
      throw new Error('CC Switch 数据库不存在');
    }

    emitStatus('READING', '读取供应商配置...', 20);

    const db = new Database(ccSwitchDbPath, { readonly: true });
    const targetProviderRow = db.prepare('SELECT * FROM providers WHERE id = ? AND app_type = ?').get(providerId, appType);
    db.close();

    if (!targetProviderRow) {
      throw new Error('目标供应商不存在');
    }

    // 解析 settings_config
    let settingsConfig = {};
    try {
      if (targetProviderRow.settings_config) {
        settingsConfig = typeof targetProviderRow.settings_config === 'string'
          ? JSON.parse(targetProviderRow.settings_config)
          : targetProviderRow.settings_config;
      }
    } catch (parseErr) {
      console.error('[Provider Switch] 解析 settings_config 失败:', parseErr);
    }

    const targetProvider = {
      id: targetProviderRow.id,
      name: targetProviderRow.name,
      appType: targetProviderRow.app_type,
      settingsConfig: settingsConfig
    };

    // 写入项目本地配置
    emitStatus('WRITING', '写入本地配置...', 50);

    const projectClaudeDir = path.join(session.workingDir, '.claude');
    if (!existsSync(projectClaudeDir)) {
      mkdirSync(projectClaudeDir, { recursive: true });
    }
    const localConfigPath = path.join(projectClaudeDir, 'settings.local.json');

    // 读取现有本地配置
    let localConfig = {};
    if (existsSync(localConfigPath)) {
      try {
        localConfig = JSON.parse(readFileSync(localConfigPath, 'utf-8'));
      } catch (e) {
        console.error('[Provider Switch] 读取本地配置失败:', e.message);
      }
    }

    // 保留本地 permissions
    const localPermissions = localConfig.permissions;

    // 写入供应商配置
    if (targetProvider.settingsConfig.env) {
      localConfig.env = { ...targetProvider.settingsConfig.env };
    }
    if (targetProvider.settingsConfig.model) {
      localConfig.model = targetProvider.settingsConfig.model;
    }
    if (targetProvider.settingsConfig.alwaysThinkingEnabled !== undefined) {
      localConfig.alwaysThinkingEnabled = targetProvider.settingsConfig.alwaysThinkingEnabled;
    }

    // 恢复本地 permissions
    if (localPermissions) {
      localConfig.permissions = localPermissions;
    }

    writeFileSync(localConfigPath, JSON.stringify(localConfig, null, 2), 'utf8');
    console.log('[Provider Switch] 本地配置已更新:', {
      path: localConfigPath,
      provider: targetProvider.name,
      url: localConfig.env?.ANTHROPIC_BASE_URL
    });

    // 更新会话的 provider 信息
    emitStatus('UPDATING', '更新会话信息...', 80);

    const providerInfo = await getCurrentProvider(appType, session.workingDir);

    if (appType === 'claude') {
      session.claudeProvider = providerInfo;
    } else if (appType === 'codex') {
      session.codexProvider = providerInfo;
    } else if (appType === 'gemini') {
      session.geminiProvider = providerInfo;
    }

    sessionManager.updateSession(session);

    // 完成
    emitStatus('COMPLETED', '配置已更新！', 100);
    socket.emit('provider:switchComplete', { sessionId, providerId, providerName: targetProvider.name });

    // 发送更新事件
    socket.emit('session:updated', {
      id: sessionId,
      claudeProvider: appType === 'claude' ? providerInfo : session.claudeProvider,
      codexProvider: appType === 'codex' ? providerInfo : session.codexProvider,
      geminiProvider: appType === 'gemini' ? providerInfo : session.geminiProvider
    });

    io.emit('sessions:updated', sessionManager.listSessions());

  } catch (err) {
    console.error('[Provider Switch] 切换失败:', err);
    socket.emit('provider:switchError', {
      sessionId,
      error: err.message
    });
  }
}

/**
 * 等待 shell 提示符出现
 */
async function waitForShellPrompt(session, timeout = 10000) {
  const startTime = Date.now();
  let lastLines = [];
  let iteration = 0;
  let content = '';

  while (Date.now() - startTime < timeout) {
    content = session.getScreenContent();
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // 检查最后 5 行（非空行）
    lastLines = lines.slice(-5);

    // 每隔 2 秒输出一次调试信息
    if (iteration % 4 === 0) {
      console.log('[Provider Switch] 等待 shell 提示符，最后 5 行:', JSON.stringify(lastLines));
    }
    iteration++;

    for (const line of lastLines) {
      // 检测真正的 shell 提示符（必须包含 % 或 $ 或 #，且包含 @ 或 ~ 表示是真正的 shell）
      // 例如: zhangzhen@zhangzhendeMacBook-Pro WebOffice %
      // 排除 Claude Code 的 > 提示符
      const isRealShellPrompt = (
        // 必须以 % 或 $ 或 # 结尾（zsh/bash/root）
        /[$#%]\s*$/.test(line) &&
        // 必须包含 @ 或 ~ 或 : （表示是真正的 shell 提示符）
        (line.includes('@') || line.includes('~') || line.includes(':'))
      );

      if (isRealShellPrompt) {
        console.log('[Provider Switch] 检测到 shell 提示符:', line);
        return true;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('[Provider Switch] 等待 shell 提示符超时');
  console.log('[Provider Switch] 最后 5 行:', JSON.stringify(lastLines));
  console.log('[Provider Switch] 完整内容（最后 500 字符）:', content.slice(-500));
  return false;
}

/**
 * 等待 Claude Code 提示符出现
 */
async function waitForClaudePrompt(session, timeout = 15000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const content = session.getScreenContent();

    // 检测 Claude Code 的提示符或特征
    if (/>\s*$/.test(content) || /Working directory:/.test(content) || /claude/i.test(content)) {
      console.log('[Provider Switch] 检测到 CLI 提示符');
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

// Socket.IO 使用 session 中间件
io.engine.use(sessionMiddleware);

// Socket.IO 认证中间件
io.use((socket, next) => {
  const req = socket.request;

  // 如果未启用认证，直接通过
  if (!authService.isAuthRequired()) {
    return next();
  }

  // 本机访问自动放行
  const ip = req.socket?.remoteAddress || '';
  const localIPs = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  if (localIPs.includes(ip)) {
    return next();
  }

  // 检查 session
  if (req.session && req.session.authenticated) {
    return next();
  }

  // 未认证
  next(new Error('需要登录'));
});

io.on('connection', (socket) => {
  console.log(`客户端连接: ${socket.id}`);

  // 发送下次 AI 分析时间
  socket.emit('ai:nextAnalysisTime', { nextTime: nextAiAnalysisTime });

  // 发送缓存的 AI 健康状态和操作统计
  socket.emit('ai:healthStatus', {
    status: aiHealthState.status,
    networkStatus: aiHealthState.networkStatus,
    consecutiveErrors: aiHealthState.consecutiveErrors,
    consecutiveNetworkErrors: aiHealthState.consecutiveNetworkErrors,
    lastError: aiHealthState.lastError,
    lastSuccessTime: aiHealthState.lastSuccessTime,
    nextRecoveryCheck: aiHealthState.nextRecoveryCheck
  });
  socket.emit('ai:operationStats', {
    total: aiOperationStats.total,
    success: aiOperationStats.success,
    failed: aiOperationStats.failed,
    aiAnalyzed: aiOperationStats.aiAnalyzed,
    preAnalyzed: aiOperationStats.preAnalyzed,
    startTime: aiOperationStats.startTime
  });

  // 获取会话列表
  socket.on('sessions:list', async () => {
    const startTime = Date.now();
    const sessions = sessionManager.listSessions();

    // 项目元数据刷新已由 updateAllSessionsProjectInfo() 定期处理

    const elapsed = Date.now() - startTime;
    if (elapsed > 50) {
      console.log(`[性能] 会话列表加载耗时: ${elapsed}ms`);
    }
    socket.emit('sessions:list', sessions);
  });

  // 创建新会话
  socket.on('session:create', async (data) => {
    try {
      const session = await sessionManager.createSession({
        name: data.name,
        goal: data.goal || '',
        systemPrompt: data.systemPrompt || ''
      });

      // 注册 bell 回调（Claude Code 需要输入时触发立即检测）
      registerBellCallback(session);

      // 保存 AI 类型
      session.aiType = data.aiType || 'claude';

      // 只获取当前会话使用的 AI 供应商信息
      // 传递 workingDir 以正确检测本地配置
      const provider = await getCurrentProvider(session.aiType, session.workingDir);

      // 根据 AI 类型保存对应的供应商信息
      if (session.aiType === 'claude') {
        session.claudeProvider = provider;
      } else if (session.aiType === 'codex') {
        session.codexProvider = provider;
      } else if (session.aiType === 'gemini') {
        session.geminiProvider = provider;
      }

      historyLogger.log(session.id, {
        type: 'system',
        content: `会话创建，目标: ${data.goal || '无'}`
      });

      // 立即检测终端内容，识别是否有 CLI 工具在运行
      try {
        const terminalContent = session.getScreenContent();
        const detectedCLI = aiEngine.detectRunningCLI(terminalContent, session.tmuxSessionName);

        if (detectedCLI && detectedCLI !== session.aiType) {
          console.log(`[Session创建] 检测到 CLI 工具: ${detectedCLI}`);
          session.aiType = detectedCLI;

          // 更新供应商信息
          const detectedProvider = await getCurrentProvider(detectedCLI, session.workingDir);
          if (detectedCLI === 'claude') {
            session.claudeProvider = detectedProvider;
          } else if (detectedCLI === 'codex') {
            session.codexProvider = detectedProvider;
          } else if (detectedCLI === 'gemini') {
            session.geminiProvider = detectedProvider;
          }
          console.log(`[Session创建] 已更新供应商: ${detectedProvider.name}`);
        }
      } catch (err) {
        console.error('[Session创建] CLI 检测失败:', err.message);
      }

      socket.emit('session:created', session);
      io.emit('sessions:updated', sessionManager.listSessions());
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  // 删除会话（永久删除）
  socket.on('session:delete', (sessionId) => {
    const success = sessionManager.deleteSession(sessionId);
    if (success) {
      // 清理会话相关的缓存数据
      cleanupAllSessionCache(sessionId);
      console.log(`会话已删除: ${sessionId}`);
      io.emit('sessions:updated', sessionManager.listSessions());
    } else {
      socket.emit('error', { message: '删除会话失败' });
    }
  });

  // 关闭会话（可恢复）
  socket.on('session:close', (sessionId) => {
    const result = sessionManager.closeSession(sessionId);
    if (result.success) {
      // 清理会话相关的缓存数据
      cleanupAllSessionCache(sessionId);
      console.log(`会话已关闭（可恢复）: ${sessionId}`);
      io.emit('sessions:updated', sessionManager.listSessions());
      socket.emit('session:closed', result.closedSession);
      // 广播关闭会话列表更新
      io.emit('closedSessions:updated', sessionManager.getClosedSessions());
    } else {
      socket.emit('error', { message: result.error || '关闭会话失败' });
    }
  });

  // 创建会话并运行继续命令（用于最近项目）
  socket.on('session:createAndResume', async (data) => {
    try {
      const session = await sessionManager.createSession({
        name: data.name,
        goal: data.projectDesc || '',
        systemPrompt: ''
      });

      // 保存项目信息
      session.aiType = data.aiType || 'claude';
      session.projectName = data.projectName;
      session.workingDir = data.workingDir;

      // 从项目目录读取真正的项目描述（CLAUDE.md 或 README.md）和目标（goal.md）
      const projectDesc = await extractProjectDesc(data.workingDir);
      session.projectDesc = projectDesc || data.projectDesc;

      // 尝试从 goal.md 读取项目目标
      const projectGoal = await extractProjectGoal(data.workingDir);
      if (projectGoal) {
        session.goal = projectGoal;
        session.originalGoal = projectGoal;
      }

      // 注册 bell 回调
      registerBellCallback(session);

      // 获取供应商信息
      const provider = await getCurrentProvider(session.aiType, session.workingDir);
      if (session.aiType === 'claude') {
        session.claudeProvider = provider;
      } else if (session.aiType === 'codex') {
        session.codexProvider = provider;
      } else if (session.aiType === 'gemini') {
        session.geminiProvider = provider;
      }

      // 保存会话
      sessionManager.updateSession(session);

      // 广播会话列表更新
      io.emit('sessions:updated', sessionManager.listSessions());

      // 通知客户端会话已创建
      socket.emit('session:created', session.toJSON());

      // 延迟执行命令：先 cd 到工作目录，再运行继续命令
      setTimeout(() => {
        if (data.workingDir) {
          session.write(`cd "${data.workingDir}"\r`);
        }
        setTimeout(() => {
          if (data.resumeCommand) {
            session.write(`${data.resumeCommand}\r`);
          }
        }, 300);
      }, 500);

      console.log(`[RecentProject] 创建会话并恢复: ${data.name} (${data.aiType})`);
    } catch (error) {
      console.error('[RecentProject] 创建会话失败:', error);
      socket.emit('error', { message: '创建会话失败: ' + error.message });
    }
  });

  // 获取最近项目列表
  socket.on('recentProjects:get', async (options = {}) => {
    try {
      const limit = options.limit || 50;  // 默认返回 50 个项目
      const projects = await RecentProjectsService.getAllRecentProjects(limit);
      socket.emit('recentProjects:list', projects);
    } catch (error) {
      console.error('[RecentProjects] 获取失败:', error);
      socket.emit('recentProjects:list', { claude: [], codex: [], gemini: [] });
    }
  });

  // 获取关闭的会话列表
  socket.on('closedSessions:get', () => {
    const closedSessions = sessionManager.getClosedSessions();
    socket.emit('closedSessions:list', closedSessions);
  });

  // 恢复关闭的会话
  socket.on('session:restore', (closedSessionId) => {
    const result = sessionManager.restoreSession(closedSessionId);
    if (result.success) {
      console.log(`会话已恢复: ${closedSessionId}`);
      io.emit('sessions:updated', sessionManager.listSessions());
      io.emit('closedSessions:updated', sessionManager.getClosedSessions());
      socket.emit('session:restored', result.session);
    } else {
      socket.emit('session:restoreError', {
        error: result.error,
        expired: result.expired
      });
    }
  });

  // 永久删除关闭的会话
  socket.on('closedSession:delete', (closedSessionId) => {
    const result = sessionManager.deleteClosedSession(closedSessionId);
    if (result.success) {
      console.log(`已永久删除关闭的会话: ${closedSessionId}`);
      io.emit('closedSessions:updated', sessionManager.getClosedSessions());
    } else {
      socket.emit('error', { message: result.error || '删除失败' });
    }
  });

  // 附加到会话
  socket.on('session:attach', (sessionId) => {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      socket.emit('error', { message: '会话不存在' });
      return;
    }

    // 如果之前已附加到其他会话，先清理
    if (socket.data.currentSessionId && socket.data.outputCallback) {
      const oldSession = sessionManager.getSession(socket.data.currentSessionId);
      if (oldSession) {
        oldSession.offOutput(socket.data.outputCallback);
        oldSession.detach();
      }
      socket.leave(`session:${socket.data.currentSessionId}`);
    }

    socket.join(`session:${sessionId}`);
    socket.data.currentSessionId = sessionId;

    // 客户端连接时 attach PTY
    session.attach();

    // 获取 tmux 面板当前可见内容和光标位置
    const paneContent = session.capturePane();
    const fullContent = session.captureFullPane(); // 包含滚动历史
    const cursorPos = session.getCursorPosition();

    // 如果面板有内容且历史为空，记录初始状态
    const existingHistory = historyLogger.getHistory(sessionId, 1);
    if (paneContent && existingHistory.length === 0) {
      historyLogger.log(sessionId, {
        type: 'output',
        content: paneContent
      });
    }

    // 发送会话信息和完整内容（包含滚动历史）
    socket.emit('session:attached', {
      session: session.toJSON(),
      history: [], // 历史记录异步加载
      screenContent: paneContent,
      fullContent: fullContent, // 完整内容（包含滚动历史）
      cursorPosition: cursorPos
    });

    // 异步发送历史记录（限制数量提升性能）
    setImmediate(() => {
      const startTime = Date.now();
      const history = historyLogger.getHistory(sessionId, 20);
      const elapsed = Date.now() - startTime;
      if (elapsed > 50) {
        console.log(`[性能] 历史记录加载耗时: ${elapsed}ms`);
      }
      socket.emit('session:history', { sessionId, history });
    });

    // 立即发送缓存的 AI 状态（如果有）
    const cachedAiStatus = aiStatusCache.get(sessionId);
    if (cachedAiStatus) {
      socket.emit('ai:status', {
        sessionId,
        ...cachedAiStatus,
        ...getAIProviderInfo()
      });
    }

    // 设置终端输出监听，保存回调引用以便后续移除
    const outputCallback = (data) => {
      io.to(`session:${sessionId}`).emit('terminal:output', {
        sessionId,
        data
      });

      // 录制终端输出（包含终端尺寸）
      const termSize = session.pty ? { cols: session.pty.cols, rows: session.pty.rows } : null;
      terminalRecorder.recordOutput(sessionId, data, termSize);

      // 保存会话项目信息（用于历史记录显示）
      terminalRecorder.saveSessionInfo(sessionId, {
        projectName: session.projectName,
        projectDir: session.projectDir,
        projectDesc: session.projectDesc,
        name: session.name
      });

      // 如果 AI 启用且后台自动操作未开启，触发基于目标的分析
      // 注：如果后台自动操作已开启，则由后台循环处理，无需重复分析
      if (session.aiEnabled && !session.autoActionEnabled) {
        handleAIAnalysis(sessionId, session, socket);
      }
    };
    socket.data.outputCallback = session.onOutput(outputCallback);

    // 让 tmux 刷新屏幕，发送当前状态到客户端
    setTimeout(() => {
      session.refreshScreen();
    }, 100);
  });

  // 终端输入
  socket.on('terminal:input', async (data) => {
    const session = sessionManager.getSession(data.sessionId);
    if (session) {
      // 调试：打印收到的输入（显示特殊字符）
      const debugInput = data.input
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\x1b/g, '\\x1b');
      console.log(`[终端输入] 会话 ${session.name}: "${debugInput}" (长度: ${data.input.length}, 字节: ${Buffer.from(data.input).toString('hex')})`);

      // 维护输入缓冲区，检测 CLI 命令
      if (!session._inputBuffer) session._inputBuffer = '';

      // 处理退格键
      if (data.input === '\x7f' || data.input === '\b') {
        session._inputBuffer = session._inputBuffer.slice(0, -1);
      } else if (data.input === '\r' || data.input === '\n') {
        // 回车时检查缓冲区
        const cmd = session._inputBuffer.trim();
        console.log(`[终端输入] 会话 ${session.name}: 检测命令 "${cmd}"`);

        // 使用 CliRegistry 动态检测 CLI 命令
        const detectedTool = cliRegistry.findByCommand(cmd);
        if (detectedTool) {
          const cliType = detectedTool.id;
          console.log(`[CLI检测] 检测到 ${detectedTool.name} (${cliType}) 启动命令`);
          session.aiType = cliType;

          // 先获取当前工作目录，以便正确检测本地配置
          let cliWorkingDir = session.workingDir;
          try {
            cliWorkingDir = execSync(`${getTmuxPrefix()} display-message -t "${session.tmuxSessionName}" -p "#{pane_current_path}"`, { encoding: 'utf-8' }).trim();
            if (cliWorkingDir) {
              session.workingDir = cliWorkingDir;
              session.projectName = cliWorkingDir.split('/').filter(Boolean).pop() || cliWorkingDir;
              console.log(`[CLI检测] 工作目录: ${cliWorkingDir}`);
            }
          } catch (e) {
            console.error(`[CLI检测] 获取工作目录失败:`, e.message);
          }

          // 传递 workingDir 以正确检测本地配置
          const provider = await getCurrentProvider(cliType, cliWorkingDir);
          if (provider.exists) {
            session[`${cliType}Provider`] = provider;

            // 读取项目任务文件并生成初始化目标
            if (cliWorkingDir) {
              try {
                // 先快速获取项目描述
                const quickDesc = await projectTaskReader.getQuickProjectDesc(cliWorkingDir);
                if (quickDesc) {
                  session.projectDesc = quickDesc;
                }

                // 异步生成完整的项目目标（不阻塞）
                projectTaskReader.generateProjectGoal(cliWorkingDir, aiEngine)
                  .then(goal => {
                    if (goal && goal !== session.goal) {
                      session.goal = goal;
                      sessionManager.updateSession(session);
                      io.emit('sessions:updated', sessionManager.listSessions());
                      io.to(`session:${session.id}`).emit('session:updated', session.toJSON());
                      console.log(`[CLI检测] 已生成项目目标: ${goal.slice(0, 50)}...`);
                    }
                  })
                  .catch(err => {
                    console.error(`[CLI检测] 生成项目目标失败:`, err.message);
                    // 使用默认目标
                    session.goal = projectTaskReader.getDefaultGoal();
                    sessionManager.updateSession(session);
                  });
              } catch (e) {
                console.error(`[CLI检测] 读取项目信息失败:`, e.message);
              }
            }

            sessionManager.updateSession(session);
            // 通知前端更新
            io.emit('sessions:updated', sessionManager.listSessions());
            io.to(`session:${session.id}`).emit('session:updated', session.toJSON());
            console.log(`[CLI检测] 已更新 ${cliType} 供应商: ${provider.name}`);
          }
        }

        // 清空缓冲区
        session._inputBuffer = '';
      } else if (data.input.length === 1 && data.input >= ' ') {
        // 普通可打印字符
        session._inputBuffer += data.input;
      } else if (data.input.length > 1 && !data.input.includes('\x1b')) {
        // 粘贴的文本
        session._inputBuffer += data.input;
      }

      session.write(data.input);

      // 录制终端输入
      terminalRecorder.recordInput(data.sessionId, data.input);
    }
  });

  // 调整终端大小
  socket.on('terminal:resize', (data) => {
    const session = sessionManager.getSession(data.sessionId);
    if (session) {
      session.resize(data.cols, data.rows);
    }
  });

  // 更新会话设置
  socket.on('session:update', (data) => {
    const session = sessionManager.getSession(data.sessionId);
    if (session) {
      session.updateSettings({
        goal: data.goal,
        systemPrompt: data.systemPrompt,
        aiEnabled: data.aiEnabled,
        autoMode: data.autoMode
      });

      // 保存到数据库，确保目标等设置持久化
      sessionManager.updateSession(session);

      io.to(`session:${data.sessionId}`).emit('session:updated', session.toJSON());
      io.emit('sessions:updated', sessionManager.listSessions());
    }
  });

  // AI 生成目标
  socket.on('goal:generate', async (data) => {
    const session = sessionManager.getSession(data.sessionId);
    if (!session) {
      socket.emit('goal:generated', { sessionId: data.sessionId, goal: null, error: '会话不存在' });
      return;
    }

    try {
      // 获取终端内容作为上下文
      const screenContent = session.getScreenContent ? session.getScreenContent() : '';

      // 构建 prompt
      const context = [];
      if (session.projectName) context.push(`项目名称: ${session.projectName}`);
      if (session.projectDesc) context.push(`项目说明: ${session.projectDesc}`);
      if (session.workingDir) context.push(`工作目录: ${session.workingDir}`);
      if (screenContent) context.push(`终端内容:\n${screenContent.slice(-2000)}`);

      const prompt = `基于以下上下文，生成一个简洁的开发目标（一句话，15-30字）：

${context.join('\n\n')}

要求：
- 用中文回答
- 只输出目标本身，不要任何前缀或解释
- 目标应该具体、可执行
- 如果上下文不足，可以基于项目类型推测一个合理的目标`;

      console.log(`[目标生成] 会话 ${session.name}: 开始生成...`);
      const goal = await aiEngine.generateText(prompt);

      if (goal) {
        console.log(`[目标生成] 会话 ${session.name}: ${goal}`);
        socket.emit('goal:generated', { sessionId: data.sessionId, goal: goal.trim() });
      } else {
        console.log(`[目标生成] 会话 ${session.name}: 生成失败`);
        socket.emit('goal:generated', { sessionId: data.sessionId, goal: null, error: '生成失败' });
      }
    } catch (err) {
      console.error(`[目标生成] 错误:`, err.message);
      socket.emit('goal:generated', { sessionId: data.sessionId, goal: null, error: err.message });
    }
  });

  // 执行 AI 建议
  socket.on('ai:execute', async (data) => {
    const session = sessionManager.getSession(data.sessionId);
    if (session) {
      session.write(data.command + '\r');

      historyLogger.log(data.sessionId, {
        type: 'input',
        content: data.command,
        aiGenerated: true,
        aiReasoning: data.reasoning
      });

      io.to(`session:${data.sessionId}`).emit('ai:executed', {
        sessionId: data.sessionId,
        command: data.command
      });
    }
  });

  // 切换自动模式
  socket.on('ai:toggleAuto', (data) => {
    const session = sessionManager.getSession(data.sessionId);
    if (session) {
      session.autoMode = data.enabled;
      io.to(`session:${data.sessionId}`).emit('session:updated', session.toJSON());

      historyLogger.log(data.sessionId, {
        type: 'system',
        content: `自动模式${data.enabled ? '开启' : '关闭'}`
      });
    }
  });

  // 切换后台自动操作开关
  socket.on('ai:toggleAutoAction', (data) => {
    const session = sessionManager.getSession(data.sessionId);
    if (session) {
      session.updateSettings({ autoActionEnabled: data.enabled });
      sessionManager.updateSession(session);

      io.to(`session:${data.sessionId}`).emit('session:updated', session.toJSON());
      io.emit('sessions:updated', sessionManager.listSessions());

      historyLogger.log(data.sessionId, {
        type: 'system',
        content: `后台自动操作${data.enabled ? '开启' : '关闭'}`
      });

      console.log(`[自动操作] 会话 ${session.name}: ${data.enabled ? '开启' : '关闭'}`);
    }
  });

  // ========== 预约管理事件 ==========

  // 创建预约
  socket.on('schedule:create', (data) => {
    try {
      console.log(`[预约] 创建请求, sessionId: ${data.sessionId}, type: ${data.type}, time: ${data.time}`);
      const schedule = scheduleManager.createSchedule(data);
      socket.emit('schedule:created', schedule);
      socket.emit('schedule:list', scheduleManager.getSessionSchedules(data.sessionId));
      console.log(`[预约] 创建成功: ${schedule.id}, sessionId: ${schedule.sessionId}`);
    } catch (error) {
      socket.emit('schedule:error', { error: error.message });
      console.error('[预约] 创建失败:', error);
    }
  });

  // 获取会话的所有预约
  socket.on('schedule:getList', (data) => {
    try {
      console.log(`[预约] 获取列表请求, sessionId: ${data.sessionId}`);
      const schedules = scheduleManager.getSessionSchedules(data.sessionId);
      console.log(`[预约] 返回 ${schedules.length} 条预约`);
      socket.emit('schedule:list', schedules);
    } catch (error) {
      socket.emit('schedule:error', { error: error.message });
      console.error('[预约] 获取列表失败:', error);
    }
  });

  // 更新预约
  socket.on('schedule:update', (data) => {
    try {
      const { id, ...updates } = data;
      const schedule = scheduleManager.updateSchedule(id, updates);
      if (schedule) {
        socket.emit('schedule:updated', schedule);
        socket.emit('schedule:list', scheduleManager.getSessionSchedules(schedule.sessionId));
        console.log(`[预约] 更新预约: ${id}`);
      } else {
        socket.emit('schedule:error', { error: '预约不存在' });
      }
    } catch (error) {
      socket.emit('schedule:error', { error: error.message });
      console.error('[预约] 更新失败:', error);
    }
  });

  // 删除预约
  socket.on('schedule:delete', (data) => {
    try {
      const schedule = scheduleManager.getSchedule(data.id);
      const success = scheduleManager.deleteSchedule(data.id);
      if (success) {
        socket.emit('schedule:deleted', { id: data.id });
        if (schedule) {
          socket.emit('schedule:list', scheduleManager.getSessionSchedules(schedule.sessionId));
        }
        console.log(`[预约] 删除预约: ${data.id}`);
      } else {
        socket.emit('schedule:error', { error: '预约不存在' });
      }
    } catch (error) {
      socket.emit('schedule:error', { error: error.message });
      console.error('[预约] 删除失败:', error);
    }
  });

  // 启用/禁用预约
  socket.on('schedule:toggle', (data) => {
    try {
      const schedule = scheduleManager.toggleSchedule(data.id, data.enabled);
      if (schedule) {
        socket.emit('schedule:updated', schedule);
        socket.emit('schedule:list', scheduleManager.getSessionSchedules(schedule.sessionId));
        console.log(`[预约] ${data.enabled ? '启用' : '禁用'}预约: ${data.id}`);
      } else {
        socket.emit('schedule:error', { error: '预约不存在' });
      }
    } catch (error) {
      socket.emit('schedule:error', { error: error.message });
      console.error('[预约] 切换状态失败:', error);
    }
  });

  // 用户确认修复 Claude Code 会话错误
  socket.on('claude:confirmFix', async (data) => {
    const session = sessionManager.getSession(data.sessionId);
    if (!session) {
      socket.emit('claude:fixResult', { success: false, error: '会话不存在' });
      return;
    }

    // 检查是否有待修复的建议
    if (!session.pendingFixSuggestion || !session.pendingFixContext) {
      socket.emit('claude:fixResult', { success: false, error: '没有待修复的错误' });
      return;
    }

    const ctx = session.pendingFixContext;
    console.log(`[错误修复] 会话 ${session.name}: 用户确认修复，开始执行...`);

    // 清除待修复标记
    session.pendingFixSuggestion = false;

    // 开始修复流程
    session.isFixingClaudeError = true;
    session.fixingStep = 1;
    session.fixContext = {
      workingDir: ctx.workingDir,
      tmuxSession: ctx.tmuxSession,
      startTime: Date.now()
    };

    // 步骤1: 发送 /quit 退出 Claude Code
    console.log(`[错误修复] 会话 ${session.name}: 步骤1 - 发送 /quit 退出 Claude Code`);
    try {
      execSync(`${getTmuxPrefix()} send-keys -t "${ctx.tmuxSession}" "/quit"`);
      setTimeout(() => {
        try {
          execSync(`${getTmuxPrefix()} send-keys -t "${ctx.tmuxSession}" Enter`);
        } catch (e) {
          session.write('\r');
        }
      }, 100);
    } catch (e) {
      session.write('/quit');
      setTimeout(() => session.write('\r'), 100);
    }

    historyLogger.log(session.id, {
      type: 'system',
      content: `用户确认修复，正在执行... (步骤1: 退出 Claude Code)`
    });

    // 通知前端修复已开始
    io.to(`session:${session.id}`).emit('claude:fixStarted', {
      sessionId: session.id,
      message: '正在修复...'
    });

    socket.emit('claude:fixResult', { success: true, message: '修复已开始' });
  });

  // 用户取消修复建议
  socket.on('claude:dismissFix', (data) => {
    const session = sessionManager.getSession(data.sessionId);
    if (session) {
      session.pendingFixSuggestion = false;
      session.pendingFixContext = null;
      session.lastClaudeFixTime = Date.now(); // 设置冷却时间，避免重复提示

      console.log(`[错误修复] 会话 ${session.name}: 用户取消修复建议`);

      historyLogger.log(session.id, {
        type: 'system',
        content: `用户取消了修复建议`
      });

      io.to(`session:${session.id}`).emit('claude:fixDismissed', {
        sessionId: session.id
      });
    }
  });

  // 加载 AI 设置
  socket.on('settings:load', () => {
    const settings = aiEngine.getSettings();
    socket.emit('settings:loaded', settings);
  });

  // 保存 AI 设置
  socket.on('settings:save', (settings) => {
    const success = aiEngine.saveSettings(settings);
    if (success) {
      // 重新加载配置（根据新的 _providerId 从 CC Switch 获取供应商配置）
      aiEngine.reloadSettings();
      const newSettings = aiEngine.getSettings();
      socket.emit('settings:loaded', newSettings);
      console.log(`[AI设置] 配置已保存并重新加载，供应商: ${newSettings._currentProvider?.name || '未配置'}`);

      // 获取更新后的 AI 监控引擎供应商信息
      const providerInfo = getAIProviderInfo();

      // 广播供应商信息更新到所有会话（更新监控面板底部显示）
      const sessions = sessionManager.listSessions();
      sessions.forEach(session => {
        io.to(`session:${session.id}`).emit('ai:providerUpdated', {
          sessionId: session.id,
          ...providerInfo
        });
      });

      console.log(`[AI设置] 已通知所有会话更新 AI 监控引擎供应商: ${providerInfo.providerName}`);
    }
  });

  // 测试供应商连接
  socket.on('settings:testProvider', async (data) => {
    const { providerId, appType } = data;
    console.log(`[AI设置] 测试供应商: ${appType}:${providerId}`);

    try {
      // 从 CC Switch 数据库获取供应商配置
      const ccSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
      if (!existsSync(ccSwitchDbPath)) {
        socket.emit('settings:testResult', { success: false, message: 'CC Switch 数据库不存在' });
        return;
      }

      const db = new Database(ccSwitchDbPath, { readonly: true });
      const row = db.prepare(`
        SELECT id, name, app_type, settings_config
        FROM providers
        WHERE id = ? AND app_type = ?
      `).get(providerId, appType);
      db.close();

      if (!row) {
        socket.emit('settings:testResult', { success: false, message: '供应商不存在' });
        return;
      }

      // 解析配置
      const settingsConfig = JSON.parse(row.settings_config);
      let apiUrl = '';
      let apiKey = '';
      let model = '';
      let providerApiType = 'claude';

      if (appType === 'codex') {
        // Codex 使用 auth.OPENAI_API_KEY 和 TOML 格式的 config
        apiKey = settingsConfig.auth?.OPENAI_API_KEY || settingsConfig.auth?.CODEX_API_KEY || '';
        // 从 TOML config 中提取 base_url 和 model
        if (settingsConfig.config) {
          const baseUrlMatch = settingsConfig.config.match(/base_url\s*=\s*"([^"]+)"/);
          if (baseUrlMatch) {
            apiUrl = baseUrlMatch[1];
          }
          const modelMatch = settingsConfig.config.match(/^model\s*=\s*"([^"]+)"/m);
          if (modelMatch) {
            model = modelMatch[1];
          }
        }
        // 规范化 API URL：确保以 /responses 结尾
        if (apiUrl && !apiUrl.endsWith('/responses')) {
          apiUrl = apiUrl.replace(/\/+$/, '');
          apiUrl = `${apiUrl}/responses`;
        }
        providerApiType = 'codex';
      } else {
        // Claude 使用 env.ANTHROPIC_BASE_URL 和 ANTHROPIC_AUTH_TOKEN
        const env = settingsConfig.env || {};
        apiUrl = env.ANTHROPIC_BASE_URL || '';
        apiKey = env.ANTHROPIC_AUTH_TOKEN || '';
        // 规范化 API URL：确保以 /v1/messages 结尾
        if (apiUrl && !apiUrl.endsWith('/v1/messages')) {
          apiUrl = apiUrl.replace(/\/+$/, '');
          apiUrl = `${apiUrl}/v1/messages`;
        }
        providerApiType = 'claude';
      }

      // 构造供应商配置对象（符合 ProviderHealthCheck 的格式）
      const provider = {
        id: row.id,
        name: row.name,
        settingsConfig: providerApiType === 'codex' ? {
          codex: {
            apiUrl: apiUrl,
            apiKey: apiKey,
            model: model || 'gpt-5-codex'
          }
        } : {
          claude: {
            apiUrl: apiUrl,
            apiKey: apiKey
          }
        }
      };

      // 执行健康检查
      const result = await healthCheckScheduler.healthCheck.checkOnce(appType, provider);

      socket.emit('settings:testResult', {
        success: result.success,
        message: result.success ? `连接成功 (${result.responseTimeMs}ms)` : result.message,
        responseTimeMs: result.responseTimeMs,
        status: result.status
      });
    } catch (err) {
      console.error('[AI设置] 测试供应商失败:', err);
      socket.emit('settings:testResult', { success: false, message: err.message });
    }
  });

  // 请求 AI 状态分析（优先返回缓存结果）
  socket.on('ai:requestStatus', async (data) => {
    const session = sessionManager.getSession(data.sessionId);
    if (!session) return;

    // 优先返回缓存的结果（后台分析已经在运行）
    const cachedStatus = aiStatusCache.get(data.sessionId);
    if (cachedStatus) {
      console.log(`[AI] 返回缓存的状态分析结果`);
      io.to(`session:${data.sessionId}`).emit('ai:status', {
        sessionId: data.sessionId,
        ...cachedStatus,
        ...getAIProviderInfo()
      });
      return;
    }

    // 如果没有缓存，立即分析一次
    io.to(`session:${data.sessionId}`).emit('ai:statusLoading', { sessionId: data.sessionId });

    try {
      const terminalContent = session.getScreenContent();
      console.log(`[AI] 请求状态分析，终端内容长度: ${terminalContent.length}`);

      const status = await aiEngine.analyzeStatus(terminalContent, session.aiType || 'claude', data.sessionId);

      if (status) {
        console.log(`[AI] 状态分析成功:`, status);

        // 如果检测到 CLI 工具运行，动态更新 session 的供应商信息
        if (status.detectedCLI && status.detectedCLI !== session.aiType) {
          console.log(`[AI] 检测到 CLI 工具切换: ${session.aiType} -> ${status.detectedCLI}`);
          session.aiType = status.detectedCLI;

          // 查询并更新供应商信息
          // 传递 workingDir 以正确检测本地配置
          const provider = await getCurrentProvider(status.detectedCLI, session.workingDir);
          if (status.detectedCLI === 'claude') {
            session.claudeProvider = provider;
          } else if (status.detectedCLI === 'codex') {
            session.codexProvider = provider;
          } else if (status.detectedCLI === 'gemini') {
            session.geminiProvider = provider;
          }

          // 通知前端更新 session 信息（包括供应商）
          io.emit('sessions:updated', sessionManager.listSessions());
          console.log(`[AI] 已更新 session 供应商: ${provider.name}`);
        }

        // 缓存结果
        aiStatusCache.set(data.sessionId, {
          ...status,
          updatedAt: new Date().toISOString()
        });
        io.to(`session:${data.sessionId}`).emit('ai:status', {
          sessionId: data.sessionId,
          ...status,
          ...getAIProviderInfo()
        });
      }
    } catch (err) {
      console.error('AI 状态分析失败:', err);
      io.to(`session:${data.sessionId}`).emit('ai:error', {
        sessionId: data.sessionId,
        error: err.message,
        stack: err.stack
      });
      io.to(`session:${data.sessionId}`).emit('ai:status', {
        sessionId: data.sessionId,
        currentState: '分析失败: ' + err.message,
        workingDir: '未知',
        recentAction: '无',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        ...getAIProviderInfo()
      });
    }
  });

  // 获取供应商列表
  socket.on('provider:list', (data) => {
    console.log('[Provider List] 收到请求:', data);
    const { appType } = data || { appType: 'claude' };
    const providerData = providerService.list(appType);
    console.log('[Provider List] providerData:', providerData);
    const providers = Object.values(providerData.providers || {}).map(p => ({
      id: p.id,
      name: p.name,
      isCurrent: p.id === providerData.current
    }));
    console.log('[Provider List] 发送供应商列表:', providers);
    socket.emit('provider:list', { appType, providers, current: providerData.current });
  });

  // 切换供应商
  socket.on('provider:switch', async (data) => {
    const { sessionId, appType, providerId } = data;
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      socket.emit('provider:switchError', { sessionId, error: '会话不存在' });
      return;
    }

    console.log(`[Provider Switch] 开始切换供应商: ${appType} -> ${providerId}`);

    // 启动切换状态机
    await switchProviderStateMachine(session, appType, providerId, socket);
  });

  // 获取系统信息
  socket.on('system:info', () => {
    socket.emit('system:info', {
      nodeVersion: process.version,
      platform: process.platform,
      configPath: path.join(os.homedir(), '.webtmux'),
      databasePath: path.join(os.homedir(), '.webtmux/db/webtmux.db')
    });
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log(`客户端断开: ${socket.id}`);
    if (socket.data.currentSessionId) {
      const session = sessionManager.getSession(socket.data.currentSessionId);
      if (session) {
        if (socket.data.outputCallback) {
          session.offOutput(socket.data.outputCallback);
        }
        session.detach();
      }
      socket.leave(`session:${socket.data.currentSessionId}`);
    }
  });

  // AI 分析处理
  async function handleAIAnalysis(sessionId, session, socket) {
    if (session.isAnalyzing || !session.goal) return;

    // 等待输出稳定
    clearTimeout(session.analysisTimer);
    session.analysisTimer = setTimeout(async () => {
      session.isAnalyzing = true;

      try {
        // 优先使用 analyzeStatus 的结果（专门针对 CLI 工具优化）
        // 使用 getScreenContent() 获取当前屏幕内容，与后台分析保持一致
        const terminalContent = session.getScreenContent();
        const statusResult = aiEngine.preAnalyzeStatus(terminalContent, session.aiType || 'claude', session.tmuxSessionName);

        if (statusResult) {
          if (statusResult.needsAction && statusResult.suggestedAction) {
            // 使用状态分析的结果作为建议
            io.to(`session:${sessionId}`).emit('ai:suggestion', {
              sessionId,
              command: statusResult.suggestedAction,
              reasoning: statusResult.actionReason || statusResult.currentState,
              isDangerous: false
            });
          } else {
            // 不需要操作时，清除旧的建议
            io.to(`session:${sessionId}`).emit('ai:executed');
          }
          // preAnalyzeStatus 已返回结果，不再调用 analyze()
          return;
        }

        // 只有当 preAnalyzeStatus 无法判断时，才使用基于目标的分析
        const history = historyLogger.getHistory(sessionId, 50);
        const suggestion = await aiEngine.analyze({
          goal: session.goal,
          systemPrompt: session.systemPrompt,
          history
        });

        if (suggestion) {
          if (suggestion.type === 'complete') {
            // 目标已完成
            io.to(`session:${sessionId}`).emit('ai:complete', {
              sessionId,
              summary: suggestion.summary
            });
            historyLogger.log(sessionId, {
              type: 'system',
              content: `目标完成: ${suggestion.summary}`
            });
          } else if (suggestion.type === 'need_input') {
            // 需要用户输入
            io.to(`session:${sessionId}`).emit('ai:needInput', {
              sessionId,
              question: suggestion.question
            });
          } else if (suggestion.type === 'command') {
            if (session.autoMode && !suggestion.isDangerous) {
              // 自动模式：直接执行
              session.write(suggestion.command + '\r');

              historyLogger.log(sessionId, {
                type: 'ai_decision',
                content: suggestion.command,
                aiGenerated: true,
                aiReasoning: suggestion.reasoning
              });

              io.to(`session:${sessionId}`).emit('ai:autoExecuted', {
                sessionId,
                command: suggestion.command,
                reasoning: suggestion.reasoning
              });
            } else {
              // 建议模式：发送建议
              io.to(`session:${sessionId}`).emit('ai:suggestion', {
                sessionId,
                command: suggestion.command,
                reasoning: suggestion.reasoning,
                isDangerous: suggestion.isDangerous
              });
            }
          }
        }
      } catch (err) {
        console.error('AI 分析错误:', err);
      } finally {
        session.isAnalyzing = false;
      }
    }, 1500); // 等待 1.5 秒输出稳定
  }
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, async () => {
  console.log(`WebTmux 服务器运行在 http://${HOST}:${PORT}`);

  // 注意：项目元数据（projectDesc、goal）的刷新已集成到 updateAllSessionsProjectInfo() 中
  // 该函数会在启动后 3 秒执行，并每 30 秒定期刷新

  // 启动定时健康检查调度器
  try {
    await healthCheckScheduler.start();
  } catch (err) {
    console.error('[Server] 启动健康检查调度器失败:', err);
  }

  // 启动预约调度器
  scheduleManager.onScheduleTrigger((schedule) => {
    console.log(`[预约] 触发预约: ${schedule.id}, 会话: ${schedule.sessionId}, 动作: ${schedule.action}`);

    const session = sessionManager.getSession(schedule.sessionId);
    if (session) {
      const enabled = schedule.action === 'enable';
      session.updateSettings({ autoActionEnabled: enabled });
      sessionManager.updateSession(session);

      io.to(`session:${schedule.sessionId}`).emit('session:updated', session.toJSON());
      io.emit('sessions:updated', sessionManager.listSessions());

      historyLogger.log(schedule.sessionId, {
        type: 'system',
        content: `预约触发: ${enabled ? '开启' : '关闭'}AI监控`
      });
    }
  });
  scheduleManager.startScheduler();

  // 启动隧道服务（优先 FRP 测速选择，回退到 Cloudflare）
  try {
    let tunnelUrl = null;

    // 优先使用 FRP：测试三台服务器，选最快可用的
    frpTunnel.init(io, PORT);
    const frpInstalled = await frpTunnel.checkInstalled();
    if (frpInstalled) {
      tunnelUrl = await frpTunnel.start();
    }

    // 如果 FRP 不可用，使用 Cloudflare Tunnel 作为备用
    if (!tunnelUrl) {
      console.log('[Server] FRP 隧道不可用，使用 Cloudflare Tunnel 备用');
      cloudflareTunnel.init(io, PORT);
      tunnelUrl = await cloudflareTunnel.start();
    }

    if (tunnelUrl) {
      console.log(`[Server] 外部访问地址: ${tunnelUrl}`);
    }

    // 启动 FRP 服务器定期健康检查（每60秒）
    frpTunnel.startHealthCheck(60000);

    // 启动隧道 URL 可用性检测（每30秒）
    frpTunnel.startTunnelCheck(30000);
  } catch (err) {
    console.error('[Server] 启动隧道服务失败:', err);
  }

  // 对所有恢复的 session 进行初始 CLI 工具检测和供应商信息补充
  // 使用并行处理加速启动
  console.log(`[启动检测] 开始检测 ${sessionManager.sessions.size} 个会话的 CLI 工具`);

  // 先同步注册 bell 回调和检测 CLI（这些是快速操作）
  for (const session of sessionManager.sessions.values()) {
    registerBellCallback(session);
    try {
      const terminalContent = session.getScreenContent();
      const detectedCLI = aiEngine.detectRunningCLI(terminalContent, session.tmuxSessionName);
      if (detectedCLI && detectedCLI !== session.aiType) {
        console.log(`[启动检测] Session ${session.name}: CLI 切换 ${session.aiType} -> ${detectedCLI}`);
        session.aiType = detectedCLI;
      }
    } catch (err) {
      console.error(`[启动检测] Session ${session.name} CLI检测失败:`, err.message);
    }
  }

  // 异步并行获取供应商信息（不阻塞启动）
  (async () => {
    const tasks = Array.from(sessionManager.sessions.values()).map(async (session) => {
      try {
        let needsUpdate = false;

        if (!session.claudeProvider) {
          const claudeProvider = await getCurrentProvider('claude', session.workingDir);
          if (claudeProvider.exists) {
            session.claudeProvider = claudeProvider;
            needsUpdate = true;
          }
        }

        if (!session.codexProvider) {
          const codexProvider = await getCurrentProvider('codex');
          if (codexProvider.exists) {
            session.codexProvider = codexProvider;
            needsUpdate = true;
          }
        }

        if (needsUpdate) {
          sessionManager.updateSession(session);
        }
      } catch (err) {
        console.error(`[启动检测] Session ${session.name} 供应商获取失败:`, err.message);
      }
    });

    await Promise.all(tasks);
    console.log(`[启动检测] 供应商信息补充完成`);
    // 通知前端更新会话列表
    io.emit('sessions:updated', sessionManager.listSessions());
  })();

  console.log(`[启动检测] 完成（供应商信息后台加载中）`);

  // 监听全局 Claude 配置文件变化，自动刷新所有会话的供应商信息
  const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let configWatchDebounce = null;

  const refreshAllProviders = async () => {
    console.log('[配置监听] 检测到全局配置变化，刷新所有会话的供应商信息');
    const sessions = Array.from(sessionManager.sessions.values());

    for (const session of sessions) {
      try {
        const claudeProvider = await getCurrentProvider('claude', session.workingDir);
        if (claudeProvider.exists) {
          session.claudeProvider = claudeProvider;
          sessionManager.updateSession(session);
        }
      } catch (err) {
        console.error(`[配置监听] 刷新会话 ${session.name} 供应商失败:`, err.message);
      }
    }

    io.emit('sessions:updated', sessionManager.listSessions());
    console.log(`[配置监听] 已刷新 ${sessions.length} 个会话的供应商信息`);
  };

  if (existsSync(claudeSettingsPath)) {
    try {
      watch(claudeSettingsPath, (eventType) => {
        if (eventType === 'change') {
          // 防抖：500ms 内多次变化只触发一次刷新
          if (configWatchDebounce) {
            clearTimeout(configWatchDebounce);
          }
          configWatchDebounce = setTimeout(refreshAllProviders, 500);
        }
      });
      console.log(`[配置监听] 已启动全局配置文件监听: ${claudeSettingsPath}`);
    } catch (err) {
      console.error('[配置监听] 启动文件监听失败:', err.message);
    }
  } else {
    console.log('[配置监听] 全局配置文件不存在，跳过监听');
  }
});
