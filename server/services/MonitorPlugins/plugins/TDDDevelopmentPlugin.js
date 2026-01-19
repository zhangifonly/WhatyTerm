import BasePlugin from '../BasePlugin.js';
import promptLoader from '../PromptLoader.js';

/**
 * TDD 开发监控策略插件
 * 针对测试驱动开发场景
 */
class TDDDevelopmentPlugin extends BasePlugin {
  constructor() {
    super();
    this.id = 'tdd-development';
    this.name = 'TDD 开发';
    this.description = '测试驱动开发监控策略，支持编写测试、运行失败、实现代码、测试通过、重构等阶段';
    this.version = '2.0.0';

    // 匹配规则
    this.projectPatterns = [
      /tdd|test.*driven|测试驱动/i,
      /jest|mocha|pytest|rspec|junit/i,
      /\.test\.|\.spec\.|_test\.|_spec\./i,
      /red.*green.*refactor/i,
      /unit.*test|单元测试/i
    ];

    // TDD 阶段（红-绿-重构循环）
    this.phases = [
      { id: 'write_test', name: '编写测试', priority: 1 },
      { id: 'run_fail', name: '运行失败', priority: 2 },
      { id: 'implement', name: '实现代码', priority: 3 },
      { id: 'run_pass', name: '测试通过', priority: 4 },
      { id: 'refactor', name: '重构优化', priority: 5 }
    ];
  }

  matches(projectContext) {
    const { projectPath, projectDesc, workingDir, goal } = projectContext;
    const searchText = `${projectPath || ''} ${projectDesc || ''} ${workingDir || ''} ${goal || ''}`;
    return this.projectPatterns.some(p => p.test(searchText));
  }

  detectPhase(terminalContent, projectContext) {
    const lastLines = terminalContent.split('\n').slice(-40).join('\n');

    // 重构阶段
    if (/refactor|重构|clean.*up|优化|extract|提取/i.test(lastLines)) {
      return 'refactor';
    }

    // 测试通过阶段
    if (/pass|passed|✓|√|green|通过|success/i.test(lastLines) &&
        /test|spec|测试/i.test(lastLines)) {
      return 'run_pass';
    }

    // 实现代码阶段
    if (/implement|实现|coding|编码|fix.*test|修复测试/i.test(lastLines)) {
      return 'implement';
    }

    // 运行失败阶段
    if (/fail|failed|✗|×|red|失败|error/i.test(lastLines) &&
        /test|spec|测试/i.test(lastLines)) {
      return 'run_fail';
    }

    // 默认为编写测试
    return 'write_test';
  }

  getPhaseConfig(phase) {
    const configs = {
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
    };

    const config = configs[phase] || configs.write_test;

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

    // 检测 TDD 循环完成
    if (/all.*tests.*pass|所有测试通过|100%.*coverage/i.test(lastLines)) {
      return {
        needsAction: false,
        actionType: 'success',
        suggestedAction: null,
        phase,
        phaseConfig: config,
        message: 'TDD 循环完成'
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
          message: '测试失败，需要检查',
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
        message: `TDD 开发 - ${this.phases.find(p => p.id === phase)?.name}: 发送继续指令`
      };
    }

    return null;
  }
}

export default TDDDevelopmentPlugin;
