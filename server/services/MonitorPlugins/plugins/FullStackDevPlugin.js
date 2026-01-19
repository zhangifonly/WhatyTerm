import BasePlugin from '../BasePlugin.js';
import promptLoader from '../PromptLoader.js';

/**
 * 全栈开发监控策略插件
 * 针对完整软件开发流程：需求 → 设计 → 计划 → 开发 → 测试
 *
 * 核心能力：
 * 1. 智能识别开发阶段
 * 2. 提供阶段性专业指导
 * 3. 确保开发流程规范化
 * 4. 质量检查和最佳实践
 */
class FullStackDevPlugin extends BasePlugin {
  constructor() {
    super();
    this.id = 'fullstack-dev';
    this.name = '全栈开发';
    this.description = '完整软件开发流程监控策略，支持需求文档、技术方案、任务计划、编码开发、测试归档等阶段';
    this.version = '2.1.0';

    // 匹配规则：检测全栈开发项目
    this.projectPatterns = [
      /fullstack|全栈|完整开发/i,
      /需求文档|技术方案|开发计划/,
      /shadcn|radix|tailwind/i,
      /sqlite|prisma|drizzle/i,
      /next\.?js|nuxt|remix/i,
      /react|vue|angular/i,
      // 通用 Web 开发关键词
      /web.*app|web.*应用|网页.*应用/i,
      /前端|后端|frontend|backend/i,
      /api|接口|服务端/i,
      /数据库|database|mongodb|mysql|postgres/i,
      // 项目类型关键词
      /系统|平台|门户|portal|system/i,
      /管理|dashboard|admin/i
    ];

    // 全栈开发阶段
    this.phases = [
      { id: 'requirements', name: '需求文档', priority: 1 },
      { id: 'design', name: '技术方案', priority: 2 },
      { id: 'planning', name: '任务计划', priority: 3 },
      { id: 'development', name: '编码开发', priority: 4 },
      { id: 'testing', name: '测试归档', priority: 5 }
    ];

    // 代码质量检查规则
    this.qualityRules = {
      naming: {
        description: '命名规范',
        checks: [
          '变量名使用 camelCase',
          '组件名使用 PascalCase',
          '常量使用 UPPER_SNAKE_CASE',
          '文件名与导出内容一致'
        ]
      },
      structure: {
        description: '代码结构',
        checks: [
          '单一职责原则',
          '函数不超过 50 行',
          '文件不超过 300 行',
          '避免深层嵌套（最多 3 层）'
        ]
      },
      security: {
        description: '安全检查',
        checks: [
          '用户输入需要验证和转义',
          '敏感信息不硬编码',
          'API 调用需要错误处理',
          '避免 SQL 注入和 XSS'
        ]
      }
    };

    // 阶段配置
    this.phaseConfigs = {
      requirements: {
        autoActions: ['继续', '完善需求', '保存文档'],
        checkpoints: [
          '需求是否完整清晰，无歧义',
          '功能点是否明确，可量化',
          '是否保存到 docs/需求文档.md',
          '是否包含用户场景和用例',
          '是否定义了验收标准',
          '是否考虑了边界情况'
        ],
        warningPatterns: [/需求不明确|功能缺失|歧义/i],
        autoActionEnabled: true,
        idleTimeout: 60000
      },
      design: {
        autoActions: ['继续', '完善方案', '保存文档'],
        checkpoints: [
          '技术选型是否合理，有依据',
          '是否使用 shadcn/ui + Radix + Tailwind',
          'CDN 是否使用国内可访问的源',
          '数据库是否使用 sqlite3（或其他合适方案）',
          '是否考虑了可扩展性和维护性',
          '是否保存到 docs/技术方案.md'
        ],
        warningPatterns: [/技术方案.*不完整|架构.*问题/i],
        autoActionEnabled: true,
        idleTimeout: 60000
      },
      planning: {
        autoActions: ['继续', '细化任务', '保存计划'],
        checkpoints: [
          '是否从用户视角思考功能需求',
          '是否以产品经理视角规划界面',
          '是否以设计师视角设计原型',
          '是否使用 FontAwesome 等开源图标',
          '是否使用 Tailwind CSS 样式',
          '是否包含渐变、高光、阴影等视觉效果',
          '图片是否使用 unsplash',
          '是否包含 mock 数据',
          '任务初始状态是否为"待完成"'
        ],
        warningPatterns: [/计划.*不完整|任务.*缺失/i],
        autoActionEnabled: true,
        idleTimeout: 90000
      },
      development: {
        autoActions: ['继续', '完成当前任务', '更新进度'],
        checkpoints: [
          '是否严格按照实施计划执行',
          '是否制定了 todolist 跟踪进度',
          '完成任务后是否标记完成',
          '代码是否符合技术方案要求',
          '是否包含 mock 数据',
          '代码是否符合命名规范',
          '是否有适当的错误处理',
          '是否避免了安全漏洞'
        ],
        warningPatterns: [
          /error|failed|错误|失败/i,
          /任务.*跳过|未完成/i
        ],
        autoActionEnabled: true,
        idleTimeout: 45000
      },
      testing: {
        autoActions: ['继续测试', '修复 bug', '更新测试状态'],
        checkpoints: [
          '是否制定测试计划',
          '是否编写测试用例',
          '是否制定 todolist 跟踪测试进度',
          '完成测试后是否标记完成',
          '遇到 bug 是否修复而非跳过',
          '是否覆盖了边界情况',
          '是否进行了回归测试'
        ],
        warningPatterns: [
          /bug|error|failed|测试失败/i,
          /跳过.*bug|忽略.*错误/i
        ],
        autoActionEnabled: false,
        requireConfirmation: true,
        idleTimeout: 60000
      }
    };
  }

