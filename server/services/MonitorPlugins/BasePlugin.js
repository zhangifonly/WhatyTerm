/**
 * 监控策略插件基类
 * 所有监控策略插件都应继承此类
 */
class BasePlugin {
  constructor() {
    // 插件标识
    this.id = 'base';
    this.name = '基础插件';
    this.description = '监控策略基础类';
    this.version = '1.0.0';

    // 项目类型匹配规则（正则表达式数组）
    this.projectPatterns = [];

    // 阶段定义
    this.phases = [
      { id: 'default', name: '默认', priority: 0 }
    ];

    // 默认配置
    this.defaultConfig = {
      autoActionEnabled: true,      // 是否启用自动操作
      requireConfirmation: false,   // 是否需要用户确认
      idleTimeout: 30000,           // 空闲超时（毫秒）
      maxRetries: 3,                // 最大重试次数
    };
  }

  /**
   * 检测项目是否匹配此插件
   * @param {Object} projectContext - 项目上下文
   * @param {string} projectContext.projectPath - 项目路径
   * @param {string} projectContext.projectDesc - 项目描述
   * @param {string} projectContext.workingDir - 工作目录
   * @param {string} projectContext.sessionName - 会话名称
   * @returns {boolean} 是否匹配
   */
  matches(projectContext) {
    if (!projectContext || this.projectPatterns.length === 0) {
      return false;
    }

    const { projectPath, projectDesc, workingDir, sessionName } = projectContext;
    const testStrings = [projectPath, projectDesc, workingDir, sessionName].filter(Boolean);

    return this.projectPatterns.some(pattern =>
      testStrings.some(str => pattern.test(str))
    );
  }

  /**
   * 检测当前开发阶段
   * @param {string} terminalContent - 终端内容
   * @param {Object} projectContext - 项目上下文
   * @returns {string} 阶段 ID
   */
  detectPhase(terminalContent, projectContext) {
    return 'default';
  }

  /**
   * 获取阶段配置
   * @param {string} phase - 阶段 ID
   * @returns {Object} 阶段配置
   */
  getPhaseConfig(phase) {
    return {
      autoActions: ['继续'],
      checkpoints: [],
      warningPatterns: [],
      promptTemplate: '',
      ...this.defaultConfig
    };
  }

  /**
   * 分析终端状态（核心方法）
   * @param {string} terminalContent - 终端内容
   * @param {string} phase - 当前阶段
   * @param {Object} context - 上下文信息
   * @returns {Object|null} 分析结果，null 表示无需操作
   */
  analyzeStatus(terminalContent, phase, context) {
    const config = this.getPhaseConfig(phase);

    // 如果禁用自动操作，直接返回
    if (config.autoActionEnabled === false) {
      return null;
    }

    // 检查警告模式
    for (const pattern of config.warningPatterns || []) {
      if (pattern.test(terminalContent)) {
        return {
          needsAction: true,
          actionType: 'warning',
          suggestedAction: '检测到潜在问题，建议检查',
          phase,
          phaseConfig: config
        };
      }
    }

    // 检查是否空闲（等待输入）
    if (this.isIdle(terminalContent)) {
      return {
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: config.autoActions[0] || '继续',
        phase,
        phaseConfig: config,
        requireConfirmation: config.requireConfirmation
      };
    }

    return null;
  }

  /**
   * 检测终端是否处于空闲状态
   * @param {string} terminalContent - 终端内容
   * @returns {boolean} 是否空闲
   */
  isIdle(terminalContent) {
    // 默认实现：检测常见的输入提示符
    const idlePatterns = [
      />\s*$/,                    // 通用提示符
      /\$\s*$/,                   // Shell 提示符
      />>>\s*$/,                  // Python REPL
      /In \[\d+\]:\s*$/,          // IPython/Jupyter
      /claude>\s*$/i,             // Claude Code 提示符
    ];

    const lastLines = terminalContent.split('\n').slice(-5).join('\n');
    return idlePatterns.some(p => p.test(lastLines));
  }

  /**
   * 生成 AI 分析提示词
   * @param {string} terminalContent - 终端内容
   * @param {string} phase - 当前阶段
   * @param {Object} context - 上下文信息
   * @returns {string} 提示词
   */
  getAnalysisPrompt(terminalContent, phase, context) {
    const config = this.getPhaseConfig(phase);
    const phaseName = this.phases.find(p => p.id === phase)?.name || phase;

    return `
## ${this.name} - ${phaseName}阶段监控

${config.promptTemplate || '请分析当前终端状态。'}

### 检查要点
${config.checkpoints?.map(c => `- ${c}`).join('\n') || '- 检查当前状态是否正常'}

### 可用操作
${config.autoActions?.map(a => `- ${a}`).join('\n') || '- 继续'}

### 终端内容（最后 2000 字符）
\`\`\`
${terminalContent.slice(-2000)}
\`\`\`

请分析当前状态，判断是否需要操作，如需操作请给出具体指令。
`;
  }

  /**
   * 获取建议操作列表
   * @param {Object} status - 状态分析结果
   * @param {string} phase - 当前阶段
   * @returns {Array} 建议操作列表
   */
  getSuggestedActions(status, phase) {
    const config = this.getPhaseConfig(phase);
    return config.autoActions || ['继续'];
  }

  /**
   * 获取插件信息
   * @returns {Object} 插件信息
   */
  getInfo() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      version: this.version,
      phases: this.phases
    };
  }
}

export default BasePlugin;
