import BasePlugin from '../BasePlugin.js';
import promptLoader from '../PromptLoader.js';

/**
 * 论文写作监控策略插件
 * 针对学术论文、毕业设计等写作项目的专业监控策略
 */
class PaperWritingPlugin extends BasePlugin {
  constructor() {
    super();
    this.id = 'paper-writing';
    this.name = '论文写作';
    this.description = '学术论文写作监控策略，支持大纲规划、文献调研、正文撰写、修改润色等阶段';
    this.version = '2.1.0';

    // 匹配规则：检测论文相关项目
    this.projectPatterns = [
      /paper|thesis|dissertation|manuscript/i,
      /\.tex$|\.bib$|overleaf|latex/i,
      /论文|毕业设计|学术|期刊|投稿/,
      /paperflow|academic|research/i
    ];

    // 论文写作阶段
    this.phases = [
      { id: 'outline', name: '大纲规划', priority: 1 },
      { id: 'literature', name: '文献研究', priority: 2 },
      { id: 'writing', name: '内容撰写', priority: 3 },
      { id: 'revision', name: '修改润色', priority: 4 },
      { id: 'formatting', name: '格式排版', priority: 5 }
    ];

    // 阶段配置
    this.phaseConfigs = {
      outline: {
        autoActions: ['继续完善大纲', '添加子章节', '调整结构'],
        checkpoints: [
          '章节结构是否完整',
          '逻辑是否清晰',
          '是否覆盖所有要点',
          '层次是否合理'
        ],
        warningPatterns: [/章节过多|结构混乱|层次不清/],
        autoActionEnabled: true,
        idleTimeout: 60000
      },
      literature: {
        autoActions: ['继续搜索文献', '整理引用', '添加参考文献'],
        checkpoints: [
          '引用格式是否正确',
          '文献是否相关且权威',
          '是否有最新研究',
          '引用数量是否充足'
        ],
        warningPatterns: [/引用格式错误|citation error|文献过旧|outdated/i],
        autoActionEnabled: true,
        idleTimeout: 45000
      },
      writing: {
        autoActions: ['继续', '扩展当前段落', '完善论述'],
        checkpoints: [
          '论述是否充分',
          '过渡是否自然',
          '语言是否学术化',
          '是否有数据支撑'
        ],
        warningPatterns: [/语法错误|grammar|拼写错误|spelling/i],
        autoActionEnabled: true,
        idleTimeout: 30000
      },
      revision: {
        autoActions: ['继续修改', '检查语法', '优化表达'],
        checkpoints: [
          '语法是否正确',
          '表述是否准确',
          '是否有重复内容',
          '逻辑是否通顺'
        ],
        warningPatterns: [/语法错误|表述不清|逻辑混乱/],
        autoActionEnabled: true,
        idleTimeout: 45000
      },
      formatting: {
        autoActions: ['继续排版', '检查格式', '编译文档'],
        checkpoints: [
          '格式是否统一',
          '图表是否清晰',
          '页眉页脚是否正确',
          '目录是否更新'
        ],
        warningPatterns: [/编译错误|compilation error|格式警告|warning/i],
        autoActionEnabled: false,
        requireConfirmation: true,
        idleTimeout: 120000
      }
    };
  }

  /**
   * 检测当前阶段
   */
  detectPhase(terminalContent, projectContext) {
    const lastLines = terminalContent.split('\n').slice(-30).join('\n');

    // 大纲规划阶段
    if (/outline|大纲|structure|框架|章节|section|目录|toc/i.test(lastLines)) {
      return 'outline';
    }

    // 文献调研阶段
    if (/reference|citation|文献|引用|bibliography|cite|doi|arxiv|pubmed/i.test(lastLines)) {
      return 'literature';
    }

    // 修改润色阶段
    if (/revision|修改|polish|润色|refine|improve|rewrite|重写/i.test(lastLines)) {
      return 'revision';
    }

    // 格式排版阶段
    if (/format|latex|bibtex|排版|compile|pdflatex|xelatex|编译/i.test(lastLines)) {
      return 'formatting';
    }

    // 默认为正文撰写阶段
    return 'writing';
  }

  /**
   * 获取阶段配置
   */
  getPhaseConfig(phase) {
    const config = this.phaseConfigs[phase] || this.phaseConfigs.writing;

    // 从文件加载提示词模板
    const promptTemplate = promptLoader.getPrompt(this.id, phase) || '';

    return {
      ...config,
      promptTemplate
    };
  }

  /**
   * 分析终端状态
   */
  analyzeStatus(terminalContent, phase, context) {
    const config = this.getPhaseConfig(phase);

    // 检查警告模式
    for (const pattern of config.warningPatterns || []) {
      if (pattern.test(terminalContent)) {
        return {
          needsAction: true,
          actionType: 'warning',
          suggestedAction: '检测到潜在问题，建议检查',
          phase,
          phaseConfig: config,
          message: `论文写作 - ${this.phases.find(p => p.id === phase)?.name}: 检测到警告`
        };
      }
    }

    // 格式排版阶段：检测编译错误
    if (phase === 'formatting') {
      if (/error|failed|fatal/i.test(terminalContent) &&
          /latex|compile|build/i.test(terminalContent)) {
        return {
          needsAction: false,
          actionType: 'error',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: '检测到 LaTeX 编译错误，需要人工处理',
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
        message: `论文写作 - ${this.phases.find(p => p.id === phase)?.name}: 发送继续指令`,
        requireConfirmation: config.requireConfirmation
      };
    }

    return null;
  }

  /**
   * 生成 AI 分析提示词
   */
  getAnalysisPrompt(terminalContent, phase, context) {
    const config = this.getPhaseConfig(phase);
    const phaseName = this.phases.find(p => p.id === phase)?.name || '撰写';

    return `
## 论文写作监控 - ${phaseName}阶段

${config.promptTemplate}

### 当前阶段信息
- **阶段**: ${phaseName}（${phase}）
- **自动操作**: ${config.autoActionEnabled ? '启用' : '禁用'}
- **需要确认**: ${config.requireConfirmation ? '是' : '否'}

### 检查清单
${config.checkpoints.map((c, i) => `${i + 1}. [ ] ${c}`).join('\n')}

### 可执行操作
${config.autoActions.map(a => `- \`${a}\``).join('\n')}

### 终端内容（最后 2000 字符）
\`\`\`
${terminalContent.slice(-2000)}
\`\`\`

### 分析要求
1. 判断当前论文写作的具体环节
2. 检查是否有需要注意的问题
3. 如果需要操作，给出具体指令
4. 如果发现问题，提供改进建议
`;
  }
}

export default PaperWritingPlugin;
