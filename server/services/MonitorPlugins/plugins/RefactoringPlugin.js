import BasePlugin from '../BasePlugin.js';
import promptLoader from '../PromptLoader.js';

/**
 * 重构优化监控策略插件
 * 针对代码重构、性能优化、代码简化等场景
 *
 * 核心能力：
 * 1. 智能识别重构阶段
 * 2. 检测代码异味和复杂度问题
 * 3. 确保重构过程安全可控
 * 4. 验证重构效果
 */
class RefactoringPlugin extends BasePlugin {
  constructor() {
    super();
    this.id = 'refactoring';
    this.name = '重构优化';
    this.description = '代码重构和性能优化监控策略，支持分析、设计、实施、验证等阶段';
    this.version = '2.1.0';

    // 匹配规则
    this.projectPatterns = [
      /refactor|重构|优化|simplify|简化/i,
      /performance|性能|速度|内存/i,
      /clean.*code|代码清理|技术债务/i,
      /抽象|abstract|extract|提取/i,
      /code.*smell|代码异味|复杂度/i
    ];

    // 重构阶段
    this.phases = [
      { id: 'analysis', name: '问题分析', priority: 1 },
      { id: 'design', name: '方案设计', priority: 2 },
      { id: 'implementation', name: '重构实施', priority: 3 },
      { id: 'testing', name: '回归测试', priority: 4 },
      { id: 'verification', name: '效果验证', priority: 5 }
    ];

    // 代码异味检测模式
    this.codeSmellPatterns = {
      longMethod: /function.*\{[\s\S]{1000,}\}|def.*:[\s\S]{500,}(?=def|class|$)/,
      duplicateCode: /duplicate|重复代码|copy.*paste/i,
      largeClass: /class.*\{[\s\S]{2000,}\}/,
      longParameterList: /\([^)]{100,}\)/,
      featureEnvy: /feature.*envy|依赖外部/i,
      dataClumps: /data.*clump|数据泥团/i
    };

    // 重构技术
    this.refactoringTechniques = [
      'Extract Method', 'Inline Method', 'Extract Class',
      'Move Method', 'Rename', 'Replace Conditional with Polymorphism',
      'Introduce Parameter Object', 'Preserve Whole Object',
      'Replace Magic Number with Symbolic Constant'
    ];

