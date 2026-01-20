import BasePlugin from '../BasePlugin.js';
import promptLoader from '../PromptLoader.js';

/**
 * 默认监控策略插件
 * 提供通用的监控逻辑，作为其他插件的兜底
 *
 * 核心能力：
 * 1. 智能识别终端状态（空闲、运行中、等待输入、错误、确认）
 * 2. 根据状态提供专业的分析和操作建议
 * 3. 支持 Claude Code 特有的交互模式
 */
class DefaultPlugin extends BasePlugin {
  constructor() {
    super();
    this.id = 'default';
    this.name = '通用策略';
    this.description = '通用监控策略，适用于各类开发项目，提供智能状态识别和操作建议';
    this.version = '2.1.0';

    // 默认插件匹配所有项目
    this.projectPatterns = [/.*/];

    // 通用阶段
    this.phases = [
      { id: 'idle', name: '空闲', priority: 0 },
      { id: 'running', name: '运行中', priority: 1 },
      { id: 'waiting', name: '等待输入', priority: 2 },
      { id: 'error', name: '错误', priority: 3 },
      { id: 'confirmation', name: '确认', priority: 4 }
    ];

    // 常见错误模式及其处理建议
    this.errorPatterns = {
      syntaxError: {
        pattern: /SyntaxError|语法错误|unexpected token/i,
        suggestion: '检查代码语法，特别是括号、引号、分号是否匹配'
      },
      moduleNotFound: {
        pattern: /ModuleNotFoundError|Cannot find module|模块.*找不到/i,
        suggestion: '检查模块是否安装，运行 npm install 或 pip install'
      },
      permissionDenied: {
        pattern: /Permission denied|EACCES|权限拒绝/i,
        suggestion: '检查文件权限，可能需要 sudo 或修改文件权限'
      },
      connectionRefused: {
        pattern: /ECONNREFUSED|Connection refused|连接拒绝/i,
        suggestion: '检查目标服务是否启动，端口是否正确'
      },
      outOfMemory: {
        pattern: /OutOfMemory|heap out of memory|内存不足/i,
        suggestion: '增加内存限制或优化代码减少内存使用'
      },
      timeout: {
        pattern: /timeout|ETIMEDOUT|超时/i,
        suggestion: '检查网络连接，或增加超时时间'
      },
      typeError: {
        pattern: /TypeError|类型错误/i,
        suggestion: '检查变量类型，确保类型匹配'
      },
      referenceError: {
        pattern: /ReferenceError|未定义|is not defined/i,
        suggestion: '检查变量是否声明，是否在作用域内'
      }
    };

    // 阶段配置
    this.phaseConfigs = {
      idle: {
        autoActions: ['继续'],
        checkpoints: [
          '检查终端是否显示命令提示符（如 > 或 $）',
          '确认没有正在执行的后台任务',
          '查看是否有未完成的操作需要继续'
        ],
        warningPatterns: [],
        autoActionEnabled: true,
        idleTimeout: 30000
      },
      running: {
        autoActions: ['等待完成'],
        checkpoints: [
          '观察进度指示器（百分比、进度条、spinner）',
          '检查是否有错误输出混在正常输出中',
          '确认程序没有卡住（输出是否在更新）',
          '注意超时警告'
        ],
        warningPatterns: [/timeout|timed out|卡住|hung|stuck/i],
        autoActionEnabled: false,
        idleTimeout: 60000
      },
      waiting: {
        autoActions: ['继续', 'y', 'yes'],
        checkpoints: [
          '识别等待的输入类型（文本、确认、选择）',
          '检查提示信息了解需要什么输入',
          '确认自动响应是否安全合适'
        ],
        warningPatterns: [],
        autoActionEnabled: true,
        idleTimeout: 15000
      },
      error: {
        autoActions: ['分析错误', '查看详情', '尝试修复'],
        checkpoints: [
          '完整阅读错误信息，找出错误类型',
          '定位错误发生的文件和行号',
          '分析错误原因（语法、依赖、权限、网络等）',
          '制定修复方案'
        ],
        warningPatterns: [/error|failed|exception/i],
        autoActionEnabled: false,
        requireConfirmation: true
      },
      confirmation: {
        autoActions: ['2'],
        checkpoints: [
          '理解确认选项的含义',
          '评估每个选项的影响',
          '选择最安全且合适的选项'
        ],
        warningPatterns: [],
        autoActionEnabled: true,
        idleTimeout: 5000
      }
    };
  }

