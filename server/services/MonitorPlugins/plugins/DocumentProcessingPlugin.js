import BasePlugin from '../BasePlugin.js';
import promptLoader from '../PromptLoader.js';

/**
 * 文档处理监控策略插件
 * 针对 Office 文档自动化处理场景
 */
class DocumentProcessingPlugin extends BasePlugin {
  constructor() {
    super();
    this.id = 'document-processing';
    this.name = '文档处理';
    this.description = '文档处理监控策略，支持模板准备、内容生成、格式调整、审核校对、导出发布等阶段';
    this.version = '2.0.0';

    // 匹配规则
    this.projectPatterns = [
      /document.*processing|文档处理/i,
      /\.docx|\.xlsx|\.pptx|\.pdf/i,
      /word|excel|powerpoint|pdf/i,
      /report.*generation|报告生成/i,
      /template|模板|批量生成/i,
      /python-docx|openpyxl|python-pptx/i,
      /pandoc|latex|markdown.*convert/i
    ];

    // 文档处理阶段
    this.phases = [
      { id: 'template', name: '模板准备', priority: 1 },
      { id: 'content', name: '内容生成', priority: 2 },
      { id: 'formatting', name: '格式调整', priority: 3 },
      { id: 'review', name: '审核校对', priority: 4 },
      { id: 'export', name: '导出发布', priority: 5 }
    ];
  }

  matches(projectContext) {
    const { projectPath, projectDesc, workingDir, goal } = projectContext;
    const searchText = `${projectPath || ''} ${projectDesc || ''} ${workingDir || ''} ${goal || ''}`;
    return this.projectPatterns.some(p => p.test(searchText));
  }

  detectPhase(terminalContent, projectContext) {
    const lastLines = terminalContent.split('\n').slice(-40).join('\n');

    // 导出发布阶段
    if (/export|导出|publish|发布|save|保存|output/i.test(lastLines)) {
      return 'export';
    }

    // 审核校对阶段
    if (/review|审核|proofread|校对|check|检查|verify/i.test(lastLines)) {
      return 'review';
    }

    // 格式调整阶段
    if (/format|格式|style|样式|layout|布局|font|字体/i.test(lastLines)) {
      return 'formatting';
    }

    // 内容生成阶段
    if (/content|内容|generate|生成|write|写入|fill|填充/i.test(lastLines)) {
      return 'content';
    }

    // 默认为模板准备
    return 'template';
  }

  getPhaseConfig(phase) {
    const configs = {
      template: {
        autoActions: ['继续', '准备模板', '设置变量'],
        checkpoints: [
          '模板是否完整',
          '变量是否定义',
          '格式是否正确'
        ],
        autoActionEnabled: true,
        idleTimeout: 30000
      },

      content: {
        autoActions: ['继续', '生成内容', '填充数据'],
        checkpoints: [
          '内容是否完整',
          '数据是否正确',
          '是否有遗漏'
        ],
        warningPatterns: [/error|failed|missing|缺失/i],
        autoActionEnabled: true,
        idleTimeout: 30000
      },

      formatting: {
        autoActions: ['继续', '调整格式', '统一样式'],
        checkpoints: [
          '格式是否统一',
          '样式是否一致',
          '排版是否美观'
        ],
        autoActionEnabled: true,
        idleTimeout: 30000
      },

      review: {
        autoActions: ['继续', '检查内容', '修正错误'],
        checkpoints: [
          '内容是否有错误',
          '格式是否正确',
          '是否符合要求'
        ],
        warningPatterns: [/error|typo|错误|拼写/i],
        autoActionEnabled: false,
        requireConfirmation: true,
        idleTimeout: 45000
      },

      export: {
        autoActions: ['继续', '导出文档', '验证输出'],
        checkpoints: [
          '导出是否成功',
          '文件是否完整',
          '格式是否正确'
        ],
        warningPatterns: [/error|failed|corrupt|损坏/i],
        autoActionEnabled: true,
        idleTimeout: 30000
      }
    };

    const config = configs[phase] || configs.template;

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

    // 检测文档处理完成
    if (/document.*complete|文档完成|export.*success|导出成功/i.test(lastLines)) {
      return {
        needsAction: false,
        actionType: 'success',
        suggestedAction: null,
        phase,
        phaseConfig: config,
        message: '文档处理完成'
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
          message: '文档处理错误，需要检查',
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
        message: `文档处理 - ${this.phases.find(p => p.id === phase)?.name}: 发送继续指令`
      };
    }

    return null;
  }
}

export default DocumentProcessingPlugin;
