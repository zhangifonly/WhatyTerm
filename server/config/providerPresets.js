/**
 * Provider 预设配置模板
 * 基于 cc-switch claudeProviderPresets.ts 迁移并适配 WebTmux
 */

/**
 * 预设供应商配置
 */
export const providerPresets = [
  // ============================================
  // 官方供应商
  // ============================================
  {
    id: 'claude-official',
    name: 'Claude Official',
    websiteUrl: 'https://www.anthropic.com/claude',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    settingsConfig: {
      apiType: 'claude',
      claude: {
        apiUrl: 'https://api.anthropic.com/v1/messages',
        apiKey: '',
        model: 'claude-sonnet-4-5-20250929'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'official',
    icon: 'anthropic',
    iconColor: '#D4915D',
    description: 'Anthropic 官方 Claude API',
    isOfficial: true
  },

  // ============================================
  // 国产官方供应商
  // ============================================
  {
    id: 'deepseek',
    name: 'DeepSeek',
    websiteUrl: 'https://platform.deepseek.com',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    settingsConfig: {
      apiType: 'claude',
      claude: {
        apiUrl: 'https://api.deepseek.com/anthropic/v1/messages',
        apiKey: '',
        model: 'DeepSeek-V3.2'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'cn_official',
    icon: 'deepseek',
    iconColor: '#1E88E5',
    description: 'DeepSeek 官方 Claude 兼容 API'
  },

  {
    id: 'zhipu-glm',
    name: 'Zhipu GLM',
    websiteUrl: 'https://open.bigmodel.cn',
    apiKeyUrl: 'https://www.bigmodel.cn/claude-code?ic=RRVJPB5SII',
    settingsConfig: {
      apiType: 'claude',
      claude: {
        apiUrl: 'https://open.bigmodel.cn/api/anthropic/v1/messages',
        apiKey: '',
        model: 'glm-4.6'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'cn_official',
    icon: 'zhipu',
    iconColor: '#0F62FE',
    description: '智谱 AI GLM-4.6 Claude 兼容 API',
    isPartner: true
  },

  {
    id: 'z-ai-glm',
    name: 'Z.ai GLM',
    websiteUrl: 'https://z.ai',
    apiKeyUrl: 'https://z.ai/subscribe?ic=8JVLJQFSKB',
    settingsConfig: {
      apiType: 'claude',
      claude: {
        apiUrl: 'https://api.z.ai/api/anthropic/v1/messages',
        apiKey: '',
        model: 'glm-4.6'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'cn_official',
    icon: 'zhipu',
    iconColor: '#0F62FE',
    description: 'Z.ai 智谱 GLM-4.6 服务',
    isPartner: true
  },

  {
    id: 'qwen-coder',
    name: 'Qwen Coder',
    websiteUrl: 'https://bailian.console.aliyun.com',
    apiKeyUrl: 'https://bailian.console.aliyun.com',
    settingsConfig: {
      apiType: 'claude',
      claude: {
        apiUrl: 'https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy/v1/messages',
        apiKey: '',
        model: 'qwen3-max'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'cn_official',
    icon: 'qwen',
    iconColor: '#FF6A00',
    description: '阿里云通义千问 Qwen3-max'
  },

  {
    id: 'kimi-k2',
    name: 'Kimi k2',
    websiteUrl: 'https://platform.moonshot.cn/console',
    apiKeyUrl: 'https://platform.moonshot.cn/console',
    settingsConfig: {
      apiType: 'claude',
      claude: {
        apiUrl: 'https://api.moonshot.cn/anthropic/v1/messages',
        apiKey: '',
        model: 'kimi-k2-thinking'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'cn_official',
    icon: 'kimi',
    iconColor: '#6366F1',
    description: '月之暗面 Kimi k2 思考模型'
  },

  {
    id: 'kimi-for-coding',
    name: 'Kimi For Coding',
    websiteUrl: 'https://www.kimi.com/coding/docs/',
    apiKeyUrl: 'https://www.kimi.com/coding/docs/',
    settingsConfig: {
      apiType: 'claude',
      claude: {
        apiUrl: 'https://api.kimi.com/coding/v1/messages',
        apiKey: '',
        model: 'kimi-for-coding'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'cn_official',
    icon: 'kimi',
    iconColor: '#6366F1',
    description: 'Kimi 专为编程优化的模型'
  },

  {
    id: 'longcat',
    name: 'Longcat',
    websiteUrl: 'https://longcat.chat/platform',
    apiKeyUrl: 'https://longcat.chat/platform/api_keys',
    settingsConfig: {
      apiType: 'claude',
      claude: {
        apiUrl: 'https://api.longcat.chat/anthropic/v1/messages',
        apiKey: '',
        model: 'LongCat-Flash-Chat'
      },
      maxTokens: 6000,
      temperature: 0.7
    },
    category: 'cn_official',
    icon: 'generic',
    iconColor: '#10B981',
    description: 'Longcat Flash Chat 长文本模型'
  },

  {
    id: 'minimax-cn',
    name: 'MiniMax',
    websiteUrl: 'https://platform.minimaxi.com',
    apiKeyUrl: 'https://platform.minimaxi.com/subscribe/coding-plan',
    settingsConfig: {
      apiType: 'claude',
      claude: {
        apiUrl: 'https://api.minimaxi.com/anthropic/v1/messages',
        apiKey: '',
        model: 'MiniMax-M2'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'cn_official',
    icon: 'minimax',
    iconColor: '#FF6B6B',
    description: 'MiniMax M2 模型（中文站）',
    isPartner: true
  },

  {
    id: 'minimax-en',
    name: 'MiniMax EN',
    websiteUrl: 'https://platform.minimax.io',
    apiKeyUrl: 'https://platform.minimax.io/subscribe/coding-plan',
    settingsConfig: {
      apiType: 'claude',
      claude: {
        apiUrl: 'https://api.minimax.io/anthropic/v1/messages',
        apiKey: '',
        model: 'MiniMax-M2'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'cn_official',
    icon: 'minimax',
    iconColor: '#FF6B6B',
    description: 'MiniMax M2 模型（国际站）',
    isPartner: true
  },

  {
    id: 'doubao-seed',
    name: 'DouBaoSeed',
    websiteUrl: 'https://www.volcengine.com/product/doubao',
    apiKeyUrl: 'https://www.volcengine.com/product/doubao',
    settingsConfig: {
      apiType: 'claude',
      claude: {
        apiUrl: 'https://ark.cn-beijing.volces.com/api/coding/v1/messages',
        apiKey: '',
        model: 'doubao-seed-code-preview-latest'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'cn_official',
    icon: 'doubao',
    iconColor: '#3370FF',
    description: '字节跳动豆包 Seed 代码生成模型'
  },

  {
    id: 'bailing',
    name: 'BaiLing',
    websiteUrl: 'https://alipaytbox.yuque.com/sxs0ba/ling/get_started',
    apiKeyUrl: 'https://alipaytbox.yuque.com/sxs0ba/ling/get_started',
    settingsConfig: {
      apiType: 'claude',
      claude: {
        apiUrl: 'https://api.tbox.cn/api/anthropic/v1/messages',
        apiKey: '',
        model: 'Ling-1T'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'cn_official',
    icon: 'generic',
    iconColor: '#8B5CF6',
    description: '蚂蚁百灵 Ling-1T 模型'
  },

  // ============================================
  // 聚合平台 & 第三方
  // ============================================
  {
    id: 'agent-ai',
    name: 'Agent AI',
    websiteUrl: 'https://agent-ai.webtrn.cn',
    apiKeyUrl: null,
    settingsConfig: {
      apiType: 'openai',
      openai: {
        apiUrl: 'https://agent-ai.webtrn.cn/v1/chat/completions',
        apiKey: '',
        model: 'opus'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'aggregator',
    icon: 'generic',
    iconColor: '#F59E0B',
    description: 'Agent AI OpenAI 兼容接口（无需 API Key）',
    notes: '按照 APInew.md 规范，支持流式和多模态'
  },

  {
    id: 'modelscope',
    name: 'ModelScope',
    websiteUrl: 'https://modelscope.cn',
    apiKeyUrl: 'https://modelscope.cn',
    settingsConfig: {
      apiType: 'claude',
      claude: {
        apiUrl: 'https://api-inference.modelscope.cn/v1/messages',
        apiKey: '',
        model: 'ZhipuAI/GLM-4.6'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'aggregator',
    icon: 'generic',
    iconColor: '#0EA5E9',
    description: '魔搭社区模型推理服务'
  },

  {
    id: 'kat-coder',
    name: 'KAT-Coder',
    websiteUrl: 'https://console.streamlake.ai',
    apiKeyUrl: 'https://console.streamlake.ai/console/api-key',
    settingsConfig: {
      apiType: 'claude',
      claude: {
        apiUrl: 'https://vanchin.streamlake.ai/api/gateway/v1/endpoints/{ENDPOINT_ID}/claude-code-proxy/v1/messages',
        apiKey: '',
        model: 'KAT-Coder-Pro V1'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'cn_official',
    icon: 'generic',
    iconColor: '#EC4899',
    description: '火山引擎 KAT-Coder 代码生成模型',
    templateVariables: {
      ENDPOINT_ID: {
        label: 'Vanchin Endpoint ID',
        placeholder: 'ep-xxx-xxx',
        description: '在火山引擎控制台获取端点 ID'
      }
    }
  },

  {
    id: 'packycode',
    name: 'PackyCode',
    websiteUrl: 'https://www.packyapi.com',
    apiKeyUrl: 'https://www.packyapi.com/register?aff=cc-switch',
    settingsConfig: {
      apiType: 'openai',
      openai: {
        apiUrl: 'https://www.packyapi.com/v1/chat/completions',
        apiKey: '',
        model: 'claude-sonnet-4-5-20250929'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'third_party',
    icon: 'packycode',
    iconColor: '#3B82F6',
    description: 'PackyCode API 聚合服务',
    isPartner: true,
    endpointCandidates: [
      'https://www.packyapi.com',
      'https://api-slb.packyapi.com'
    ]
  },

  {
    id: 'aihubmix',
    name: 'AiHubMix',
    websiteUrl: 'https://aihubmix.com',
    apiKeyUrl: 'https://aihubmix.com',
    settingsConfig: {
      apiType: 'openai',
      openai: {
        apiUrl: 'https://aihubmix.com/v1/chat/completions',
        apiKey: '',
        model: 'claude-sonnet-4-5-20250929'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'aggregator',
    icon: 'generic',
    iconColor: '#F97316',
    description: 'AI Hub Mix 聚合平台',
    endpointCandidates: [
      'https://aihubmix.com',
      'https://api.aihubmix.com'
    ]
  },

  {
    id: 'dmxapi',
    name: 'DMXAPI',
    websiteUrl: 'https://www.dmxapi.cn',
    apiKeyUrl: 'https://www.dmxapi.cn',
    settingsConfig: {
      apiType: 'openai',
      openai: {
        apiUrl: 'https://www.dmxapi.cn/v1/chat/completions',
        apiKey: '',
        model: 'claude-sonnet-4-5-20250929'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'aggregator',
    icon: 'generic',
    iconColor: '#14B8A6',
    description: 'DMXAPI 聚合服务',
    endpointCandidates: [
      'https://www.dmxapi.cn',
      'https://api.dmxapi.cn'
    ]
  },

  {
    id: 'openrouter',
    name: 'OpenRouter',
    websiteUrl: 'https://openrouter.ai',
    apiKeyUrl: 'https://openrouter.ai/keys',
    settingsConfig: {
      apiType: 'openai',
      openai: {
        apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: '',
        model: 'anthropic/claude-sonnet-4.5'
      },
      maxTokens: 8000,
      temperature: 0.7
    },
    category: 'aggregator',
    icon: 'openrouter',
    iconColor: '#6366F1',
    description: 'OpenRouter 国际聚合平台'
  }
];

/**
 * 根据分类获取预设
 * @param {string} category - 分类
 * @returns {Array}
 */
export function getPresetsByCategory(category) {
  if (!category) return providerPresets;
  return providerPresets.filter(p => p.category === category);
}

/**
 * 根据 ID 获取预设
 * @param {string} id - 预设 ID
 * @returns {Object|null}
 */
export function getPresetById(id) {
  return providerPresets.find(p => p.id === id) || null;
}

/**
 * 获取所有分类
 * 注意：统计数量时排除 isPartner=true 的合作伙伴供应商
 * @returns {Array}
 */
export function getCategories() {
  // 过滤掉合作伙伴供应商
  const publicPresets = providerPresets.filter(p => !p.isPartner);
  return [
    { id: 'official', name: '官方', count: publicPresets.filter(p => p.category === 'official').length },
    { id: 'cn_official', name: '国产官方', count: publicPresets.filter(p => p.category === 'cn_official').length },
    { id: 'aggregator', name: '聚合平台', count: publicPresets.filter(p => p.category === 'aggregator').length },
    { id: 'third_party', name: '第三方', count: publicPresets.filter(p => p.category === 'third_party').length },
    { id: 'custom', name: '自定义', count: 0 }
  ];
}

/**
 * 应用模板变量
 * @param {string} template - 包含占位符的字符串
 * @param {Object} values - 变量值 { key: value }
 * @returns {string}
 */
export function applyTemplateVariables(template, values) {
  if (!template || typeof template !== 'string') return template;

  let result = template;
  Object.keys(values).forEach(key => {
    const placeholder = `{${key}}`;
    result = result.replace(new RegExp(placeholder, 'g'), values[key]);
  });

  return result;
}

/**
 * 从预设创建 Provider 实例
 * @param {Object} preset - 预设配置
 * @param {Object} customValues - 自定义值（API Key, 模板变量等）
 * @returns {Object}
 */
export function createProviderFromPreset(preset, customValues = {}) {
  // 深拷贝配置
  const provider = {
    id: `provider-${preset.id}-${Date.now()}`,
    name: preset.name,
    appType: 'claude',
    settingsConfig: JSON.parse(JSON.stringify(preset.settingsConfig)),
    category: preset.category,
    websiteUrl: preset.websiteUrl,
    createdAt: Date.now(),
    sortIndex: 999,
    notes: preset.description || '',
    icon: preset.icon,
    iconColor: preset.iconColor,
    meta: {
      customEndpoints: {},
      usageScript: null,
      presetId: preset.id
    }
  };

  // 应用 API Key
  if (customValues.apiKey) {
    if (provider.settingsConfig.apiType === 'claude') {
      provider.settingsConfig.claude.apiKey = customValues.apiKey;
    } else if (provider.settingsConfig.apiType === 'openai') {
      provider.settingsConfig.openai.apiKey = customValues.apiKey;
    }
  }

  // 应用模板变量
  if (preset.templateVariables && customValues.templateVariables) {
    Object.keys(preset.templateVariables).forEach(key => {
      if (customValues.templateVariables[key]) {
        const value = customValues.templateVariables[key];

        // 递归替换 settingsConfig 中的占位符
        const replaceInObject = (obj) => {
          Object.keys(obj).forEach(k => {
            if (typeof obj[k] === 'string') {
              obj[k] = applyTemplateVariables(obj[k], { [key]: value });
            } else if (typeof obj[k] === 'object' && obj[k] !== null) {
              replaceInObject(obj[k]);
            }
          });
        };

        replaceInObject(provider.settingsConfig);
      }
    });
  }

  // 应用自定义端点
  if (preset.endpointCandidates && preset.endpointCandidates.length > 0) {
    preset.endpointCandidates.forEach(url => {
      provider.meta.customEndpoints[url] = {
        url,
        addedAt: Date.now(),
        lastUsed: null
      };
    });
  }

  return provider;
}

export default {
  providerPresets,
  getPresetsByCategory,
  getPresetById,
  getCategories,
  applyTemplateVariables,
  createProviderFromPreset
};
