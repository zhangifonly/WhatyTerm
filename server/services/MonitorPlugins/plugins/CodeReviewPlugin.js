import BasePlugin from '../BasePlugin.js';
import promptLoader from '../PromptLoader.js';

/**
 * 代码审查监控策略插件
 * 针对 PR 审查、代码质量检查等场景
 */
class CodeReviewPlugin extends BasePlugin {
  constructor() {
    super();
    this.id = 'code-review';
    this.name = '代码审查';
    this.description = 'PR 审查和代码质量检查监控策略，支持审查准备、问题分析、修复验证等阶段';
    this.version = '2.1.0';

    // 匹配规则
    this.projectPatterns = [
      /code.*review|pr.*review|pull.*request/i,
      /审查|review|检查代码/,
      /git.*diff|git.*log/i,
      /CLAUDE\.md|代码规范/i
    ];

    // 代码审查阶段
    this.phases = [
      { id: 'preparation', name: '审查准备', priority: 1 },
      { id: 'analysis', name: '代码分析', priority: 2 },
      { id: 'comments', name: '评论反馈', priority: 3 },
      { id: 'tests', name: '测试检查', priority: 4 },
      { id: 'fixing', name: '问题修复', priority: 5 }
    ];

    // 阶段配置
    this.phaseConfigs = {
      preparation: {
        autoActions: ['继续', '获取 PR 信息', '查看变更'],
        checkpoints: [
          '是否获取了 PR 信息',
          '是否查看了变更文件',
          '是否了解项目代码规范',
          '是否确定了审查重点'
        ],
        warningPatterns: [],
        autoActionEnabled: true,
        idleTimeout: 30000
      },
      analysis: {
        autoActions: ['继续分析', '标记问题', '查看详情'],
        checkpoints: [
          '是否检查了功能正确性',
          '是否检查了代码质量',
          '是否检查了安全问题',
          '是否检查了性能问题'
        ],
        warningPatterns: [/bug|error|violation|问题|vulnerability/i],
        autoActionEnabled: true,
        idleTimeout: 45000
      },
      comments: {
        autoActions: ['继续', '添加评论', '提交反馈'],
        checkpoints: [
          '评论是否建设性',
          '是否提供了具体建议',
          '是否标注了严重程度',
          '是否有正面反馈'
        ],
        warningPatterns: [],
        autoActionEnabled: true,
        idleTimeout: 30000
      },
      tests: {
        autoActions: ['继续', '检查测试覆盖', '运行测试'],
        checkpoints: [
          '测试覆盖率是否足够',
          '是否覆盖边界情况',
          '测试质量是否良好',
          '是否有不稳定的测试'
        ],
        warningPatterns: [/test.*fail|coverage.*low|测试失败/i],
        autoActionEnabled: true,
        idleTimeout: 30000
      },
      fixing: {
        autoActions: ['继续', '验证修复', '重新审查'],
        checkpoints: [
          '问题是否已修复',
          '修复是否引入新问题',
          '测试是否通过',
          '是否符合代码规范'
        ],
        warningPatterns: [],
        autoActionEnabled: false,
        requireConfirmation: true,
        idleTimeout: 30000
      }
    };
  }

  matches(projectContext) {
    const { projectPath, projectDesc, workingDir, goal } = projectContext;
    const searchText = `${projectPath || ''} ${projectDesc || ''} ${workingDir || ''} ${goal || ''}`;
    return this.projectPatterns.some(p => p.test(searchText));
  }

  detectPhase(terminalContent, projectContext) {
    const lastLines = terminalContent.split('\n').slice(-40).join('\n');

    // 修复验证阶段
    if (/fix|修复|resolved|已解决|commit.*fix/i.test(lastLines)) {
      return 'fixing';
    }

    // 测试检查阶段
    if (/test.*coverage|测试覆盖|npm test|jest|pytest/i.test(lastLines)) {
      return 'tests';
    }

    // 评论反馈阶段
    if (/comment|评论|feedback|反馈|review.*comment/i.test(lastLines)) {
      return 'comments';
    }

    // 代码分析阶段
    if (/issue|bug|problem|问题|violation|diff|变更/i.test(lastLines)) {
      return 'analysis';
    }

    // 默认为审查准备
    return 'preparation';
  }

  getPhaseConfig(phase) {
    const config = this.phaseConfigs[phase] || this.phaseConfigs.preparation;

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

    // 检测审查完成
    if (/review.*complete|审查完成|no.*issues|无问题|LGTM/i.test(lastLines)) {
      return {
        needsAction: false,
        actionType: 'success',
        suggestedAction: null,
        phase,
        phaseConfig: config,
        message: '代码审查完成'
      };
    }

    // 检查警告模式
    for (const pattern of config.warningPatterns || []) {
      if (pattern.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'warning',
          suggestedAction: '发现问题，建议检查',
          phase,
          phaseConfig: config
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
        message: `代码审查 - ${this.phases.find(p => p.id === phase)?.name}: 发送继续指令`
      };
    }

    return null;
  }

  /**
   * 生成 AI 分析提示词
   */
  getAnalysisPrompt(terminalContent, phase, context) {
    const config = this.getPhaseConfig(phase);
    const phaseName = this.phases.find(p => p.id === phase)?.name || '审查';

    return `
## 代码审查监控 - ${phaseName}阶段

${config.promptTemplate}

### 当前阶段信息
- **阶段**: ${phaseName}（${phase}）
- **自动操作**: ${config.autoActionEnabled ? '启用' : '禁用'}
- **需要确认**: ${config.requireConfirmation ? '是' : '否'}

### 检查清单
${config.checkpoints.map((c, i) => `${i + 1}. [ ] ${c}`).join('\n')}

### 可执行操作
${config.autoActions.map(a => `- \`${a}\``).join('\n')}

### 终端内容（最后 2500 字符）
\`\`\`
${terminalContent.slice(-2500)}
\`\`\`

### 分析要求
1. 判断当前审查阶段的进展
2. 检查是否发现代码问题
3. 如果需要操作，给出具体指令
4. 提供审查建议
`;
  }
}

export default CodeReviewPlugin;
