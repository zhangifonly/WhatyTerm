import DeclarativePlugin from '../DeclarativePlugin.js';

/**
 * 计划执行监控策略插件
 * 针对结构化任务规划和执行场景
 *
 * 骨架统一在 DeclarativePlugin，这里只声明数据（原实现逐字等价）。
 */
const definition = {
  id: 'plan-execution',
  name: '计划执行',
  description: '计划执行监控策略，支持头脑风暴、计划编写、任务分解、逐步执行、验证完成等阶段',
  version: '2.0.0',

  projectPatterns: [
    /plan.*execution|计划执行/i,
    /brainstorm|头脑风暴/i,
    /task.*breakdown|任务分解/i,
    /spec.*workflow|规格工作流/i,
    /project.*plan|项目计划/i,
    /milestone|里程碑|roadmap|路线图/i,
    /todo.*list|待办列表/i
  ],

  phases: [
    { id: 'brainstorm', name: '头脑风暴', priority: 1 },
    { id: 'planning', name: '计划编写', priority: 2 },
    { id: 'breakdown', name: '任务分解', priority: 3 },
    { id: 'execution', name: '逐步执行', priority: 4 },
    { id: 'verification', name: '验证完成', priority: 5 }
  ],

  // 按顺序匹配，命中即返回（顺序与原 detectPhase 的 if 链一致）
  phaseRules: [
    { phase: 'verification', any: /verify|验证|complete|完成|done|结束|finish/i },
    { phase: 'execution', any: /execute|执行|implement|实现|task.*\d|步骤.*\d/i },
    { phase: 'breakdown', any: /breakdown|分解|subtask|子任务|step|步骤|atomic/i },
    { phase: 'planning', any: /plan|计划|design|设计|architecture|架构|spec/i },
  ],
  defaultPhase: 'brainstorm',

  phaseConfigs: {
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
  },

  completePattern: /plan.*complete|计划完成|all.*tasks.*done|所有任务完成/i,
  completeMessage: '计划执行完成',
  onWarning: {
    needsAction: false,
    actionType: 'error',
    suggestedAction: null,
    message: '执行遇到问题，需要处理',
    requireConfirmation: true
  },
  idlePrefix: '计划执行'
};

class PlanExecutionPlugin extends DeclarativePlugin {
  constructor() {
    super(definition);
  }
}

export default PlanExecutionPlugin;
