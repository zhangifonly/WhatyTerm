import BasePlugin from '../BasePlugin.js';
import promptLoader from '../PromptLoader.js';

/**
 * API 集成监控策略插件
 * 针对 API 开发、MCP 服务构建等场景
 */
class APIIntegrationPlugin extends BasePlugin {
  constructor() {
    super();
    this.id = 'api-integration';
    this.name = 'API 集成';
    this.description = 'API 集成开发监控策略，支持接口设计、认证配置、端点实现、测试验证、文档编写等阶段';
    this.version = '2.0.0';

    // 匹配规则
    this.projectPatterns = [
      /api.*integration|api.*集成/i,
      /rest.*api|graphql|grpc/i,
      /mcp.*server|mcp.*服务/i,
      /swagger|openapi|postman/i,
      /endpoint|端点|route|路由/i,
      /oauth|jwt|认证|authentication/i,
      /webhook|回调/i
    ];

    // API 集成阶段
    this.phases = [
      { id: 'design', name: '接口设计', priority: 1 },
      { id: 'auth', name: '认证配置', priority: 2 },
      { id: 'implement', name: '端点实现', priority: 3 },
      { id: 'testing', name: '测试验证', priority: 4 },
      { id: 'documentation', name: '文档编写', priority: 5 }
    ];
  }

  matches(projectContext) {
    const { projectPath, projectDesc, workingDir, goal } = projectContext;
    const searchText = `${projectPath || ''} ${projectDesc || ''} ${workingDir || ''} ${goal || ''}`;
    return this.projectPatterns.some(p => p.test(searchText));
  }

  detectPhase(terminalContent, projectContext) {
    const lastLines = terminalContent.split('\n').slice(-40).join('\n');

    // 文档编写阶段
    if (/document|文档|swagger|openapi|readme|说明/i.test(lastLines)) {
      return 'documentation';
    }

    // 测试验证阶段
    if (/test|测试|postman|curl|request|response|200|201|400|401|500/i.test(lastLines)) {
      return 'testing';
    }

    // 端点实现阶段
    if (/endpoint|端点|route|路由|handler|controller|implement/i.test(lastLines)) {
      return 'implement';
    }

    // 认证配置阶段
    if (/auth|认证|oauth|jwt|token|api.*key|secret/i.test(lastLines)) {
      return 'auth';
    }

    // 默认为接口设计
    return 'design';
  }

  getPhaseConfig(phase) {
    const configs = {
      design: {
        autoActions: ['继续', '设计接口', '定义模型'],
        checkpoints: [
          '接口是否符合 RESTful 规范',
          '请求/响应格式是否清晰',
          '错误处理是否完善'
        ],
        autoActionEnabled: true,
        idleTimeout: 45000
      },

      auth: {
        autoActions: ['继续', '配置认证', '测试认证'],
        checkpoints: [
          '认证方式是否安全',
          '密钥是否妥善保管',
          '权限控制是否合理'
        ],
        warningPatterns: [/unauthorized|forbidden|401|403|invalid.*token/i],
        autoActionEnabled: true,
        idleTimeout: 30000
      },

      implement: {
        autoActions: ['继续', '实现端点', '处理错误'],
        checkpoints: [
          '端点是否正确实现',
          '参数验证是否完善',
          '错误处理是否到位'
        ],
        warningPatterns: [/error|failed|exception|500/i],
        autoActionEnabled: true,
        idleTimeout: 30000
      },

      testing: {
        autoActions: ['继续测试', '修复问题'],
        checkpoints: [
          '所有端点是否正常',
          '边界情况是否处理',
          '性能是否达标'
        ],
        warningPatterns: [/fail|error|timeout|500/i],
        autoActionEnabled: false,
        requireConfirmation: true,
        idleTimeout: 45000
      },

      documentation: {
        autoActions: ['继续', '编写文档', '添加示例'],
        checkpoints: [
          '文档是否完整',
          '示例是否清晰',
          '是否有使用说明'
        ],
        autoActionEnabled: true,
        idleTimeout: 30000
      }
    };

    const config = configs[phase] || configs.design;

    // 从文件加载提示词模板
    const promptTemplate = promptLoader.getPrompt(this.id, phase) || '';

    return {
      ...config,
      promptTemplate
    };
  }

  analyzeStatus(terminalContent, phase, context) {
    const config = this.getPhaseConfig(phase);
    const lastLines = terminalContent.split('\n').slice(-20).join('\n');

    // 检测 API 集成完成
    if (/api.*complete|集成完成|all.*endpoints.*ready/i.test(lastLines)) {
      return {
        needsAction: false,
        actionType: 'success',
        suggestedAction: null,
        phase,
        phaseConfig: config,
        message: 'API 集成完成'
      };
    }

    // 检查警告模式
    for (const pattern of config.warningPatterns || []) {
      if (pattern.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'error',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: 'API 错误，需要检查',
          requireConfirmation: true
        };
      }
    }

    // 检查空闲状态
    if (config.autoActionEnabled && this.isIdle(terminalContent)) {
      return {
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: config.autoActions[0],
        phase,
        phaseConfig: config,
        message: `API 集成 - ${this.phases.find(p => p.id === phase)?.name}: 发送继续指令`
      };
    }

    return null;
  }
}

export default APIIntegrationPlugin;
