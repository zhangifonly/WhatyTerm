import DeclarativePlugin from '../DeclarativePlugin.js';

/**
 * TDD 开发监控策略插件
 * 针对测试驱动开发场景
 *
 * 骨架统一在 DeclarativePlugin，这里只声明数据（原实现逐字等价）。
 */
const definition = {
  id: 'tdd-development',
  name: 'TDD 开发',
  description: '测试驱动开发监控策略，支持编写测试、运行失败、实现代码、测试通过、重构等阶段',
  version: '2.0.0',

  projectPatterns: [
    /tdd|test.*driven|测试驱动/i,
    /jest|mocha|pytest|rspec|junit/i,
    /\.test\.|\.spec\.|_test\.|_spec\./i,
    /red.*green.*refactor/i,
    /unit.*test|单元测试/i
  ],

  phases: [
    { id: 'write_test', name: '编写测试', priority: 1 },
    { id: 'run_fail', name: '运行失败', priority: 2 },
    { id: 'implement', name: '实现代码', priority: 3 },
    { id: 'run_pass', name: '测试通过', priority: 4 },
    { id: 'refactor', name: '重构优化', priority: 5 }
  ],

  // 按顺序匹配，命中即返回（顺序与原 detectPhase 的 if 链一致）
  phaseRules: [
    { phase: 'refactor', any: /refactor|重构|clean.*up|优化|extract|提取/i },
    { phase: 'run_pass', any: /pass|passed|✓|√|green|通过|success/i, all: /test|spec|测试/i },
    { phase: 'implement', any: /implement|实现|coding|编码|fix.*test|修复测试/i },
    { phase: 'run_fail', any: /fail|failed|✗|×|red|失败|error/i, all: /test|spec|测试/i },
  ],
  defaultPhase: 'write_test',

  phaseConfigs: {
    write_test: {
      autoActions: ['继续', '编写测试', '添加断言'],
      checkpoints: [
        '测试是否描述了预期行为',
        '测试是否足够具体',
        '是否覆盖边界情况'
      ],
      autoActionEnabled: true,
      idleTimeout: 30000
    },

    run_fail: {
      autoActions: ['继续', '查看失败原因'],
      checkpoints: [
        '测试是否按预期失败',
        '失败原因是否明确',
        '是否准备好实现'
      ],
      warningPatterns: [/syntax.*error|语法错误/i],
      autoActionEnabled: false,
      requireConfirmation: true,
      idleTimeout: 30000
    },

    implement: {
      autoActions: ['继续', '实现代码', '运行测试'],
      checkpoints: [
        '实现是否最小化',
        '是否只为通过测试',
        '代码是否简洁'
      ],
      autoActionEnabled: true,
      idleTimeout: 30000
    },

    run_pass: {
      autoActions: ['继续', '检查覆盖率', '准备重构'],
      checkpoints: [
        '所有测试是否通过',
        '是否有遗漏的测试',
        '是否需要重构'
      ],
      autoActionEnabled: false,
      requireConfirmation: true,
      idleTimeout: 45000
    },

    refactor: {
      autoActions: ['继续', '重构代码', '运行测试'],
      checkpoints: [
        '重构是否保持测试通过',
        '代码是否更清晰',
        '是否消除重复'
      ],
      warningPatterns: [/fail|failed|error/i],
      autoActionEnabled: true,
      idleTimeout: 30000
    }
  },

  completePattern: /all.*tests.*pass|所有测试通过|100%.*coverage/i,
  completeMessage: 'TDD 循环完成',
  onWarning: {
    needsAction: false,
    actionType: 'error',
    suggestedAction: null,
    message: '测试失败，需要检查',
    requireConfirmation: true
  },
  idlePrefix: 'TDD 开发'
};

class TDDDevelopmentPlugin extends DeclarativePlugin {
  constructor() {
    super(definition);
  }
}

export default TDDDevelopmentPlugin;
