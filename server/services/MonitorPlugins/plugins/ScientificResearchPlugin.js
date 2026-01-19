import BasePlugin from '../BasePlugin.js';
import promptLoader from '../PromptLoader.js';

/**
 * 科学研究监控策略插件
 * 针对生物信息学、化学分析、医学研究、数据科学等科研场景
 */
class ScientificResearchPlugin extends BasePlugin {
  constructor() {
    super();
    this.id = 'scientific-research';
    this.name = '科学研究';
    this.description = '科学研究监控策略，支持文献调研、实验设计、数据采集、分析处理、结果验证等阶段';
    this.version = '2.0.0';

    // 匹配规则
    this.projectPatterns = [
      /bioinformatics|生物信息|genomics|基因组/i,
      /chemistry|化学|molecular|分子/i,
      /medical|医学|clinical|临床/i,
      /research|研究|experiment|实验/i,
      /scientific|科学|laboratory|实验室/i,
      /rdkit|biopython|scanpy|pytorch/i,
      /pubmed|arxiv|bioRxiv|chembl/i
    ];

    // 科学研究阶段
    this.phases = [
      { id: 'literature', name: '文献调研', priority: 1 },
      { id: 'design', name: '实验设计', priority: 2 },
      { id: 'collection', name: '数据采集', priority: 3 },
      { id: 'analysis', name: '分析处理', priority: 4 },
      { id: 'validation', name: '结果验证', priority: 5 }
    ];
  }

  matches(projectContext) {
    const { projectPath, projectDesc, workingDir, goal } = projectContext;
    const searchText = `${projectPath || ''} ${projectDesc || ''} ${workingDir || ''} ${goal || ''}`;
    return this.projectPatterns.some(p => p.test(searchText));
  }

  detectPhase(terminalContent, projectContext) {
    const lastLines = terminalContent.split('\n').slice(-40).join('\n');

    // 结果验证阶段
    if (/validation|验证|verify|校验|statistical.*test|统计检验/i.test(lastLines)) {
      return 'validation';
    }

    // 分析处理阶段
    if (/analysis|分析|processing|处理|visualization|可视化|plot|绘图/i.test(lastLines)) {
      return 'analysis';
    }

    // 数据采集阶段
    if (/data.*collect|数据采集|download|下载|fetch|获取|scrape|爬取/i.test(lastLines)) {
      return 'collection';
    }

    // 实验设计阶段
    if (/design|设计|protocol|方案|methodology|方法论|hypothesis|假设/i.test(lastLines)) {
      return 'design';
    }

    // 默认为文献调研
    return 'literature';
  }

  getPhaseConfig(phase) {
    const configs = {
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
    };

    const config = configs[phase] || configs.literature;

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

    // 检测研究完成
    if (/research.*complete|研究完成|analysis.*done|分析完成/i.test(lastLines)) {
      return {
        needsAction: false,
        actionType: 'success',
        suggestedAction: null,
        phase,
        phaseConfig: config,
        message: '科学研究阶段完成'
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
          message: '检测到问题，需要人工检查',
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
        message: `科学研究 - ${this.phases.find(p => p.id === phase)?.name}: 发送继续指令`
      };
    }

    return null;
  }
}

export default ScientificResearchPlugin;
