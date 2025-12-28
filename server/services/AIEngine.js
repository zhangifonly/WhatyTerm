import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ProxyAgent, Agent } from 'undici';
import Database from 'better-sqlite3';
import ProviderService from './ProviderService.js';
import ConfigService from './ConfigService.js';
import processDetector from './ProcessDetector.js';
import tokenStatsService from './TokenStatsService.js';
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

/**
 * 根据 AI 类型获取对应的 CLI 命令
 * @param {string} aiType - AI 类型 (claude/codex/gemini)
 * @returns {string} CLI 命令
 */
function getCliCommand(aiType) {
  const commands = {
    'claude': 'claude -c',
    'codex': 'codex',
    'gemini': 'gemini',
    'droid': 'droid'
  };
  return commands[aiType] || commands['claude'];
}

/**
 * 根据 AI 类型获取 CLI 工具名称
 * @param {string} aiType - AI 类型 (claude/codex/gemini)
 * @returns {string} CLI 工具名称
 */
function getCliName(aiType) {
  const names = {
    'claude': 'Claude Code',
    'codex': 'OpenAI Codex',
    'gemini': 'Google Gemini',
    'droid': 'Droid AI'
  };
  return names[aiType] || names['claude'];
}

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
   * @param {string} prompt - 提示词
   * @param {object} options - 可选参数
   * @param {string} options.sessionId - 会话 ID（用于 token 统计）
   * @param {string} options.requestType - 请求类型（用于 token 统计）
   * @returns {string} 返回 AI 响应文本（保持向后兼容）
   */
  async _callApiWithFailover(prompt, options = {}) {
    const { sessionId, requestType = 'analyze' } = options;

    // 如果未启用故障转移，直接调用
    if (!this.failoverConfig || !this.failoverConfig.enabled) {
      const response = await this._callApi(prompt);
      // 记录 token 统计（不影响原有逻辑）
      this._recordTokenUsage(response, sessionId, requestType);
      // 返回文本保持兼容
      return response?.text ?? response;
    }

    const maxRetries = this.failoverConfig.maxRetries || 3;
    const retryDelay = this.failoverConfig.retryDelayMs || 5000;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // 尝试调用当前供应商
        const response = await this._callApi(prompt);

        // 如果成功且不是第一次尝试，说明发生了故障转移
        if (attempt > 0) {
          const currentProvider = this.getCurrentProviderInfo();
          console.log(`[AIEngine] 故障转移成功，切换到供应商: ${currentProvider?.name || 'unknown'}`);
        }

        // 记录 token 统计（不影响原有逻辑）
        this._recordTokenUsage(response, sessionId, requestType);
        // 返回文本保持兼容
        return response?.text ?? response;
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
   * 记录 token 使用统计（内部方法，不影响主流程）
   */
  _recordTokenUsage(response, sessionId, requestType) {
    try {
      if (!response || !response.usage) return;

      const providerInfo = this.getCurrentProviderInfo();
      tokenStatsService.recordUsage({
        sessionId,
        providerName: providerInfo?.name || 'unknown',
        providerUrl: providerInfo?.url || '',
        model: response.model || 'unknown',
        usage: response.usage,
        requestType,
        success: true
      });
    } catch (err) {
      // 统计失败不影响主流程
      console.error('[AIEngine] Token 统计记录失败:', err.message);
    }
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
    // 返回包含 text 和 usage 的对象
    return {
      text: data.choices?.[0]?.message?.content || null,
      usage: data.usage ? {
        input_tokens: data.usage.prompt_tokens || 0,
        output_tokens: data.usage.completion_tokens || 0
      } : null,
      model: data.model || config.model || 'unknown'
    };
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
    // 返回包含 text 和 usage 的对象
    return {
      text: data.content?.[0]?.text || null,
      usage: data.usage || null,
      model: data.model || config.model || 'unknown'
    };
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
    // 使用正确的 input 数组格式
    // 注意：不发送 instructions 字段，因为某些供应商（如 FoxCode）不接受自定义 instructions
    // 供应商会使用自己的默认 instructions
    const requestBody = {
      model: config.model || 'gpt-5-codex',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: prompt }
          ]
        }
      ],
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
      const { text, usage } = this._parseCodexSSE(responseText);
      return { text, usage, model: config.model || 'gpt-5-codex' };
    }

    // 尝试解析为 JSON
    try {
      const data = JSON.parse(responseText);
      // Responses API 返回格式：{ output: [{ type: 'message', content: [...] }] }
      const output = data.output || [];
      let text = null;
      for (const item of output) {
        if (item.type === 'message' && item.content) {
          for (const content of item.content) {
            if (content.type === 'output_text') {
              text = content.text;
              break;
            }
          }
        }
        if (text) break;
      }
      // 回退：尝试其他可能的响应格式
      if (!text) {
        text = data.choices?.[0]?.message?.content || data.text || null;
      }
      // 返回包含 text 和 usage 的对象
      return {
        text,
        usage: data.usage ? {
          input_tokens: data.usage.prompt_tokens || data.usage.input_tokens || 0,
          output_tokens: data.usage.completion_tokens || data.usage.output_tokens || 0
        } : null,
        model: data.model || config.model || 'gpt-5-codex'
      };
    } catch (e) {
      console.error('[AIEngine] Codex 响应解析失败:', e);
      return { text: null, usage: null, model: config.model || 'gpt-5-codex' };
    }
  }

  // 解析 Codex SSE 流式响应
  _parseCodexSSE(sseText) {
    let result = '';
    let usage = null;
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
            // 提取 usage 信息
            if (data.response?.usage) {
              usage = {
                input_tokens: data.response.usage.input_tokens || 0,
                output_tokens: data.response.usage.output_tokens || 0
              };
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

    return { text: result || null, usage };
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
   * 优先使用 tmux 进程检测，回退到终端内容分析
   * @param {string} terminalContent - 终端内容
   * @param {string} tmuxSession - tmux 会话名称（可选，用于进程检测）
   * @returns {string|null} 'claude' | 'codex' | 'gemini' | null
   */
  detectRunningCLI(terminalContent, tmuxSession = null) {
    // 优先使用进程检测（更可靠）
    if (tmuxSession) {
      const processResult = processDetector.detectCLI(tmuxSession);
      if (processResult.detected) {
        console.log(`[AIEngine] 进程检测到 CLI: ${processResult.cli} (${processResult.processName}, PID: ${processResult.pid})`);
        return processResult.cli;
      }
    }

    // 回退到终端内容分析
    if (!terminalContent) return null;

    // 只检查最后 30 行内容，避免被历史记录干扰
    const lines = terminalContent.split('\n');
    const lastLines = lines.slice(-30).join('\n');

    // 检测 shell 命令行提示符（CLI 已退出的标志）
    // 如果最后几行是 shell 提示符，说明 CLI 已退出
    const last5Lines = lines.slice(-5).join('\n');

    // 如果最后几行是普通 shell 提示符（包含用户名@主机名），CLI 已退出
    if (/\w+@\w+.*[%$#]\s*$/.test(last5Lines)) {
      return null;
    }

    // 检测 Codex CLI 特征（必须在 Claude Code 之前检测，因为两者都有 > 提示符）
    if (/OpenAI Codex|codex-cli|openai.*codex/i.test(lastLines) ||
        /Updated Plan|Worked for \d+m\s+\d+s/i.test(lastLines) ||
        /^[•●]\s*(Ran|Explored|Read)\s/m.test(lastLines) ||
        /Reviewing local code|Generating response/i.test(lastLines) ||
        /Summarize recent commits/i.test(lastLines) ||
        /model:\s*(gpt-|o\d-|codex)/i.test(lastLines)) {
      return 'codex';
    }

    // 检测 Claude Code 特征
    if (/esc to interrupt/i.test(lastLines) ||
        /Clauding|Hatching/i.test(lastLines) ||
        /accept edits/i.test(lastLines) ||
        /Do you want to (make this edit|create|delete|run)/i.test(lastLines) ||
        /Claude Code|claude-cli/i.test(lastLines) ||
        /Running \d+ Task agents/i.test(lastLines)) {
      return 'claude';
    }

    // 检测 Gemini CLI 特征
    if (/gemini-2\.5-(flash|pro)|gemini-cli|@google\/gemini/i.test(lastLines) ||
        /GoogleSearch\s+Searching/i.test(lastLines) ||
        /✦\s*I have successfully/i.test(lastLines) ||
        /Ready\s*\(\d+\s*tools?\)/i.test(lastLines) ||
        /Google Gemini/i.test(lastLines) ||
        /(ReadFile|WriteFile|Shell)\s+(Reading|Writing|Running)/i.test(lastLines)) {
      return 'gemini';
    }

    // 检测 Droid CLI 特征
    if (/GPT5-Codex.*\[Custom\]/i.test(lastLines) ||
        /droid.*v\d+\.\d+/i.test(lastLines) ||
        /IDE\s*⚙/i.test(lastLines) ||
        /Auto \(Off\).*shift\+tab/i.test(lastLines)) {
      return 'droid';
    }

    return null;
  }

  /**
   * 预判断终端状态，避免不必要的AI调用
   * 返回null表示需要AI分析，返回对象表示已判断出结果
   * @param {string} terminalContent - 终端内容
   * @param {string} aiType - AI 类型 (claude/codex/gemini)
   * @param {string} tmuxSession - tmux 会话名称（可选，用于进程检测）
   */
  preAnalyzeStatus(terminalContent, aiType = 'claude', tmuxSession = null) {
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

    // 检测运行的 CLI 工具（优先使用进程检测）
    const detectedCLI = this.detectRunningCLI(terminalContent, tmuxSession);

    // 先清理 ANSI 转义序列，确保正则能正确匹配
    const cleanContent = terminalContent.replace(/\x1b\[[0-9;]*m/g, '');

    // 0. 最高优先级：检测程序运行中（必须在确认界面之前）
    // 如果程序正在运行，即使历史中有确认界面内容，也应该返回"运行中"
    // 但要排除确认界面的情况（确认界面显示时程序实际上已暂停）
    let isRunning = false;
    const cliName = getCliName(aiType);

    // 先检查是否是确认界面（排除误判）
    const isConfirmDialog = (/Do you want to proceed\?/i.test(cleanContent) ||
                             /Do you want to (make this edit|create|delete|run)/i.test(cleanContent)) &&
                            /1\.\s*Yes/i.test(cleanContent);

    if (aiType === 'claude') {
      // Claude Code 运行中标志
      // 如果是确认界面，不判断为运行中
      const hasRunningIndicator = /esc to interrupt/i.test(cleanContent) ||
                                  /ctrl\+t to show todos/i.test(cleanContent);
      // 运行时间只在最后500字符内检测，避免匹配到历史 timeout 参数
      const last500 = cleanContent.slice(-500);
      const hasRecentRuntime = /\(\d+m\s*\d+s\)|\d+m\s+\d+s\s*$/.test(last500);

      isRunning = !isConfirmDialog && (hasRunningIndicator || hasRecentRuntime);
    } else if (aiType === 'codex') {
      // Codex CLI 运行中标志（排除确认界面）
      isRunning = !isConfirmDialog && (
        /\(\d+s\s*[•·]?\s*esc to interrupt\)/i.test(cleanContent) ||
        /(Reviewing|Generating|Executing|Processing|Thinking).*\(\d+s/i.test(cleanContent) ||
        /esc to interrupt/i.test(cleanContent)
      );
    } else if (aiType === 'gemini') {
      // Gemini CLI 运行中标志（排除确认界面）
      isRunning = !isConfirmDialog && (
        /GoogleSearch\s+Searching/i.test(cleanContent) ||
        /(ReadFile|WriteFile|Shell)\s+(Reading|Writing|Running)/i.test(cleanContent) ||
        /gemini-2\.5.*\.\.\./i.test(cleanContent) ||
        /(Thinking|Generating|Processing).*\.\.\./i.test(cleanContent)
      );
    } else if (aiType === 'droid') {
      // Droid CLI 运行中标志（排除确认界面）
      isRunning = !isConfirmDialog && (
        /esc to interrupt/i.test(cleanContent) ||
        /Thinking|Processing|Generating/i.test(cleanContent) ||
        /\(\d+m\s*\d+s\)|\d+m\s+\d+s\s*$/.test(cleanContent.slice(-500))
      );
    } else {
      // 通用检测（排除确认界面）
      const last500 = cleanContent.slice(-500);
      isRunning = !isConfirmDialog && (
        /esc to interrupt/i.test(cleanContent) ||
        /\(\d+m\s*\d+s\)|\d+m\s+\d+s\s*$/.test(last500)
      );
    }

    if (isRunning) {
      console.log(`[AIEngine] 检测到程序运行中, CLI: ${cliName}`);
      return {
        currentState: '程序运行中',
        workingDir: '未显示',
        recentAction: '执行中',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: `${cliName} 正在工作，不应打断`,
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 1. 检测确认界面（Do you want to...）
    const isEditConfirm = /Do you want to (make this edit|create|delete|run)/i.test(cleanContent);
    const hasOption1Yes = /1\.\s*Yes/i.test(cleanContent);
    const hasOption2Yes = /2\.\s*Yes/i.test(cleanContent);

    if (isEditConfirm && hasOption1Yes) {
      // 有选项2时选2（允许本次会话），否则选1
      const selectOption = hasOption2Yes ? '2' : '1';
      console.log(`[AIEngine] 检测到 ${cliName} 确认界面，选择选项 ${selectOption}`);
      return {
        currentState: `${cliName}确认界面`,
        workingDir: '未显示',
        recentAction: '等待确认',
        needsAction: true,
        actionType: 'select',
        suggestedAction: selectOption,
        actionReason: hasOption2Yes ? '选择"允许本次会话"以自动化流程' : '选择"Yes"继续执行',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 2. 检测 API 错误
    // 区分两种情况：
    // - thinking block 相关错误：需要完整修复流程（ClaudeSessionFixer），不在这里处理
    // - 其他可重试错误（rate_limit 等）：可以简单发送"继续"重试
    const hasInputPromptForError = /^>\s*$/m.test(cleanContent) || /\n>\s*$/m.test(cleanContent);

    // 需要完整修复的错误（thinking block 相关）- 交给 ClaudeSessionFixer 处理
    const needsSessionFix = /invalid.*signature.*in.*thinking/i.test(cleanContent) ||
                            /thinking.*block.*not.*allowed/i.test(cleanContent) ||
                            /invalid.*thinking.*block/i.test(cleanContent) ||
                            /thinking\.signature.*Field required/i.test(cleanContent) ||  // 新增
                            /signature.*Field required/i.test(cleanContent) ||  // 新增
                            /tool_use_id/i.test(cleanContent) && /API Error/i.test(cleanContent);

    if (needsSessionFix && hasInputPromptForError) {
      // 不自动操作，让 server/index.js 的 ClaudeSessionFixer 来处理
      console.log('[AIEngine] 检测到需要修复的 API 错误（thinking block/tool_use_id），交给修复流程处理');
      return {
        currentState: 'API错误需要修复',
        workingDir: '未显示',
        recentAction: 'API调用失败',
        needsAction: false,  // 不自动操作
        actionType: 'none',
        suggestedAction: null,
        actionReason: '检测到 thinking block 签名错误，需要修复会话历史',
        suggestion: '等待自动修复流程执行',
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        needsSessionFix: true  // 标记需要修复
      };
    }

    // 可重试的 API 错误（如 rate_limit）
    const hasRetryableError = /API Error.*rate_limit/i.test(cleanContent) ||
                              /API Error.*overloaded/i.test(cleanContent) ||
                              /API Error.*5\d{2}/i.test(cleanContent);  // 5xx 服务器错误

    if (hasRetryableError && hasInputPromptForError) {
      console.log('[AIEngine] 检测到可重试的 API 错误，发送"继续"重试');
      return {
        currentState: 'API错误可重试',
        workingDir: '未显示',
        recentAction: 'API调用失败',
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: '继续',
        actionReason: '检测到可重试的 API 错误，自动发送"继续"重试',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 3. 先检测询问问题状态（优先级高于编辑确认）
    // 因为状态栏的 "shift+tab to cycle" 始终存在，不能仅凭此判断编辑确认
    const last1000Chars = terminalContent.slice(-1000);
    const cleanLast1000 = last1000Chars.replace(/\x1b\[[0-9;]*m/g, '');
    const hasInputPromptEarly = /^>\s*$/m.test(cleanLast1000) || />\s*\|/.test(cleanLast1000) || /\n>\s*$/.test(cleanLast1000);

    if (hasInputPromptEarly) {
      // 检测"是否需要..."类询问 - 应该自动回答"继续"或让用户决定
      const isNeedQuestion = /是否需要.{0,50}[？?]/i.test(cleanLast1000);
      if (isNeedQuestion) {
        console.log('[AIEngine] 检测到"是否需要..."询问，建议用户回复');
        return {
          currentState: `${cliName}询问下一步`,
          workingDir: '未显示',
          recentAction: '显示询问',
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续',
          actionReason: '检测到询问，建议继续执行',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI
        };
      }

      // 检测"是否继续"类问题 - 应该自动回答"继续"
      const isContinueQuestionEarly = /是否继续.{0,20}[？?]/i.test(cleanLast1000);
      if (isContinueQuestionEarly) {
        console.log('[AIEngine] 检测到"是否继续"问题，自动回答继续');
        return {
          currentState: `${cliName}询问是否继续`,
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

      // 检测"请告知..."类询问 - 需要用户输入
      const isAskForInput = /请告知.{0,30}[。？?]/i.test(cleanLast1000);
      if (isAskForInput) {
        console.log('[AIEngine] 检测到"请告知..."询问，等待用户输入');
        return {
          currentState: '等待用户输入',
          workingDir: '未显示',
          recentAction: '显示询问',
          needsAction: false,
          actionType: 'none',
          suggestedAction: null,
          actionReason: '等待用户提供信息，不自动操作',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI
        };
      }
    }

    // 4. 检测 Claude Code 编辑确认界面（>> accept edits on）
    // 注意：必须有 ">>" 双箭头才是真正的编辑确认界面
    // 单独的 "shift+tab to cycle" 只是状态栏提示，不代表有编辑等待确认
    // 真正的编辑确认界面会显示文件路径和 diff 内容
    const hasDoubleArrow = /^>>\s/m.test(cleanContent) || /\n>>\s/m.test(cleanContent);
    const hasEditContent = /\+\+\+|---|\@\@.*\@\@/m.test(cleanContent); // diff 格式
    if (hasDoubleArrow && (hasEditContent || /accept edits/i.test(cleanContent))) {
      console.log(`[AIEngine] 检测到 ${cliName} 编辑确认界面(Tab模式)，等待用户确认`);
      return {
        currentState: `${cliName}等待编辑确认`,
        workingDir: '未显示',
        recentAction: '等待用户按Tab确认编辑',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: '用户需要按 Tab 键确认或拒绝编辑，不自动操作',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 5. 检测普通确认界面（Do you want to proceed?）
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

    // 2.6 检测 Claude Code 空闲状态
    // 当显示 "> " 单箭头提示符时，说明 Claude Code 处于空闲状态，等待用户输入
    // 注意："accept edits on" 底部状态栏是正常状态，但 ">> accept edits" 双箭头是编辑确认界面
    // 重要：必须排除 ">> accept edits" 和 "shift+tab to cycle" 的情况
    const hasPrompt = /^>\s*$/m.test(cleanContent) || /\n>\s*$/m.test(cleanContent);
    const isEditConfirmMode = />>.*accept edits/i.test(cleanContent) || /shift\+tab to cycle/i.test(cleanContent);
    if (hasPrompt && /accept edits/i.test(cleanContent) && !isEditConfirmMode) {
      return {
        currentState: `${cliName}空闲中`,
        workingDir: '未显示',
        recentAction: '等待用户输入',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: `${cliName}已完成任务，等待用户输入新指令`,
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 2.7 检测 Claude Code 空闲状态下的中文问句
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
          currentState: `${cliName}询问是否继续`,
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
          currentState: `${cliName}空闲`,
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

    // 5. 检测 API 错误（需要 AI 判断错误类型）
    // 只检查最近 30 行内容，避免被历史错误干扰
    const recentLines = cleanContent.split('\n').slice(-30).join('\n');

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
      const matches = recentLines.match(pattern);
      if (matches) {
        totalErrors += matches.length;
      }
    }

    // 如果检测到错误，返回特殊标记，让调用方进行 AI 错误分析
    if (totalErrors >= 1) {
      console.log(`[AIEngine] 检测到 API 错误 (${totalErrors}次)，需要 AI 分析错误类型`);
      return {
        currentState: 'API错误待分析',
        workingDir: '未显示',
        recentAction: 'API错误',
        needsAction: false,  // 暂不操作，等 AI 分析
        actionType: 'none',
        suggestedAction: null,
        actionReason: '检测到 API 错误，需要 AI 分析错误类型',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        needsErrorAnalysis: true,  // 标记需要 AI 错误分析
        errorContent: recentLines,  // 传递错误内容供 AI 分析
        errorCount: totalErrors
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

    // 6. 检测 CLI 崩溃后回到 Shell（需要自动恢复）
    // 特征：终端内容包含 Node.js 崩溃错误 + shell 提示符
    const crashPatterns = [
      /RangeError:\s*Maximum call stack size exceeded/i,
      /FATAL ERROR/i,
      /JavaScript heap out of memory/i,
      /SIGKILL|SIGTERM|SIGSEGV/,
      /Error:.*cannot continue/i,
      /Unhandled.*rejection/i,
      /TypeError:.*undefined/i,
      /SyntaxError:.*Unexpected/i
    ];

    const hasCrashError = crashPatterns.some(pattern => pattern.test(terminalContent));
    const isShellPrompt = /\w+@\w+.*[%$#]\s*$/.test(cleanContent) ||  // user@host ... %
                          /^[\$%#]\s*$/m.test(cleanContent);           // 单独的 $ % #

    // 如果检测到崩溃错误且回到了 shell 提示符，需要自动恢复
    if (hasCrashError && isShellPrompt) {
      const cliCommand = getCliCommand(aiType);
      return {
        currentState: `${cliName}崩溃`,
        workingDir: '未显示',
        recentAction: 'CLI异常退出',
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: cliCommand,
        actionReason: `${cliName}崩溃后退出，需要重新启动继续开发`,
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 7. 检测致命错误（CLI 还在运行，需要退出）
    if (/(fatal|crashed|Error:.*cannot continue)/i.test(terminalContent) &&
        !/Do you want to proceed\?/i.test(terminalContent) &&
        !isShellPrompt) {
      return {
        currentState: `${cliName}致命错误`,
        workingDir: '未显示',
        recentAction: '发生错误',
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: '/quit',
        actionReason: `${cliName}遇到致命错误，需要退出`,
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 8. 检测Shell命令行（CLI 正常退出，不需要紧急操作）
    if (isShellPrompt && !/^>\s*$/m.test(cleanContent)) {
      return {
        currentState: 'Shell命令行',
        workingDir: '未显示',
        recentAction: `${cliName}已退出`,
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: null,
        suggestion: `可输入 ${getCliCommand(aiType)} 重新启动${cliName}`,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI
      };
    }

    // 9. 检测部署/脚本阶段关键词
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

  /**
   * 分析终端状态
   * @param {string} terminalContent - 终端内容
   * @param {string} aiType - AI 类型 (claude/codex/gemini)
   */
  async analyzeStatus(terminalContent, aiType = 'claude', sessionId = null) {
    // 先尝试预判断
    const preResult = this.preAnalyzeStatus(terminalContent, aiType);
    if (preResult) {
      console.log('[AIEngine] 预判断成功，跳过AI调用:', preResult.currentState);
      return preResult;
    }

    // 需要AI分析
    const cliName = getCliName(aiType);
    const cliCommand = getCliCommand(aiType);
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
3. ${cliName}确认界面（"Do you want to make/run"+"1. Yes"+"2. Yes, allow for this session"）→ needsAction:true, actionType:"select", suggestedAction:"2"
4. 普通确认界面（"Do you want to proceed?"+"1. Yes"）→ needsAction:true, actionType:"select", suggestedAction:"1"
5. ${cliName}致命错误（"error/fatal/crashed"且卡住）→ needsAction:true, actionType:"text_input", suggestedAction:"/quit"
6. Shell命令行（普通shell提示符$/%，非${cliName}的">"）→ needsAction:true, actionType:"shell_command", suggestedAction:"${cliCommand}"
7. ${cliName}空闲（">"提示符，无运行标志）：
   - 开发阶段（代码/文件/翻译/文档/类型定义）→ needsAction:true, actionType:"text_input", suggestedAction:"继续"
   - 部署/脚本阶段（npm run/启动/测试/localhost）→ needsAction:false, suggestion:"提醒用户检查"
8. 其他确认提示（[Y/n]、数字选项）→ needsAction:true, actionType:"confirm/select"

终端内容：
---
${terminalContent || '(空)'}
---

直接返回JSON，以{开头：`;

    try {
      const content = await this._callApiWithFailover(prompt, {
        sessionId,
        requestType: 'analyzeStatus'
      });

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

  /**
   * AI 分析 API 错误类型，决定修复策略
   * @param {string} errorContent - 错误内容（终端最近输出）
   * @returns {Promise<object>} - 分析结果
   */
  async analyzeApiError(errorContent) {
    const prompt = `分析以下 API 错误信息，判断错误类型并建议修复策略。

错误内容：
---
${errorContent}
---

请判断这是什么类型的错误，返回纯 JSON（不要 markdown 代码块）：

{
  "errorType": "错误类型，必须是以下之一：insufficient_balance（余额/额度不足）、server_unavailable（服务器不可用）、rate_limit（频率限制）、thinking_error（thinking模式不兼容）、auth_error（认证错误但非余额问题）、other（其他错误）",
  "action": "建议操作，必须是以下之一：switch_provider（切换供应商）、run_fixer（运行修复程序）、wait_and_retry（等待后重试）、none（无需操作）",
  "reason": "判断理由，简短说明",
  "waitSeconds": 等待秒数（仅当 action 为 wait_and_retry 时需要，默认 60）
}

判断规则：
1. 如果错误信息包含"余额不足"、"额度不足"、"credit"、"quota"、"balance"等与账户额度相关的词，且表示无法继续使用，则为 insufficient_balance，建议 switch_provider
2. 如果错误是 502、503、504 或明确说服务器不可用、超时、连接失败，则为 server_unavailable，建议 switch_provider
3. 如果错误是 429 或提到 rate limit、请求过于频繁，则为 rate_limit，建议 wait_and_retry
4. 如果错误涉及 thinking block、signature、不支持的模式，则为 thinking_error，建议 run_fixer
5. 如果是认证错误（401）但不涉及余额，则为 auth_error，建议 switch_provider
6. 其他错误默认 wait_and_retry

直接返回 JSON，以 { 开头：`;

    try {
      const content = await this._callApiWithFailover(prompt);
      if (!content) {
        return this._getDefaultErrorAnalysis();
      }

      // 解析 JSON 响应
      let jsonStr = content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      const result = JSON.parse(jsonStr);
      console.log(`[AIEngine] AI 错误分析结果: ${result.errorType} -> ${result.action} (${result.reason})`);

      return {
        errorType: result.errorType || 'other',
        action: result.action || 'wait_and_retry',
        reason: result.reason || '未知原因',
        waitSeconds: result.waitSeconds || 60,
        isInsufficientBalance: result.errorType === 'insufficient_balance',
        isServerUnavailable: result.errorType === 'server_unavailable',
        isRateLimitError: result.errorType === 'rate_limit',
        isThinkingError: result.errorType === 'thinking_error',
        shouldAutoFix: true,
        autoFixAction: result.action
      };
    } catch (err) {
      console.error('[AIEngine] AI 错误分析失败:', err.message);
      return this._getDefaultErrorAnalysis();
    }
  }

  /**
   * 获取默认的错误分析结果（AI 分析失败时使用）
   */
  _getDefaultErrorAnalysis() {
    return {
      errorType: 'other',
      action: 'wait_and_retry',
      reason: 'AI 分析失败，默认等待重试',
      waitSeconds: 60,
      isInsufficientBalance: false,
      isServerUnavailable: false,
      isRateLimitError: false,
      isThinkingError: false,
      shouldAutoFix: true,
      autoFixAction: 'wait_and_retry'
    };
  }
}
