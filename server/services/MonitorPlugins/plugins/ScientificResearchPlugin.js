import DeclarativePlugin from '../DeclarativePlugin.js';

/**
 * 科学研究监控策略插件
 * 针对生物信息学、化学分析、医学研究、数据科学等科研场景
 *
 * 骨架统一在 DeclarativePlugin，这里只声明数据（原实现逐字等价）。
 */
const definition = {
  id: 'scientific-research',
  name: '科学研究',
  description: '科学研究监控策略，支持文献调研、实验设计、数据采集、分析处理、结果验证等阶段',
  version: '2.0.0',

  projectPatterns: [
    /bioinformatics|生物信息|genomics|基因组/i,
    /chemistry|化学|molecular|分子/i,
    /medical|医学|clinical|临床/i,
    /research|研究|experiment|实验/i,
    /scientific|科学|laboratory|实验室/i,
    /rdkit|biopython|scanpy|pytorch/i,
    /pubmed|arxiv|bioRxiv|chembl/i
  ],

  phases: [
    { id: 'literature', name: '文献调研', priority: 1 },
    { id: 'design', name: '实验设计', priority: 2 },
    { id: 'collection', name: '数据采集', priority: 3 },
    { id: 'analysis', name: '分析处理', priority: 4 },
    { id: 'validation', name: '结果验证', priority: 5 }
  ],

  // 按顺序匹配，命中即返回（顺序与原 detectPhase 的 if 链一致）
  phaseRules: [
    { phase: 'validation', any: /validation|验证|verify|校验|statistical.*test|统计检验/i },
    { phase: 'analysis', any: /analysis|分析|processing|处理|visualization|可视化|plot|绘图/i },
    { phase: 'collection', any: /data.*collect|数据采集|download|下载|fetch|获取|scrape|爬取/i },
    { phase: 'design', any: /design|设计|protocol|方案|methodology|方法论|hypothesis|假设/i },
  ],
  defaultPhase: 'literature',

  phaseConfigs: {
    literature: {
      autoActions: ['继续', '搜索文献', '整理引用'],
      checkpoints: [
        '是否找到相关文献',
        '是否整理了关键发现',
        '是否确定了研究空白'
      ],
      autoActionEnabled: true,
      idleTimeout: 60000
    },

    design: {
      autoActions: ['继续', '完善设计', '确定方法'],
      checkpoints: [
        '是否明确了研究假设',
        '是否确定了实验方法',
        '是否考虑了对照组'
      ],
      autoActionEnabled: true,
      idleTimeout: 45000
    },

    collection: {
      autoActions: ['继续', '采集数据', '检查质量'],
      checkpoints: [
        '数据来源是否可靠',
        '数据格式是否正确',
        '是否有缺失值'
      ],
      warningPatterns: [/error|failed|timeout|超时/i],
      autoActionEnabled: true,
      idleTimeout: 30000
    },

    analysis: {
      autoActions: ['继续', '运行分析', '生成图表'],
      checkpoints: [
        '分析方法是否正确',
        '结果是否合理',
        '图表是否清晰'
      ],
      warningPatterns: [/error|warning|nan|inf/i],
      autoActionEnabled: true,
      idleTimeout: 45000
    },

    validation: {
      autoActions: ['继续验证', '统计检验'],
      checkpoints: [
        '结果是否可重复',
        '统计显著性如何',
        '是否有偏差'
      ],
      warningPatterns: [/p.*>.*0\.05|not.*significant|不显著/i],
      autoActionEnabled: false,
      requireConfirmation: true,
      idleTimeout: 60000
    }
  },

  completePattern: /research.*complete|研究完成|analysis.*done|分析完成/i,
  completeMessage: '科学研究阶段完成',
  onWarning: {
    needsAction: false,
    actionType: 'error',
    suggestedAction: null,
    message: '检测到问题，需要人工检查',
    requireConfirmation: true
  },
  idlePrefix: '科学研究'
};

class ScientificResearchPlugin extends DeclarativePlugin {
  constructor() {
    super(definition);
  }
}

export default ScientificResearchPlugin;