  /**
   * 检测是否匹配此插件
   */
  matches(projectContext) {
    const { projectPath, projectDesc, workingDir, goal } = projectContext || {};
    const searchText = `${projectPath || ''} ${projectDesc || ''} ${workingDir || ''} ${goal || ''}`;
    return this.projectPatterns.some(p => p.test(searchText));
  }

  /**
   * 检测当前阶段
   */
  detectPhase(terminalContent, projectContext) {
    const lastLines = terminalContent.split('\n').slice(-50).join('\n');
    const goal = projectContext?.goal || '';

    // 测试归档阶段
    if (/测试计划|测试用例|test.*plan|bug.*fix|测试归档|单元测试|集成测试/i.test(lastLines) ||
        /step\s*5|测试/i.test(goal) ||
        /jest|mocha|pytest|vitest|cypress/i.test(lastLines)) {
      return 'testing';
    }

    // 编码开发阶段
    if (/todolist|任务.*完成|开发.*计划|实施计划.*标记/i.test(lastLines) ||
        /npm|yarn|pnpm|编码|coding|component|页面开发/i.test(lastLines) ||
        /step\s*4|完成开发/i.test(goal) ||
        /创建.*组件|实现.*功能|编写.*代码/i.test(lastLines)) {
      return 'development';
    }

    // 任务计划阶段
    if (/开发任务|实施计划|任务分解|前端.*计划|页面.*计划/i.test(lastLines) ||
        /产品经理|设计师|原型|FontAwesome|tailwindcss/i.test(lastLines) ||
        /step\s*3|任务计划/i.test(goal) ||
        /制定.*计划|分解.*任务/i.test(lastLines)) {
      return 'planning';
    }

    // 技术方案阶段
    if (/技术方案|设计方案|架构|shadcn|radix|sqlite|数据库/i.test(lastLines) ||
        /step\s*2|技术方案|设计方案/i.test(goal) ||
        /技术选型|架构设计|数据模型/i.test(lastLines)) {
      return 'design';
    }

    // 需求文档阶段
    if (/需求文档|需求.*制定|功能需求|用户需求/i.test(lastLines) ||
        /step\s*1|需求文档/i.test(goal) ||
        /用户故事|功能列表|需求分析/i.test(lastLines)) {
      return 'requirements';
    }

    // 根据 docs 目录文件判断
    if (/需求文档\.md/i.test(lastLines) && !/技术方案\.md/i.test(lastLines)) {
      return 'design';
    }
    if (/技术方案\.md/i.test(lastLines) && !/实施计划/i.test(lastLines)) {
      return 'planning';
    }

    // 默认为需求文档阶段
    return 'requirements';
  }

