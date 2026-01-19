import BasePlugin from '../BasePlugin.js';
import promptLoader from '../PromptLoader.js';

/**
 * Bug 修复监控策略插件
 * 针对 bug 调试、问题排查、修复验证等场景
 *
 * 核心能力：
 * 1. 系统化的 bug 排查流程
 * 2. 专业的调试技术指导
 * 3. 根因分析方法论
 * 4. 修复验证和预防措施
 */
class BugFixPlugin extends BasePlugin {
  constructor() {
    super();
    this.id = 'bug-fix';
    this.name = 'Bug 修复';
    this.description = 'Bug 调试和修复监控策略，支持问题复现、原因分析、修复实施、验证测试等阶段';
    this.version = '2.1.0';

    // 匹配规则
    this.projectPatterns = [
      /bug|fix|修复|debug|调试/i,
      /issue|问题|error|错误/i,
      /crash|崩溃|exception|异常/i,
      /排查|troubleshoot|diagnose/i
    ];

    // Bug 修复阶段
    this.phases = [
      { id: 'reproduce', name: '问题复现', priority: 1 },
      { id: 'analysis', name: '原因分析', priority: 2 },
      { id: 'fixing', name: '修复实施', priority: 3 },
      { id: 'testing', name: '验证测试', priority: 4 },
      { id: 'prevention', name: '预防措施', priority: 5 }
    ];

    // 常见 bug 类型及调试方法
    this.bugTypes = {
      nullReference: {
        pattern: /null|undefined|NoneType|nil/i,
        description: '空引用错误',
        debugTips: [
          '检查变量初始化',
          '添加空值检查',
          '使用可选链操作符 (?.) ',
          '检查 API 返回值'
        ]
      },
      typeError: {
        pattern: /TypeError|类型错误|type mismatch/i,
        description: '类型错误',
        debugTips: [
          '检查变量类型',
          '使用 typeof/instanceof 验证',
          '检查函数参数类型',
          '添加类型转换'
        ]
      },
      asyncError: {
        pattern: /Promise|async|await|callback|异步/i,
        description: '异步错误',
        debugTips: [
          '检查 Promise 链',
          '确保 await 正确使用',
          '检查回调函数执行顺序',
          '添加错误处理 catch'
        ]
      },
      stateError: {
        pattern: /state|状态|race condition|竞态/i,
        description: '状态错误',
        debugTips: [
          '检查状态更新时机',
          '使用状态管理工具调试',
          '检查组件生命周期',
          '避免直接修改状态'
        ]
      },
      networkError: {
        pattern: /network|网络|fetch|axios|request|CORS/i,
        description: '网络错误',
        debugTips: [
          '检查网络连接',
          '验证 API 地址',
          '检查 CORS 配置',
          '查看请求/响应详情'
        ]
      }
    };

    // 阶段配置（不含提示词模板）
    this.phaseConfigs = {
      reproduce: {
        autoActions: ['继续', '复现问题', '收集信息'],
        checkpoints: [
          '是否能稳定复现（每次都能触发）',
          '是否记录了详细的复现步骤',
          '是否收集了完整的错误信息',
          '是否确定了触发条件和环境'
        ],
        warningPatterns: [],
        autoActionEnabled: true,
        idleTimeout: 45000
      },
      analysis: {
        autoActions: ['继续', '分析原因', '查看日志'],
        checkpoints: [
          '是否找到了根本原因（不是表面现象）',
          '是否理解了问题发生的机制',
          '是否确定了影响范围',
          '是否排除了其他可能原因'
        ],
        warningPatterns: [],
        autoActionEnabled: true,
        idleTimeout: 60000
      },
      fixing: {
        autoActions: ['继续', '实施修复', '检查副作用'],
        checkpoints: [
          '修复是否针对根本原因（而非绕过问题）',
          '修复是否有副作用',
          '修复是否保持向后兼容',
          '修复代码是否符合规范'
        ],
        warningPatterns: [/error|failed|新问题|regression/i],
        autoActionEnabled: true,
        idleTimeout: 30000
      },
      testing: {
        autoActions: ['继续测试', '验证修复'],
        checkpoints: [
          '原问题是否已解决',
          '是否引入了新问题',
          '相关功能是否正常',
          '边界情况是否处理'
        ],
        warningPatterns: [/failed|error|仍然存在|still|regression/i],
        autoActionEnabled: false,
        requireConfirmation: true,
        idleTimeout: 60000
      },
      prevention: {
        autoActions: ['继续', '添加测试', '更新文档'],
        checkpoints: [
          '是否添加了回归测试用例',
          '是否更新了相关文档',
          '是否有预防类似问题的措施',
          '是否总结了经验教训'
        ],
        warningPatterns: [],
        autoActionEnabled: true,
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

    // 预防措施阶段
    if (/prevent|预防|regression.*test|回归测试|add.*test|添加.*测试/i.test(lastLines)) {
      return 'prevention';
    }

    // 验证测试阶段
    if (/verify|验证|test.*pass|测试通过|confirm.*fix|确认.*修复/i.test(lastLines)) {
      return 'testing';
    }

    // 修复实施阶段
    if (/fix|修复|patch|补丁|change|修改|implement|实现/i.test(lastLines)) {
      return 'fixing';
    }

    // 原因分析阶段
    if (/cause|原因|root.*cause|根因|why|为什么|stack.*trace|堆栈|debug|调试/i.test(lastLines)) {
      return 'analysis';
    }

    // 默认为问题复现
    return 'reproduce';
  }

  getPhaseConfig(phase) {
    const config = this.phaseConfigs[phase] || this.phaseConfigs.reproduce;

    // 从文件加载提示词模板
    const promptTemplate = promptLoader.getPrompt(this.id, phase) || '';

    return {
      ...config,
      promptTemplate
    };
  }

  /**
   * 分析 bug 类型
   */
  analyzeBugType(content) {
    for (const [type, info] of Object.entries(this.bugTypes)) {
      if (info.pattern.test(content)) {
        return {
          type,
          description: info.description,
          debugTips: info.debugTips
        };
      }
    }
    return null;
  }

  analyzeStatus(terminalContent, phase, context) {
    const config = this.getPhaseConfig(phase);
    const lastLines = terminalContent.split('\n').slice(-20).join('\n');

    // 检测修复完成
    if (/bug.*fixed|修复完成|问题解决|issue.*resolved/i.test(lastLines)) {
      return {
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: '继续',
        phase,
        phaseConfig: config,
        message: 'Bug 修复完成，进入下一阶段'
      };
    }

    // 检查警告模式
    for (const pattern of config.warningPatterns || []) {
      if (pattern.test(lastLines)) {
        const bugType = this.analyzeBugType(lastLines);
        return {
          needsAction: false,
          actionType: 'error',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: bugType
            ? `检测到 ${bugType.description}，建议：${bugType.debugTips[0]}`
            : '检测到问题，需要人工处理',
          bugType,
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
        message: `Bug 修复 - ${this.phases.find(p => p.id === phase)?.name}: 发送继续指令`
      };
    }

    return null;
  }

  getAnalysisPrompt(terminalContent, phase, context) {
    const config = this.getPhaseConfig(phase);
    const phaseName = this.phases.find(p => p.id === phase)?.name || '调试';
    const bugType = this.analyzeBugType(terminalContent);

    // 加载通用错误处理指南
    const errorHandlingGuide = promptLoader.loadCommon('error-handling') || '';

    let prompt = `
## Bug 修复监控 - ${phaseName}阶段

${config.promptTemplate}

### 当前阶段信息
- **阶段**: ${phaseName}
- **自动操作**: ${config.autoActionEnabled ? '启用' : '禁用'}
- **需要确认**: ${config.requireConfirmation ? '是' : '否'}
`;

    if (bugType) {
      prompt += `
### 检测到的问题类型
- **类型**: ${bugType.description}
- **调试建议**:
${bugType.debugTips.map((tip, i) => `  ${i + 1}. ${tip}`).join('\n')}
`;
    }

    prompt += `
### 检查清单
${config.checkpoints.map((c, i) => `${i + 1}. [ ] ${c}`).join('\n')}

### 可执行操作
${config.autoActions.map(a => `- \`${a}\``).join('\n')}

### 终端内容（最后 2500 字符）
\`\`\`
${terminalContent.slice(-2500)}
\`\`\`

### 分析要求
1. 判断当前阶段的任务进展
2. 如果有错误，分析错误类型和原因
3. 提供具体的调试建议
4. 如果需要操作，给出具体指令
`;

    return prompt;
  }
}

export default BugFixPlugin;