    // 阶段配置
    this.phaseConfigs = {
      analysis: {
        autoActions: ['继续', '分析代码', '识别问题', '统计复杂度'],
        checkpoints: [
          '是否识别了代码异味',
          '是否分析了圈复杂度',
          '是否确定了重构范围',
          '是否评估了影响范围',
          '是否建立了测试覆盖'
        ],
        warningPatterns: [/complexity.*high|复杂度.*高|smell.*detected/i],
        autoActionEnabled: true,
        idleTimeout: 45000
      },

      design: {
        autoActions: ['继续', '设计方案', '评估风险', '制定计划'],
        checkpoints: [
          '是否有多个重构方案',
          '是否评估了每个方案的风险',
          '是否考虑了向后兼容',
          '是否制定了回滚计划',
          '是否选择了合适的重构技术'
        ],
        warningPatterns: [/risk.*high|风险.*高|breaking.*change/i],
        autoActionEnabled: true,
        idleTimeout: 60000
      },

      implementation: {
        autoActions: ['继续', '小步重构', '运行测试', '提交更改'],
        checkpoints: [
          '是否小步进行重构',
          '每步是否保持测试通过',
          '是否保留原有功能',
          '是否及时提交更改',
          '是否遵循重构模式'
        ],
        warningPatterns: [
          /error|failed|测试失败/i,
          /regression|回归/i,
          /broken|损坏/i
        ],
        autoActionEnabled: true,
        idleTimeout: 30000
      },

      testing: {
        autoActions: ['运行测试', '检查覆盖率', '执行回归测试'],
        checkpoints: [
          '单元测试是否全部通过',
          '集成测试是否通过',
          '是否有回归问题',
          '测试覆盖率是否达标',
          '边界情况是否覆盖'
        ],
        warningPatterns: [
          /failed|error|回归/i,
          /coverage.*low|覆盖率.*低/i
        ],
        autoActionEnabled: false,
        requireConfirmation: true,
        idleTimeout: 60000
      },

      verification: {
        autoActions: ['继续', '对比性能', '生成报告', '确认改进'],
        checkpoints: [
          '性能是否提升',
          '代码质量是否改善',
          '复杂度是否降低',
          '是否达到预期目标',
          '是否有意外副作用'
        ],
        warningPatterns: [/regression|degradation|性能下降/i],
        autoActionEnabled: true,
        idleTimeout: 30000
      }
    };
  }

  matches(projectContext) {
    const { projectPath, projectDesc, workingDir, goal } = projectContext || {};
    const searchText = `${projectPath || ''} ${projectDesc || ''} ${workingDir || ''} ${goal || ''}`;
    return this.projectPatterns.some(p => p.test(searchText));
  }

  detectPhase(terminalContent, projectContext) {
    const lastLines = terminalContent.split('\n').slice(-50).join('\n');
    const goal = projectContext?.goal || '';

    // 效果验证阶段
    if (/benchmark|性能测试|对比|improvement|提升|before.*after|优化前.*优化后/i.test(lastLines) ||
        /step\s*5|效果验证/i.test(goal)) {
      return 'verification';
    }

    // 回归测试阶段
    if (/test|测试|regression|回归|coverage|覆盖率/i.test(lastLines) &&
        !/test.*file|测试文件/i.test(lastLines) ||
        /step\s*4|回归测试/i.test(goal)) {
      return 'testing';
    }

    // 重构实施阶段
    if (/refactoring|重构中|extract|提取|rename|重命名|move|移动|inline|内联/i.test(lastLines) ||
        /step\s*3|重构实施/i.test(goal)) {
      return 'implementation';
    }

    // 方案设计阶段
    if (/design|设计|approach|方案|strategy|策略|plan|计划/i.test(lastLines) ||
        /step\s*2|方案设计/i.test(goal)) {
      return 'design';
    }

    // 问题分析阶段
    if (/analysis|分析|smell|异味|complexity|复杂度|identify|识别/i.test(lastLines) ||
        /step\s*1|问题分析/i.test(goal)) {
      return 'analysis';
    }

    // 默认为问题分析
    return 'analysis';
  }

  getPhaseConfig(phase) {
    const config = this.phaseConfigs[phase] || this.phaseConfigs.analysis;

    // 从文件加载提示词模板
    const promptTemplate = promptLoader.getPrompt(this.id, phase) || '';

    return {
      ...config,
      promptTemplate
    };
  }

  analyzeStatus(terminalContent, phase, context) {
    const config = this.getPhaseConfig(phase);
    const lastLines = terminalContent.split('\n').slice(-30).join('\n');

    // 分析阶段：检测代码异味识别完成
    if (phase === 'analysis') {
      if (/identified|发现.*问题|code.*smell|代码异味/i.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续',
          phase,
          phaseConfig: config,
          message: '代码问题已识别，继续设计重构方案'
        };
      }

      // 检测复杂度分析完成
      if (/complexity.*report|复杂度.*报告|cyclomatic/i.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续',
          phase,
          phaseConfig: config,
          message: '复杂度分析完成，继续下一步'
        };
      }
    }

    // 设计阶段：检测方案确定
    if (phase === 'design') {
      if (/方案.*确定|plan.*ready|设计.*完成/i.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续',
          phase,
          phaseConfig: config,
          message: '重构方案已确定，开始实施'
        };
      }
    }

    // 实施阶段：检测重构步骤完成
    if (phase === 'implementation') {
      // 检测编译/测试错误
      if (/error|Error|ERROR|failed|Failed|FAILED/i.test(lastLines) &&
          !/error handling|on error|catch|no error/i.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'error',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: '重构过程中检测到错误，需要回退或修复',
          requireConfirmation: true
        };
      }

      // 检测重构步骤完成
      if (/refactored|重构.*完成|extract.*done|提取.*完成/i.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续',
          phase,
          phaseConfig: config,
          message: '重构步骤完成，继续下一步'
        };
      }

      // 检测测试通过
      if (/test.*pass|测试通过|all.*green/i.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续',
          phase,
          phaseConfig: config,
          message: '测试通过，可以继续重构'
        };
      }
    }

    // 测试阶段：检测测试结果
    if (phase === 'testing') {
      if (/failed|error|回归|regression/i.test(lastLines) &&
          !/0 failed|no error|no regression/i.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'error',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: '检测到回归问题，需要修复',
          requireConfirmation: true
        };
      }

      if (/all.*pass|全部通过|100%|覆盖率.*达标/i.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续',
          phase,
          phaseConfig: config,
          message: '测试全部通过，可以验证效果'
        };
      }
    }

    // 验证阶段：检测效果确认
    if (phase === 'verification') {
      if (/improvement|提升|improved|改善|优化成功/i.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'success',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: '重构优化完成，效果已验证'
        };
      }

      if (/degradation|性能下降|regression|回归/i.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'error',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: '检测到性能下降，需要分析原因',
          requireConfirmation: true
        };
      }
    }

    // 检测重构完成
    if (/refactor.*complete|重构完成|优化完成/i.test(lastLines)) {
      return {
        needsAction: false,
        actionType: 'success',
        suggestedAction: null,
        phase,
        phaseConfig: config,
        message: '重构优化完成'
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
          message: '检测到问题，需要人工处理',
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
        message: `重构优化 - ${this.phases.find(p => p.id === phase)?.name}: 发送继续指令`
      };
    }

    return null;
  }

  /**
   * 生成 AI 分析提示词
   */
  getAnalysisPrompt(terminalContent, phase, context) {
    const config = this.getPhaseConfig(phase);
    const phaseName = this.phases.find(p => p.id === phase)?.name || '重构';

    return `
## 重构优化监控 - ${phaseName}阶段

${config.promptTemplate}

### 当前阶段信息
- **阶段**: ${phaseName}（${phase}）
- **自动操作**: ${config.autoActionEnabled ? '启用' : '禁用'}
- **需要确认**: ${config.requireConfirmation ? '是' : '否'}

### 重构原则
1. **小步前进**: 每次只做一个小的重构
2. **持续测试**: 每步重构后都要运行测试
3. **安全第一**: 不要在重构时添加新功能
4. **可回退**: 确保每步都可以安全回退

### 检查清单
${config.checkpoints.map((c, i) => `${i + 1}. [ ] ${c}`).join('\n')}

### 可执行操作
${config.autoActions.map(a => `- \`${a}\``).join('\n')}

### 终端内容（最后 3000 字符）
\`\`\`
${terminalContent.slice(-3000)}
\`\`\`

### 分析要求
1. 判断当前重构阶段的任务是否完成
2. 检查是否有测试失败或回归问题
3. 评估重构是否安全进行
4. 如果需要操作，给出具体指令
`;
  }
}

export default RefactoringPlugin;