  /**
   * 获取阶段配置
   */
  getPhaseConfig(phase) {
    const config = this.phaseConfigs[phase] || this.phaseConfigs.requirements;

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
    const lastLines = terminalContent.split('\n').slice(-30).join('\n');

    // 检测文档保存成功
    if (phase === 'requirements' || phase === 'design' || phase === 'planning') {
      if (/保存成功|文件已创建|wrote.*docs|Created.*\.md/i.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续',
          phase,
          phaseConfig: config,
          message: `${this.phases.find(p => p.id === phase)?.name}文档已保存，继续下一步`
        };
      }
    }

    // 开发阶段：检测任务完成
    if (phase === 'development') {
      // 检测编译/构建错误
      if (/error|Error|ERROR|failed|Failed|FAILED/i.test(lastLines) &&
          !/error handling|on error|catch/i.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'error',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: '检测到错误，需要分析和修复',
          requireConfirmation: true
        };
      }

      if (/任务.*完成|标记.*完成|✓|✅|DONE|done/i.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续',
          phase,
          phaseConfig: config,
          message: '任务已完成，继续下一个任务'
        };
      }
    }

    // 测试阶段：检测 bug
    if (phase === 'testing') {
      if (/bug|Bug|BUG|error|Error|failed|Failed|测试失败/i.test(lastLines) &&
          !/no bug|no error|0 failed/i.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'error',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: '检测到 bug/错误，需要修复后继续（不要跳过）',
          requireConfirmation: true
        };
      }

      if (/测试通过|test.*pass|passed|✓|✅|PASS/i.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续测试',
          phase,
          phaseConfig: config,
          message: '测试通过，继续下一个测试用例'
        };
      }
    }

    // 检查警告模式
    for (const pattern of config.warningPatterns || []) {
      if (pattern.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'warning',
          suggestedAction: '检测到潜在问题，建议检查',
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
        message: `全栈开发 - ${this.phases.find(p => p.id === phase)?.name}: 发送继续指令`
      };
    }

    return null;
  }

  /**
   * 生成 AI 分析提示词
   */
  getAnalysisPrompt(terminalContent, phase, context) {
    const config = this.getPhaseConfig(phase);
    const phaseName = this.phases.find(p => p.id === phase)?.name || '开发';

    return `
## 全栈开发监控 - ${phaseName}阶段

${config.promptTemplate}

### 当前阶段信息
- **阶段**: ${phaseName}（${phase}）
- **自动操作**: ${config.autoActionEnabled ? '启用' : '禁用'}
- **需要确认**: ${config.requireConfirmation ? '是' : '否'}

### 检查清单
${config.checkpoints.map((c, i) => `${i + 1}. [ ] ${c}`).join('\n')}

### 可执行操作
${config.autoActions.map(a => `- \`${a}\``).join('\n')}

### 终端内容（最后 3000 字符）
\`\`\`
${terminalContent.slice(-3000)}
\`\`\`

### 分析要求
1. 判断当前阶段的任务是否完成
2. 检查是否有错误或警告需要处理
3. 如果需要操作，给出具体指令
4. 如果发现问题，提供解决方案
5. 确保不跳过任何 bug 或错误
`;
  }
}

export default FullStackDevPlugin;
