import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ProxyAgent, Agent } from 'undici';
import Database from 'better-sqlite3';
import ProviderService from './ProviderService.js';
import ConfigService from './ConfigService.js';
import { DEFAULT_MODEL, CLAUDE_CODE_FAKE, CODEX_FAKE } from '../config/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SETTINGS_PATH = join(__dirname, '../db/ai-settings.json');
const CC_SWITCH_DB_PATH = join(os.homedir(), '.cc-switch', 'cc-switch.db');

// 创建 ProviderService 实例（不传 io，AIEngine 不需要推送事件）
const providerService = new ProviderService();

// 创建 ConfigService 实例
const configService = new ConfigService();

// 生成 Claude Code 格式的 user_id
function generateClaudeCodeUserId() {
  const hash = crypto.randomBytes(32).toString('hex');
  const sessionId = crypto.randomUUID();
  return `user_${hash}_account__session_${sessionId}`;
}

// 不使用代理，直连 API
const proxyAgent = null;

// 创建忽略 SSL 验证的 Agent（用于某些自签名证书的 API）
const insecureAgent = new Agent({
  connect: {
    rejectUnauthorized: false
  }
});

console.log('[AIEngine] 不使用代理，直连 API');

const DANGEROUS_PATTERNS = [
  /^rm\s+(-rf?|--recursive)/,
  /^sudo\s+/,
  /^chmod\s+777/,
  /^dd\s+/,
  />\s*\/dev\//,
  /^reboot|shutdown|halt/,
  /^kill\s+-9/,
  /^mkfs/,
  /^:(){ :|:& };:/,
  /^mv\s+.*\s+\/dev\/null/,
];

const DEFAULT_SYSTEM_PROMPT = `你是一个终端助手，帮助用户在命令行中完成任务。

规则：
1. 分析终端输出，理解当前状态
2. 根据用户目标，建议下一步命令
3. 每次只建议一条命令
4. 如果目标已完成，返回 JSON: {"action": "complete", "summary": "完成总结"}
5. 如果遇到错误，建议修复方法
6. 如果需要用户输入（如密码），返回 JSON: {"action": "need_input", "question": "问题"}
7. 如果需要执行命令，返回 JSON: {"action": "command", "command": "命令", "reasoning": "理由"}

危险命令（如 rm -rf、sudo）需要特别说明风险。

你必须以 JSON 格式回复，不要包含其他内容。`;

const DEFAULT_STATUS_PROMPT = `你是终端状态分析器。分析终端内容，返回 JSON。

重要：你必须且只能返回一个 JSON 对象，不要任何其他文字、解释或 markdown 格式。

JSON 格式：
{"currentState":"终端当前状态描述","workingDir":"工作目录路径","recentAction":"最近执行的命令","suggestion":"建议（可选，无则为null）"}

示例输出：
{"currentState":"用户在家目录执行了ls命令，终端空闲等待输入","workingDir":"~","recentAction":"ls","suggestion":null}`;

export class AIEngine {
  constructor() {
    this.settings = this._loadSettings();
    this.failoverConfig = null;
    this._loadFailoverConfig();
  }

  async _loadFailoverConfig() {
    try {
      await configService.loadConfig();
      this.failoverConfig = configService.getFailoverConfig();
    } catch (err) {
      console.error('[AIEngine] 加载故障转移配置失败:', err);
      this.failoverConfig = { enabled: false };
    }
  }

