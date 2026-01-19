import BasePlugin from '../BasePlugin.js';
import promptLoader from '../PromptLoader.js';

/**
 * 计划执行监控策略插件
 * 针对结构化任务规划和执行场景
 */
class PlanExecutionPlugin extends BasePlugin {
  constructor() {
    super();
    this.id = 'plan-execution';
    this.name = '计划执行';
    this.description = '计划执行监控策略，支持头脑风暴、计划编写、任务分解、逐步执行、验证完成等阶段';
    this.version = '2.0.0';

    // 匹配规则
    this.projectPatterns = [
      /plan.*execution|计划执行/i,
      /brainstorm|头脑风暴/i,
      /task.*breakdown|任务分解/i,
      /spec.*workflow|规格工作流/i,
      /project.*plan|项目计划/i,
      /milestone|里程碑|roadmap|路线图/i,
      /todo.*list|待办列表/i
    ];

    // 计划执行阶段
    this.phases = [
      { id: 'brainstorm', name: '头脑风暴', priority: 1 },
      { id: 'planning', name: '计划编写', priority: 2 },
      { id: 'breakdown', name: '任务分解', priority: 3 },
      { id: 'execution', name: '逐步执行', priority: 4 },
      { id: 'verification', name: '验证完成', priority: 5 }
    ];
  }

  matches(projectContext) {
    const { projectPath, projectDesc, workingDir, goal } = projectContext;
    const searchText = `${projectPath || ''} ${projectDesc || ''} ${workingDir || ''} ${goal || ''}`;
    return this.projectPatterns.some(p => p.test(searchText));
  }

  detectPhase(terminalContent, projectContext) {
    const lastLines = terminalContent.split('\n').slice(-40).join('\n');

    // 验证完成阶段
    if (/verify|验证|complete|完成|done|结束|finish/i.test(lastLines)) {
      return 'verification';
    }

    // 逐步执行阶段
    if (/execute|执行|implement|实现|task.*\d|步骤.*\d/i.test(lastLines)) {
      return 'execution';
    }

    // 任务分解阶段
    if (/breakdown|分解|subtask|子任务|step|步骤|atomic/i.test(lastLines)) {
      return 'breakdown';
    }

    // 计划编写阶段
    if (/plan|计划|design|设计|architecture|架构|spec/i.test(lastLines)) {
      return 'planning';
    }

    // 默认为头脑风暴
    return 'brainstorm';
  }

  getPhaseConfig(phase) {
    const configs = {
      brainstorm: {
        autoActions: ['继续', '发散思考', '收集想法'],
        checkpoints: [
          '是否收集了足够的想法',
          '是否考虑了多种方案',
          '是否有创新点'
        ],
        autoActionEnabled: true,
        idleTimeout: 60000
      },

      planning: {
        autoActions: ['继续', '编写计划', '确定目标'],
        checkpoints: [
          '目标是否明确',
          '计划是否可行',
          '是否有时间节点'
        ],
        autoActionEnabled: true,
        idleTimeout: 45000
      },

      breakdown: {
        autoActions: ['继续', '分解任务', '确定依赖'],
        checkpoints: [
          '任务是否足够小',
          '依赖关系是否清晰',
          '是否可独立执行'
        ],
        autoActionEnabled: true,
        idleTimeout: 30000
      },

      execution: {
        autoActions: ['继续', '执行任务', '检查进度'],
        checkpoints: [
          '当前任务是否完成',
          '是否遇到阻碍',
          '进度是否正常'
        ],
        warningPatterns: [/blocked|阻塞|stuck|卡住|error|failed/i],
        autoActionEnabled: true,
        idleTimeout: 30000
      },

      verification: {
        autoActions: ['继续', '验证结果', '总结经验'],
        checkpoints: [
          '所有任务是否完成',
          '结果是否符合预期',
          '是否有遗漏'
        ],
        autoActionEnabled: false,
        requireConfirmation: true,
        idleTimeout: 45000
      }
    };

    const config = configs[phase] || configs.brainstorm;

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

    // 检测计划执行完成
    if (/plan.*complete|计划完成|all.*tasks.*done|所有任务完成/i.test(lastLines)) {
      return {
        needsAction: false,
        actionType: 'success',
        suggestedAction: null,
        phase,
        phaseConfig: config,
        message: '计划执行完成'
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
          message: '执行遇到问题，需要处理',
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
        message: `计划执行 - ${this.phases.find(p => p.id === phase)?.name}: 发送继续指令`
      };
    }

    return null;
  }
}

export default PlanExecutionPlugin;
