import DeclarativePlugin from '../DeclarativePlugin.js';

/**
 * API 集成监控策略插件
 * 针对 API 开发、MCP 服务构建等场景
 *
 * 骨架统一在 DeclarativePlugin，这里只声明数据（原实现逐字等价）。
 */
const definition = {
  id: 'api-integration',
  name: 'API 集成',
  description: 'API 集成开发监控策略，支持接口设计、认证配置、端点实现、测试验证、文档编写等阶段',
  version: '2.0.0',

  projectPatterns: [
    /api.*integration|api.*集成/i,
    /rest.*api|graphql|grpc/i,
    /mcp.*server|mcp.*服务/i,
    /swagger|openapi|postman/i,
    /endpoint|端点|route|路由/i,
    /oauth|jwt|认证|authentication/i,
    /webhook|回调/i
  ],

  phases: [
    { id: 'design', name: '接口设计', priority: 1 },
    { id: 'auth', name: '认证配置', priority: 2 },
    { id: 'implement', name: '端点实现', priority: 3 },
    { id: 'testing', name: '测试验证', priority: 4 },
    { id: 'documentation', name: '文档编写', priority: 5 }
  ],

  // 按顺序匹配，命中即返回（顺序与原 detectPhase 的 if 链一致）
  phaseRules: [
    { phase: 'documentation', any: /document|文档|swagger|openapi|readme|说明/i },
    { phase: 'testing', any: /test|测试|postman|curl|request|response|200|201|400|401|500/i },
    { phase: 'implement', any: /endpoint|端点|route|路由|handler|controller|implement/i },
    { phase: 'auth', any: /auth|认证|oauth|jwt|token|api.*key|secret/i },
  ],
  defaultPhase: 'design',

  phaseConfigs: {
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
  },

  completePattern: /api.*complete|集成完成|all.*endpoints.*ready/i,
  completeMessage: 'API 集成完成',
  onWarning: {
    needsAction: false,
    actionType: 'error',
    suggestedAction: null,
    message: 'API 错误，需要检查',
    requireConfirmation: true
  },
  idlePrefix: 'API 集成'
};

class APIIntegrationPlugin extends DeclarativePlugin {
  constructor() {
    super(definition);
  }
}

export default APIIntegrationPlugin;