  /**
   * 默认插件总是匹配（作为兜底）
   */
  matches(projectContext) {
    return true;
  }

  /**
   * 检测当前阶段
   */
  detectPhase(terminalContent, projectContext) {
    const lastLines = terminalContent.split('\n').slice(-20).join('\n');

    // 检测确认界面（Claude Code 权限确认等）
    // "Do you want to proceed?" 且有 "1. Yes" 和 "2. No" 选项
    const hasDoYouWantToProceed = /Do you want to proceed\?/i.test(lastLines);
    const hasOption1Yes = /1\.\s*Yes/i.test(lastLines);
    const hasOption2No = /2\.\s*No/i.test(lastLines);

    if (/Allow once|Allow for this session|Deny/i.test(lastLines) ||
        /\[1\].*\[2\].*\[3\]/i.test(lastLines) ||
        /选择.*[123]|choose.*[123]/i.test(lastLines) ||
        /\(y\/n\)|\[Y\/n\]|\[yes\/no\]/i.test(lastLines) ||
        (hasDoYouWantToProceed && hasOption1Yes)) {
      return 'confirmation';
    }

    // 检测错误状态（排除代码中的错误处理相关内容）
    const errorIndicators = /error:|failed:|exception:|fatal:|Error:|Failed:|Exception:/;
    const codeContext = /error handling|error message|on error|catch.*error|\.error\(|console\.error/i;
    if (errorIndicators.test(lastLines) && !codeContext.test(lastLines)) {
      return 'error';
    }

    // 检测运行中状态
    if (/running|processing|loading|compiling|building|installing/i.test(lastLines) ||
        /\.\.\.|\u280b|\u2819|\u2839|\u2838|\u283c|\u2834|\u2826|\u2827|\u2807|\u280f|\u28fe|\u28fd|\u28fb|\u28bf|\u28bf|\u28df|\u28ef|\u28f7/.test(lastLines) ||
        /\d+%|ETA:|eta:/i.test(lastLines)) {
      return 'running';
    }

    // 检测等待输入状态
    if (this.isIdle(terminalContent)) {
      return 'waiting';
    }

    return 'idle';
  }

  /**
   * 获取阶段配置
   */
  getPhaseConfig(phase) {
    const config = this.phaseConfigs[phase] || this.phaseConfigs.idle;

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

    // 确认界面：根据类型选择合适的选项
    if (phase === 'confirmation') {
      // 检测 y/n 确认
      if (/\(y\/n\)|\[Y\/n\]|\[yes\/no\]/i.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'single_char',
          suggestedAction: 'y',
          phase,
          phaseConfig: config,
          message: '检测到 y/n 确认，自动选择 y'
        };
      }

      // 检测 "Do you want to proceed? 1. Yes 2. No" 格式（Bash 命令确认）
      // 注意：选项可能在不同行，所以分开检测
      const hasDoYouWantToProceed = /Do you want to proceed\?/i.test(lastLines);
      const hasOption1Yes = /1\.\s*Yes/i.test(lastLines);
      const hasOption2No = /2\.\s*No/i.test(lastLines);

      if (hasDoYouWantToProceed && hasOption1Yes && hasOption2No) {
        return {
          needsAction: true,
          actionType: 'select',
          suggestedAction: '1',
          phase,
          phaseConfig: config,
          message: '检测到 Bash 命令确认（1.Yes/2.No），自动选择选项 1（Yes）'
        };
      }

      // 检测数字选择（Claude Code 权限确认：Allow once / Allow for this session / Deny）
      if (/\[1\].*\[2\].*\[3\]/i.test(lastLines) ||
          /Allow once.*Allow for this session/i.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'single_char',
          suggestedAction: '2',
          phase,
          phaseConfig: config,
          message: '检测到 Claude Code 权限确认，自动选择选项 2（本次会话允许）'
        };
      }

      // 默认选择选项 2（适用于其他未知确认界面）
      return {
        needsAction: true,
        actionType: 'single_char',
        suggestedAction: '2',
        phase,
        phaseConfig: config,
        message: '检测到确认界面，自动选择选项 2'
      };
    }