  _loadSettings() {
    // 1. 先读取 ai-settings.json 获取用户选择的供应商 ID
    let savedSettings = null;
    let savedProviderId = null;
    try {
      if (fs.existsSync(SETTINGS_PATH)) {
        savedSettings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
        // _providerId 格式: "appType:id"，如 "claude:xxx-xxx"
        savedProviderId = savedSettings._providerId;
      }
    } catch (err) {
      console.error('[AIEngine] 读取 ai-settings.json 失败:', err);
    }

    // 2. 如果有保存的供应商 ID，从 CC Switch 数据库获取该供应商配置
    if (savedProviderId && fs.existsSync(CC_SWITCH_DB_PATH)) {
      try {
        const [appType, providerId] = savedProviderId.split(':');
        if (appType && providerId) {
          const db = new Database(CC_SWITCH_DB_PATH, { readonly: true });
          const row = db.prepare(`
            SELECT id, name, app_type, settings_config, website_url
            FROM providers
            WHERE id = ? AND app_type = ?
            LIMIT 1
          `).get(providerId, appType);
          db.close();

          if (row && row.settings_config) {
            const result = this._parseProviderConfig(row);
            if (result) {
              console.log(`[AIEngine] 使用已保存的供应商: ${row.name}`);
              // 保留 _providerId 和 _providerName，供前端使用
              result._providerId = savedProviderId;
              result._providerName = savedSettings?._providerName || `${row.name} (${appType})`;
              // 保留 ai-settings.json 中的其他设置（如 tunnelUrl）
              if (savedSettings?.tunnelUrl) {
                result.tunnelUrl = savedSettings.tunnelUrl;
              }
              return result;
            }
          }
        }
      } catch (err) {
        console.error('[AIEngine] 从 CC Switch 加载已保存供应商失败:', err);
      }
    }

    // 3. 回退：使用 ai-settings.json 中的直接配置（旧格式）
    if (savedSettings && savedSettings.claude?.apiUrl) {
      console.log('[AIEngine] 使用 ai-settings.json 直接配置');
      return savedSettings;
    }

    // 4. 无配置时返回空配置
    console.warn('[AIEngine] 未找到 AI 监控供应商配置，请在设置中选择供应商');
    return {
      apiType: 'claude',
      openai: { apiUrl: '', apiKey: '', model: DEFAULT_MODEL },
      claude: { apiUrl: '', apiKey: '', model: DEFAULT_MODEL },
      maxTokens: 500,
      temperature: 0.7,
      _noProvider: true
    };
  }

  // 解析 CC Switch 供应商配置
  _parseProviderConfig(row) {
    try {
      const settingsConfig = JSON.parse(row.settings_config);
      const appType = row.app_type;

      // 记录当前供应商信息
      this._currentProvider = {
        id: row.id,
        name: row.name,
        appType: appType
      };

      // 根据 app_type 解析不同格式的配置
      if (appType === 'codex') {
        // Codex 使用 auth.OPENAI_API_KEY 和 TOML 格式的 config
        const apiKey = settingsConfig.auth?.OPENAI_API_KEY || settingsConfig.auth?.CODEX_API_KEY || '';
        let apiUrl = '';
        let model = '';

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

        if (!apiUrl || !apiKey) {
          return null;
        }

        // 规范化 API URL：确保以 /responses 结尾
        if (!apiUrl.endsWith('/responses')) {
          apiUrl = apiUrl.replace(/\/+$/, '');
          apiUrl = `${apiUrl}/responses`;
        }

        return {
          apiType: 'codex',
          codex: {
            apiUrl: apiUrl,
            apiKey: apiKey,
            model: model || 'gpt-5-codex'
          },
          openai: { apiUrl: '', apiKey: '', model: 'gpt-4o' },
          claude: { apiUrl: '', apiKey: '', model: DEFAULT_MODEL },
          maxTokens: 500,
          temperature: 0.7,
          _currentProvider: this._currentProvider
        };
      } else {
        // Claude 使用 env.ANTHROPIC_BASE_URL 和 ANTHROPIC_AUTH_TOKEN
        const env = settingsConfig.env || {};
        let apiUrl = env.ANTHROPIC_BASE_URL || '';
        const apiKey = env.ANTHROPIC_AUTH_TOKEN || '';

        if (!apiUrl || !apiKey) {
          return null;
        }

        // 规范化 API URL：确保以 /v1/messages 结尾
        if (!apiUrl.endsWith('/v1/messages')) {
          apiUrl = apiUrl.replace(/\/+$/, '');
          apiUrl = `${apiUrl}/v1/messages`;
        }

        return {
          apiType: 'claude',
          openai: { apiUrl: '', apiKey: '', model: DEFAULT_MODEL },
          claude: {
            apiUrl: apiUrl,
            apiKey: apiKey,
            model: DEFAULT_MODEL
          },
          maxTokens: 500,
          temperature: 0.7,
          _currentProvider: this._currentProvider
        };
      }
    } catch (err) {
      console.error('[AIEngine] 解析供应商配置失败:', err);
      return null;
    }
  }

  /**
   * 重新加载配置（供应商切换后调用）
   */
  reloadSettings() {
    this.settings = this._loadSettings();
    return this.settings;
  }

  /**
   * 获取当前供应商信息
   */
  getCurrentProviderInfo() {
    return this.settings._currentProvider || null;
  }

  getSettings() {
    return this.settings;
  }

  saveSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    try {
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(this.settings, null, 2));
      return true;
    } catch (err) {
      console.error('保存 AI 设置失败:', err);
      return false;
    }
  }

  // 通用 API 调用方法，根据 apiType 选择不同格式
  async _callApi(prompt) {
    const apiType = this.settings.apiType || 'openai';

    if (apiType === 'claude') {
      const config = this.settings.claude || this.settings.openai;
      return this._callClaudeApi(prompt, config);
    } else if (apiType === 'codex') {
      // Codex 使用 OpenAI Responses API 格式
      const config = this.settings.codex || this.settings.openai;
      return this._callCodexApi(prompt, config);
    } else {
      const config = this.settings.openai;
      return this._callOpenAiApi(prompt, config);
    }
  }

  /**
   * 带故障转移的 API 调用
   * 当前供应商失败时，自动切换到下一个可用供应商
   */
  async _callApiWithFailover(prompt) {
    // 如果未启用故障转移，直接调用
    if (!this.failoverConfig || !this.failoverConfig.enabled) {
      return this._callApi(prompt);
    }

    const maxRetries = this.failoverConfig.maxRetries || 3;
    const retryDelay = this.failoverConfig.retryDelayMs || 5000;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // 尝试调用当前供应商
        const result = await this._callApi(prompt);

        // 如果成功且不是第一次尝试，说明发生了故障转移
        if (attempt > 0) {
          const currentProvider = this.getCurrentProviderInfo();
          console.log(`[AIEngine] 故障转移成功，切换到供应商: ${currentProvider?.name || 'unknown'}`);
        }

        return result;
      } catch (error) {
        lastError = error;
        console.error(`[AIEngine] API 调用失败 (尝试 ${attempt + 1}/${maxRetries}):`, error.message);

        // 如果还有重试机会，尝试切换供应商
        if (attempt < maxRetries - 1) {
          const switched = await this._switchToNextProvider();

          if (!switched) {
            console.error('[AIEngine] 无法切换到下一个供应商，故障转移失败');
            break;
          }

          // 等待一段时间后重试
          if (retryDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          }
        }
      }
    }

    // 所有尝试都失败
    throw new Error(`故障转移失败，已尝试 ${maxRetries} 次: ${lastError?.message || '未知错误'}`);
  }

  /**
   * 切换到下一个可用供应商
   * @returns {boolean} 是否成功切换
   */
  async _switchToNextProvider() {
    try {
      // 获取所有供应商，按 sortIndex 排序
      const data = providerService.list('claude');
      const providers = Object.values(data.providers).sort((a, b) => a.sortIndex - b.sortIndex);

      if (providers.length === 0) {
        console.error('[AIEngine] 没有可用的供应商');
        return false;
      }

      // 获取当前供应商
      const currentId = data.current;
      const currentIndex = providers.findIndex(p => p.id === currentId);

      // 找到下一个供应商（循环）
      let nextProvider = null;
      for (let i = 1; i <= providers.length; i++) {
        const nextIndex = (currentIndex + i) % providers.length;
        const candidate = providers[nextIndex];

        // 跳过当前供应商
        if (candidate.id === currentId) {
          continue;
        }

        nextProvider = candidate;
        break;
      }

      if (!nextProvider) {
        console.error('[AIEngine] 没有其他可用的供应商');
        return false;
      }

      // 切换供应商
      console.log(`[AIEngine] 尝试切换到供应商: ${nextProvider.name}`);
      const result = await providerService.switch('claude', nextProvider.id);

      if (result.success) {
        // 重新加载配置
        this.reloadSettings();
        console.log(`[AIEngine] 成功切换到供应商: ${nextProvider.name}`);
        return true;
      } else {
        console.error(`[AIEngine] 切换供应商失败: ${result.error}`);
        return false;
      }
    } catch (error) {
      console.error('[AIEngine] 切换供应商时发生错误:', error);
      return false;
    }
  }

  // OpenAI 兼容 API 调用
  async _callOpenAiApi(prompt, config) {
    if (!config.apiUrl || !config.apiKey) {
      throw new Error('OpenAI API 未配置，请先在 ccswitch 中添加供应商');
    }

    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model || DEFAULT_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false
      })
    };

    // 设置 dispatcher：优先使用代理，否则使用忽略 SSL 验证的 Agent
    fetchOptions.dispatcher = proxyAgent || insecureAgent;

    const response = await fetch(config.apiUrl, fetchOptions);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API 请求失败: ${response.status} ${error}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  }

  // Claude 原生 API 调用（带 Claude Code 伪装）
  async _callClaudeApi(prompt, config) {
    if (!config.apiUrl || !config.apiKey) {
      throw new Error('Claude API 未配置，请先在 ccswitch 中添加供应商');
    }

    // Claude 列表里的服务器统一使用伪装模式
    console.log('[AIEngine] 使用 Claude Code 伪装模式');

    // 构建请求头（伪装 Claude Code）
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': CLAUDE_CODE_FAKE.userAgent,
      'x-app': CLAUDE_CODE_FAKE.headers['x-app'],
      'anthropic-beta': CLAUDE_CODE_FAKE.headers['anthropic-beta'],
      'anthropic-version': CLAUDE_CODE_FAKE.headers['anthropic-version'],
      'Authorization': `Bearer ${config.apiKey}`
    };

    // 构建请求体（伪装 Claude Code）
    const requestBody = {
      model: config.model || DEFAULT_MODEL,
      max_tokens: this.settings.maxTokens || 500,
      messages: [{ role: 'user', content: prompt }],
      system: [{ type: 'text', text: CLAUDE_CODE_FAKE.systemPrompt }],
      metadata: { user_id: generateClaudeCodeUserId() }
    };

    const fetchOptions = {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    };

    // 设置 dispatcher：优先使用代理，否则使用忽略 SSL 验证的 Agent
    fetchOptions.dispatcher = proxyAgent || insecureAgent;

    const response = await fetch(config.apiUrl, fetchOptions);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Claude API 请求失败: ${response.status} ${error}`);
    }

    const data = await response.json();
    return data.content?.[0]?.text || null;
  }

  // Codex API 调用（带 Codex CLI 伪装，使用 OpenAI Responses API 格式）
  async _callCodexApi(prompt, config) {
    if (!config.apiUrl || !config.apiKey) {
      throw new Error('Codex API 未配置，请先在 ccswitch 中添加供应商');
    }

    console.log('[AIEngine] 使用 Codex CLI 伪装模式');

    // 构建请求头（伪装 Codex CLI）
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': CODEX_FAKE.userAgent,
      'openai-beta': CODEX_FAKE.headers['openai-beta'],
      'Authorization': `Bearer ${config.apiKey}`
    };

    // 构建请求体（OpenAI Responses API 格式）
    // 注意：不使用 instructions 字段，因为某些 Codex 中继服务不支持
    const requestBody = {
      model: config.model || 'gpt-5-codex',
      input: prompt,
      stream: false
    };

    const fetchOptions = {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    };

    // 设置 dispatcher
    fetchOptions.dispatcher = proxyAgent || insecureAgent;

    const response = await fetch(config.apiUrl, fetchOptions);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Codex API 请求失败: ${response.status} ${error}`);
    }

    // 处理响应（可能是 SSE 流式或 JSON）
    const contentType = response.headers.get('content-type') || '';
    const responseText = await response.text();

    // 如果是 SSE 流式响应，解析事件流
    if (contentType.includes('text/event-stream') || responseText.startsWith('event:')) {
      return this._parseCodexSSE(responseText);
    }

    // 尝试解析为 JSON
    try {
      const data = JSON.parse(responseText);
      // Responses API 返回格式：{ output: [{ type: 'message', content: [...] }] }
      const output = data.output || [];
      for (const item of output) {
        if (item.type === 'message' && item.content) {
          for (const content of item.content) {
            if (content.type === 'output_text') {
              return content.text;
            }
          }
        }
      }
      // 回退：尝试其他可能的响应格式
      return data.choices?.[0]?.message?.content || data.text || null;
    } catch (e) {
      console.error('[AIEngine] Codex 响应解析失败:', e);
      return null;
    }
  }

  // 解析 Codex SSE 流式响应
  _parseCodexSSE(sseText) {
    let result = '';
    const lines = sseText.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const jsonStr = line.slice(6);
          const data = JSON.parse(jsonStr);

          // 处理 response.completed 事件
          if (data.type === 'response.completed' && data.response?.output) {
            for (const item of data.response.output) {
              if (item.type === 'message' && item.content) {
                for (const content of item.content) {
                  if (content.type === 'output_text') {
                    result += content.text;
                  }
                }
              }
            }
          }

          // 处理增量文本事件
          if (data.type === 'response.output_text.delta' && data.delta) {
            result += data.delta;
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }

    return result || null;
  }

  async analyze({ goal, systemPrompt, history }) {
    if (!goal) return null;

    const recentHistory = history.slice(-30);
    const historyText = recentHistory
      .map(h => {
        if (h.type === 'input') return `$ ${h.content}`;
        if (h.type === 'output') return h.content;
        if (h.type === 'ai_decision') return `[AI执行] ${h.content}`;
        return `[${h.type}] ${h.content}`;
      })
      .join('\n');

    const basePrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const prompt = `${basePrompt}

目标: ${goal}

终端历史记录:
\`\`\`
${historyText || '(空)'}
\`\`\`

分析当前状态，只返回 JSON：`;

    try {
      const content = await this._callApiWithFailover(prompt);

      if (!content) {
        return null;
      }

      // 解析 JSON 响应
      const result = this._parseResponse(content);
      return result;
    } catch (err) {
      console.error('AI 分析错误:', err);
      throw err;
    }
  }

  _parseResponse(content) {
    try {
      // 尝试提取 JSON
      let jsonStr = content;
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      } else {
        // 尝试找到第一个完整的 JSON 对象（使用括号匹配算法）
        const startIdx = content.indexOf('{');
        if (startIdx !== -1) {
          let braceCount = 0;
          let endIdx = -1;
          for (let i = startIdx; i < content.length; i++) {
            if (content[i] === '{') braceCount++;
            else if (content[i] === '}') {
              braceCount--;
              if (braceCount === 0) {
                endIdx = i;
                break;
              }
            }
          }
          if (endIdx !== -1) {
            jsonStr = content.slice(startIdx, endIdx + 1);
          }
        }
      }

      const parsed = JSON.parse(jsonStr);

      if (parsed.action === 'complete') {
        return {
          type: 'complete',
          summary: parsed.summary
        };
      } else if (parsed.action === 'need_input') {
        return {
          type: 'need_input',
          question: parsed.question
        };
      } else if (parsed.action === 'command') {
        const isDangerous = this._isDangerous(parsed.command);
        return {
          type: 'command',
          command: parsed.command,
          reasoning: parsed.reasoning,
          isDangerous
        };
      }

      return null;
    } catch (err) {
      console.error('解析 AI 响应失败:', err, content);
      return null;
    }
  }

  _isDangerous(command) {
    return DANGEROUS_PATTERNS.some(pattern => pattern.test(command));
  }

  /**
   * 检测终端中运行的 CLI 工具类型
   * 返回 'claude' | 'codex' | 'gemini' | null
   */
  detectRunningCLI(terminalContent) {
    if (!terminalContent) return null;

    // 检测 Claude Code 特征（必须在 Codex 之前检测）
    // - ">" 提示符（Claude Code 的主提示符）
    // - "esc to interrupt" （运行中的提示）
    // - "Clauding…" / "Thinking…" / "Hatching…" （Claude Code 运行中的状态）
    // - "accept edits" （Claude Code 状态栏）
    // - "Do you want to make/run" （确认界面）
    // - Claude Code 特有的输出格式
    if (/>\s*$/.test(terminalContent) ||
        /esc to interrupt/i.test(terminalContent) ||
        /Clauding|Thinking|Hatching/i.test(terminalContent) ||
        /accept edits/i.test(terminalContent) ||
        /Do you want to (make this edit|create|delete|run)/i.test(terminalContent) ||
        /Claude Code|claude-cli/i.test(terminalContent)) {
      return 'claude';
    }

    // 检测 Codex CLI 特征
    // - Codex 特有的提示符或输出（排除会话名称中的 "Codex"）
    if (/codex-cli|openai.*codex/i.test(terminalContent)) {
      return 'codex';
    }

    // 检测 Gemini CLI 特征
    if (/gemini|gemini-cli/i.test(terminalContent)) {
      return 'gemini';
    }

    return null;
  }

  /**
   * 预判断终端状态，避免不必要的AI调用
   * 返回null表示需要AI分析，返回对象表示已判断出结果
   */
  preAnalyzeStatus(terminalContent) {
    if (!terminalContent || terminalContent.trim().length === 0) {
      return {
        currentState: '终端内容为空',
        workingDir: '未知',
        recentAction: '无',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: null,
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI: null
      };
    }

    // 检测运行的 CLI 工具
    const detectedCLI = this.detectRunningCLI(terminalContent);

    // 1. 检测Claude Code确认界面（需要选择"2"）- 最高优先级
    // 先清理 ANSI 转义序列，确保正则能正确匹配
    const cleanContent = terminalContent.replace(/\x1b\[[0-9;]*m/g, '');

    // 检测编辑/创建/删除/运行确认界面
    const isEditConfirm = /Do you want to (make this edit|create|delete|run)/i.test(cleanContent);
    const hasOption1Yes = /1\.\s*Yes/i.test(cleanContent);
    const hasOption2Yes = /2\.\s*Yes/i.test(cleanContent);

    if (isEditConfirm && hasOption1Yes && hasOption2Yes) {
      console.log('[AIEngine] 检测到 Claude Code 确认界面，选择选项 2');
      return {
        currentState: 'Claude Code确认界面',
        workingDir: '未显示',
        recentAction: '等待确认',
        needsAction: true,
        actionType: 'select',
        suggestedAction: '2',
        actionReason: '选择"允许本次会话"以自动化流程',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 2. 检测普通确认界面（Do you want to proceed?）
    // 如果有选项 2，选择 2（允许本次会话不再询问）；否则选择 1
    if (/Do you want to proceed\?/i.test(cleanContent) &&
        /1\.\s*Yes/i.test(cleanContent)) {
      const hasOption2 = /2\.\s*Yes/i.test(cleanContent);
      console.log(`[AIEngine] 检测到普通确认界面，选择选项 ${hasOption2 ? '2' : '1'}`);
      return {
        currentState: '确认界面',
        workingDir: '未显示',
        recentAction: '等待确认',
        needsAction: true,
        actionType: 'select',
        suggestedAction: hasOption2 ? '2' : '1',
        actionReason: hasOption2 ? '选择"允许本次会话"以自动化流程' : '选择"Yes"继续执行',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 2.5 检测程序运行中（必须在 accept edits 之前检测）
    // 当显示运行时间（如 1h 8m 37s）或 "esc to interrupt" 时，说明程序正在运行
    // 此时底部的 "accept edits on" 只是状态栏，不需要操作
    // 注意：使用清理后的内容进行检测
    const isRunning = /\d+[msh]\s+\d+[msh]/.test(cleanContent) ||
                      (/esc to interrupt/i.test(cleanContent) && /\d+[ms]\s/.test(cleanContent));
    if (isRunning) {
      return {
        currentState: '程序运行中',
        workingDir: '未显示',
        recentAction: '执行中',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: '程序正在运行，不应打断',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 2.6 检测 Claude Code 空闲状态下的中文问句
    // 检查最后 800 字符中是否有问句（增加范围以确保捕获问句）
    const last800Chars = terminalContent.slice(-800);
    // 去除 ANSI 转义序列后再匹配（终端内容可能包含颜色代码）
    const cleanLast800 = last800Chars.replace(/\x1b\[[0-9;]*m/g, '');
    // 检测 > 提示符（可能带有空格或光标）
    const hasInputPrompt = /^>\s*$/m.test(cleanLast800) || />\s*\|/.test(cleanLast800);

    if (hasInputPrompt) {
      // 检测"是否继续"类问题 - 应该自动回答"继续"
      const isContinueQuestion = /是否继续.{0,20}[？?]/i.test(cleanLast800);
      if (isContinueQuestion) {
        console.log('[AIEngine] 检测到"是否继续"问题，自动回答继续');
        return {
          currentState: 'Claude Code询问是否继续',
          workingDir: '未显示',
          recentAction: '显示问题',
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续',
          actionReason: '自动回答继续以保持工作流程',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI
        };
      }

      // 检测需要用户手动输入的问题（如"请输入..."、"请选择..."）
      const needsUserInput = /请.{0,15}(输入|选择|确认|填写)/i.test(cleanLast800);
      if (needsUserInput) {
        console.log('[AIEngine] 检测到需要用户输入的提示，不自动操作');
        return {
          currentState: '等待用户输入',
          workingDir: '未显示',
          recentAction: '显示问题',
          needsAction: false,
          actionType: 'none',
          suggestedAction: null,
          actionReason: '等待用户回答问题，不自动操作',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI
        };
      }

      // 检测开发阶段空闲状态 - 有 > 提示符，刚完成操作，应该发送"继续"
      // 检查最近内容是否涉及开发工作（代码、文件、翻译等）
      const isDevelopmentContext = /(添加|创建|修改|删除|实现|完成|翻译|编写|更新|修复|重构|优化|\.ts|\.js|\.tsx|\.jsx|\.py|\.java|\.cpp|\.c|\.h|function|class|const|let|var|import|export)/i.test(cleanLast800);
      if (isDevelopmentContext) {
        console.log('[AIEngine] 检测到开发阶段空闲状态，自动发送继续');
        return {
          currentState: 'Claude Code空闲',
          workingDir: '未显示',
          recentAction: '等待输入',
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续',
          actionReason: '开发阶段空闲，自动继续',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI
        };
      }
    }

    // 注意：底部状态栏的 "accept edits on" 只是提示，不需要任何操作
    // Claude Code 不会有需要按 Tab 接受编辑的界面，编辑确认使用的是选项菜单（1/2/3）

    // 3. 检测其他程序运行中的情况
    if (/ctrl\+c to cancel/i.test(terminalContent)) {
      return {
        currentState: '程序运行中',
        workingDir: '未显示',
        recentAction: '执行中',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: '程序正在运行，不应打断',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 4. 检测质量调查/评分界面
    if (/How did Claude do\?|Rate response|quality survey/i.test(terminalContent)) {
      return {
        currentState: '质量调查界面',
        workingDir: '未显示',
        recentAction: '显示调查',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: '不自动填写调查',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 5. 检测连续错误（需要暂停自动运行）
    // 统计错误出现次数
    const errorPatterns = [
      /Error writing file/gi,
      /API Error/gi,
      /Connection error/gi,
      /bad response status code/gi,
      /我遇到了工具调用问题/g,
    ];
    let totalErrors = 0;
    for (const pattern of errorPatterns) {
      const matches = terminalContent.match(pattern);
      if (matches) {
        totalErrors += matches.length;
      }
    }
    // 如果错误出现 3 次或以上，暂停自动运行
    if (totalErrors >= 3) {
      console.log(`[AIEngine] 检测到连续错误 (${totalErrors}次)，建议暂停自动运行`);
      return {
        currentState: '连续错误',
        workingDir: '未显示',
        recentAction: '多次错误',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: `检测到 ${totalErrors} 次错误，暂停自动运行以避免无限循环`,
        suggestion: '请检查 API 连接或手动处理错误',
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        shouldPauseAutoAction: true  // 标记需要暂停自动操作
      };
    }

    // 6. 检测简单的Y/N确认
    if (/\[Y\/n\]|\[y\/N\]|\(y\/n\)/i.test(terminalContent)) {
      // 根据大写字母判断默认值：[Y/n] 默认y，[y/N] 默认n
      let suggestedAction = 'y';
      if (/\[y\/N\]/.test(terminalContent)) {
        suggestedAction = 'n';
      }
      return {
        currentState: '等待Y/N确认',
        workingDir: '未显示',
        recentAction: '等待确认',
        needsAction: true,
        actionType: 'confirm',
        suggestedAction,
        actionReason: '简单确认提示',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 6. 检测致命错误（需要退出）
    if (/(fatal|crashed|Error:.*cannot continue)/i.test(terminalContent) &&
        !/Do you want to proceed\?/i.test(terminalContent)) {
      return {
        currentState: 'Claude Code致命错误',
        workingDir: '未显示',
        recentAction: '发生错误',
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: '/quit',
        actionReason: 'Claude Code遇到致命错误，需要退出',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 7. 检测Shell命令行（需要重启Claude Code）
    const shellPromptPattern = /^[\$%#]\s*$/m;
    if (shellPromptPattern.test(terminalContent) &&
        !/>\s*$/.test(terminalContent)) {
      return {
        currentState: 'Shell命令行',
        workingDir: '未显示',
        recentAction: 'Claude Code已退出',
        needsAction: true,
        actionType: 'shell_command',
        suggestedAction: 'claude -c',
        actionReason: '重新启动Claude Code继续开发',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 8. 检测部署/脚本阶段关键词
    if (/(npm run|yarn start|启动服务|localhost:\d+|server.*running|deployment)/i.test(terminalContent)) {
      return {
        currentState: '部署/脚本阶段',
        workingDir: '未显示',
        recentAction: '运行服务',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: '需要人工检查',
        suggestion: '请检查服务状态和未完成项目',
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 无法通过简单规则判断，需要AI分析
    return null;
  }

  async analyzeStatus(terminalContent) {
    // 先尝试预判断
    const preResult = this.preAnalyzeStatus(terminalContent);
    if (preResult) {
      console.log('[AIEngine] 预判断成功，跳过AI调用:', preResult.currentState);
      return preResult;
    }

    // 需要AI分析
    const prompt = `分析终端内容，返回纯JSON（不要markdown代码块）。

JSON格式：
{
  "currentState": "状态描述",
  "workingDir": "工作目录（从终端提取，无则填'未显示'）",
  "recentAction": "最近操作",
  "needsAction": true/false,
  "actionType": "confirm/select/text_input/shell_command/none",
  "suggestedAction": "建议操作",
  "actionReason": "原因",
  "suggestion": "其他建议"
}

判断优先级（按顺序）：
1. 程序运行中（"esc to interrupt"或运行时间如"2m 29s"）→ needsAction:false
2. 质量调查/评分界面 → needsAction:false
3. Claude Code确认界面（"Do you want to make/run"+"1. Yes"+"2. Yes, allow for this session"）→ needsAction:true, actionType:"select", suggestedAction:"2"
4. 普通确认界面（"Do you want to proceed?"+"1. Yes"）→ needsAction:true, actionType:"select", suggestedAction:"1"
5. Claude Code致命错误（"error/fatal/crashed"且卡住）→ needsAction:true, actionType:"text_input", suggestedAction:"/quit"
6. Shell命令行（普通shell提示符$/%，非Claude的">"）→ needsAction:true, actionType:"shell_command", suggestedAction:"claude -c"
7. Claude Code空闲（">"提示符，无运行标志）：
   - 开发阶段（代码/文件/翻译/文档/类型定义）→ needsAction:true, actionType:"text_input", suggestedAction:"继续"
   - 部署/脚本阶段（npm run/启动/测试/localhost）→ needsAction:false, suggestion:"提醒用户检查"
8. 其他确认提示（[Y/n]、数字选项）→ needsAction:true, actionType:"confirm/select"

终端内容：
---
${terminalContent || '(空)'}
---

直接返回JSON，以{开头：`;

    try {
      const content = await this._callApiWithFailover(prompt);

      if (!content) {
        return null;
      }

      return this._parseStatusResponse(content);
    } catch (err) {
      console.error('AI 状态分析错误:', err);
      throw err;
    }
  }

  _parseStatusResponse(content) {
    try {
      let jsonStr = content;
      // 尝试匹配 ```json ... ``` 或 ``` ... ``` 格式
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }
      // 如果还不是有效 JSON，尝试提取第一个完整的 {} 对象
      if (!jsonStr.trim().startsWith('{')) {
        const braceMatch = content.match(/\{[\s\S]*?\}(?=\s*$|\s*[^,\s])/);
        if (braceMatch) {
          jsonStr = braceMatch[0];
        }
      }

      // 尝试解析 JSON，如果失败则尝试修复常见问题
      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        // 尝试提取第一个有效的 JSON 对象（使用括号匹配）
        const firstBrace = jsonStr.indexOf('{');
        if (firstBrace !== -1) {
          let depth = 0;
          let endIndex = -1;
          for (let i = firstBrace; i < jsonStr.length; i++) {
            if (jsonStr[i] === '{') depth++;
            else if (jsonStr[i] === '}') {
              depth--;
              if (depth === 0) {
                endIndex = i;
                break;
              }
            }
          }
          if (endIndex !== -1) {
            const cleanJson = jsonStr.substring(firstBrace, endIndex + 1);
            parsed = JSON.parse(cleanJson);
          } else {
            throw e;
          }
        } else {
          throw e;
        }
      }

      return {
        currentState: parsed.currentState || '未知状态',
        workingDir: parsed.workingDir || '未知',
        recentAction: parsed.recentAction || '无',
        needsAction: parsed.needsAction || false,
        actionType: parsed.actionType || 'none',
        suggestedAction: parsed.suggestedAction || null,
        actionReason: parsed.actionReason || null,
        suggestion: parsed.suggestion || null,
        updatedAt: new Date().toISOString()
      };
    } catch (err) {
      console.error('解析状态响应失败:', err, content);
      return {
        currentState: '分析失败',
        workingDir: '未知',
        recentAction: '无',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: null,
        suggestion: null,
        updatedAt: new Date().toISOString()
      };
    }
  }

  /**
   * 简单文本生成（不解析 JSON）
   * @param {string} prompt - 提示词
   * @returns {Promise<string|null>} - 生成的文本
   */
  async generateText(prompt) {
    try {
      const content = await this._callApiWithFailover(prompt);
      return content || null;
    } catch (err) {
      console.error('[AIEngine] 文本生成失败:', err.message);
      return null;
    }
  }
}