    // 错误状态：分析错误类型并提供建议
    if (phase === 'error') {
      const errorInfo = this.analyzeError(lastLines);
      return {
        needsAction: false,
        actionType: 'error',
        suggestedAction: null,
        phase,
        phaseConfig: config,
        message: `检测到错误: ${errorInfo.type}\n建议: ${errorInfo.suggestion}`,
        errorInfo,
        requireConfirmation: true
      };
    }

    // 运行中：不操作
    if (phase === 'running') {
      return {
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        phase,
        phaseConfig: config,
        message: '程序运行中，等待完成'
      };
    }

    // 等待输入：发送继续指令
    if (phase === 'waiting') {
      return {
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: '继续',
        phase,
        phaseConfig: config,
        message: '检测到等待输入状态，发送"继续"指令'
      };
    }

    // 空闲状态：检查是否需要操作
    if (phase === 'idle' && this.isIdle(terminalContent)) {
      return {
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: '继续',
        phase,
        phaseConfig: config,
        message: '检测到空闲状态，发送"继续"指令'
      };
    }

    return null;
  }

  /**
   * 分析错误类型
   */
  analyzeError(content) {
    for (const [type, info] of Object.entries(this.errorPatterns)) {
      if (info.pattern.test(content)) {
        return {
          type,
          suggestion: info.suggestion,
          pattern: info.pattern.toString()
        };
      }
    }

    return {
      type: 'unknown',
      suggestion: '请仔细阅读错误信息，分析错误原因后手动处理'
    };
  }

  /**
   * 检测是否空闲
   */
  isIdle(terminalContent) {
    const lastLines = terminalContent.split('\n').slice(-10).join('\n');

    // 排除运行中状态
    if (/running|processing|loading|compiling|building/i.test(lastLines)) {
      return false;
    }

    // 排除进度指示
    if (/\d+%|ETA:|\u280b|\u2819|\u2839|\u2838|\u283c|\u2834|\u2826|\u2827|\u2807|\u280f/.test(lastLines)) {
      return false;
    }

    // Claude Code 空闲提示符
    const claudeCodeIdle = />\s*$/.test(lastLines);

    // Shell 空闲提示符
    const shellIdle = /[\$#]\s*$/.test(lastLines);

    // 通用空闲检测
    const genericIdle = />>>\s*$|In \[\d+\]:\s*$/.test(lastLines);

    return claudeCodeIdle || shellIdle || genericIdle;
  }

  /**
   * 生成 AI 分析提示词
   */
  getAnalysisPrompt(terminalContent, phase, context) {
    const config = this.getPhaseConfig(phase);
    const phaseName = this.phases.find(p => p.id === phase)?.name || phase;
    const errorInfo = phase === 'error' ? this.analyzeError(terminalContent) : null;

    let prompt = `
## 通用监控分析 - ${phaseName}状态

${config.promptTemplate}

### 当前状态信息
- **阶段**: ${phaseName}
- **自动操作**: ${config.autoActionEnabled ? '启用' : '禁用'}
- **需要确认**: ${config.requireConfirmation ? '是' : '否'}
`;

    if (errorInfo && errorInfo.type !== 'unknown') {
      prompt += `
### 错误分析
- **错误类型**: ${errorInfo.type}
- **修复建议**: ${errorInfo.suggestion}
`;
    }

    prompt += `
### 检查清单
${config.checkpoints.map((c, i) => `${i + 1}. ${c}`).join('\n')}

### 可执行操作
${config.autoActions.map(a => `- \`${a}\``).join('\n')}

### 终端内容（最后 2000 字符）
\`\`\`
${terminalContent.slice(-2000)}
\`\`\`

### 分析要求
1. 判断当前终端的真实状态
2. 如果是错误状态，分析错误原因和修复方案
3. 如果需要操作，给出具体的操作指令
4. 如果不确定，说明原因并建议人工检查
`;

    return prompt;
  }
}

export default DefaultPlugin;
