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
      { id: 'confirmation', name: '确认', priority: 4 },
      { id: 'accept_edits', name: '接受编辑', priority: 5 }
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
      },
      accept_edits: {
        autoActions: ['a'],
        checkpoints: [
          '检查待接受的编辑数量',
          '确认编辑内容正确',
          '按 a 接受所有编辑'
        ],
        warningPatterns: [],
        autoActionEnabled: true,
        idleTimeout: 3000
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
    // 清除 ANSI 转义序列的版本，用于文本匹配
    const cleanLastLines = lastLines.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');

    // 优先检测运行中状态（Claude Code / OpenCode 正在执行操作）
    // 这必须在 accept_edits 之前检测，因为 accept_edits 可能在运行中也存在
    // OpenCode 特有的运行标志：[build] thinking, [plan] thinking
    if (/Compacting|Running|Garnishing|ctrl\+c to interrupt|esc to interrupt/i.test(lastLines) ||
        /\[build\].*thinking|\[plan\].*thinking/i.test(lastLines) ||
        /\u280b|\u2819|\u2839|\u2838|\u283c|\u2834|\u2826|\u2827|\u2807|\u280f|\u28fe|\u28fd|\u28fb|\u28bf/.test(lastLines)) {
      return 'running';
    }

    // 检测 accept edits 状态（Claude Code 完成任务后等待用户接受编辑）
    // 只有在不运行时才检测这个状态
    // 条件：有 accept edits 提示，且有空闲的 > 提示符
    if (/accept edits on|shift\+tab to cycle/i.test(lastLines)) {
      // 检查是否有空闲的 > 提示符（没有运行指示）
      const hasIdlePrompt = /^❯\s*$/m.test(lastLines) || /\n❯\s*$/m.test(lastLines);
      // 排除有排队消息的情况（说明还在处理中）
      const hasQueuedMessages = /Press up to edit queued messages/i.test(lastLines);

      if (hasIdlePrompt && !hasQueuedMessages) {
        return 'accept_edits';
      }
      // 如果有排队消息或正在运行，返回运行中状态
      return 'running';
    }

    // 检测确认界面（Claude Code 权限确认等）
    // "Do you want to proceed?" 或 "Do you want to make this edit" 且有选项
    // 使用清理后的文本进行匹配，避免 ANSI 转义序列干扰
    const hasDoYouWantToProceed = /Do you want to proceed\?/i.test(cleanLastLines);
    const hasDoYouWantToMakeEdit = /Do you want to make this edit/i.test(cleanLastLines);
    const hasOption1Yes = /1\.\s*Yes/i.test(cleanLastLines);
    const hasOption2No = /2\.\s*No/i.test(cleanLastLines);
    const hasOption2AllowEdits = /2\.\s*Yes,\s*allow/i.test(cleanLastLines);
    const hasOption3No = /3\.\s*No/i.test(cleanLastLines);

    // 调试日志
    if (hasDoYouWantToProceed || hasDoYouWantToMakeEdit) {
      console.log('[DefaultPlugin] 检测到确认提示:', {
        hasDoYouWantToProceed,
        hasDoYouWantToMakeEdit,
        hasOption1Yes,
        hasOption2AllowEdits,
        hasOption3No,
        cleanLastLinesPreview: cleanLastLines.slice(-200)
      });
    }

    // 检测任何 "Do you want to proceed/make" 确认界面
    if ((hasDoYouWantToProceed || hasDoYouWantToMakeEdit) && hasOption1Yes) {
      return 'confirmation';
    }

    if (/Allow once|Allow for this session|Deny/i.test(lastLines) ||
        /allow all edits during this session/i.test(lastLines) ||
        /\[1\].*\[2\].*\[3\]/i.test(lastLines) ||
        /选择.*[123]|choose.*[123]/i.test(lastLines) ||
        /\(y\/n\)|\[Y\/n\]|\[yes\/no\]/i.test(lastLines)) {
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

    // accept_edits 阶段：发送 "继续" 命令让 Claude Code 继续工作
    // Claude Code 在等待接受编辑时，底部显示 "accept edits on"
    // 此时终端在等待用户输入，发送 "继续" 命令
    if (phase === 'accept_edits') {
      return {
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: '继续',
        phase,
        phaseConfig: config,
        message: '检测到 Claude Code 等待接受编辑，发送 "继续" 命令'
      };
    }

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

      // 检测 "Do you want to proceed?" 格式的确认界面
      // 支持多种选项格式：
      // - 1. Yes / 2. No
      // - 1. Yes / 2. Yes, allow... / 3. No
      const hasDoYouWantToProceed = /Do you want to proceed\?/i.test(lastLines);
      const hasOption1Yes = /1\.\s*Yes/i.test(lastLines);
      const hasOption2Or3No = /[23]\.\s*No/i.test(lastLines);

      if (hasDoYouWantToProceed && hasOption1Yes) {
        // 如果有 "2. Yes, allow" 选项，选择 2（允许本项目）
        // 否则选择 1（Yes）
        const hasOption2Allow = /2\.\s*Yes,\s*allow/i.test(lastLines);
        return {
          needsAction: true,
          actionType: 'select',
          suggestedAction: hasOption2Allow ? '2' : '1',
          phase,
          phaseConfig: config,
          message: hasOption2Allow
            ? '检测到 Claude Code 项目权限确认，自动选择选项 2（允许本项目）'
            : '检测到 Bash 命令确认，自动选择选项 1（Yes）'
        };
      }

      // 检测数字选择（Claude Code 权限确认：Allow once / Allow for this session / Deny）
      if (/\[1\].*\[2\].*\[3\]/i.test(lastLines) ||
          /Allow once.*Allow for this session/i.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'select',
          suggestedAction: '2',
          phase,
          phaseConfig: config,
          message: '检测到 Claude Code 权限确认，自动选择选项 2（本次会话允许）'
        };
      }

      // 默认选择选项 2（适用于其他未知确认界面）
      return {
        needsAction: true,
        actionType: 'select',
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

    // 空闲状态：返回不需要操作（未检测到明确的空闲提示符）
    // 注意：如果检测到空闲提示符，detectPhase 会返回 'waiting' 而不是 'idle'
    // 所以 phase='idle' 意味着终端处于未知状态，不应自动操作
    if (phase === 'idle') {
      return {
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        phase,
        phaseConfig: config,
        message: '终端状态不明确，等待用户操作或状态变化'
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
   * 检测是否空闲（检测到明确的输入提示符）
   */
  isIdle(terminalContent) {
    // 清理 ANSI 转义序列
    const cleanContent = terminalContent.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const lastLines = cleanContent.split('\n').slice(-15).join('\n');

    // 排除运行中状态（Claude Code 运行中显示 "esc to interrupt"）
    if (/esc to interrupt|running|processing|loading|compiling|building/i.test(lastLines)) {
      return false;
    }

    // 排除进度指示
    if (/\d+%|ETA:|\u280b|\u2819|\u2839|\u2838|\u283c|\u2834|\u2826|\u2827|\u2807|\u280f/.test(lastLines)) {
      return false;
    }

    // Claude Code 空闲提示符（更宽松的匹配）
    // 匹配单独的 > 提示符，允许前面有空格，后面可能有光标等
    // OpenCode 空闲提示符：@general、[build] 或 [plan] 后跟空行
    const claudeCodeIdle = /^[\s>]*>\s*$/m.test(lastLines) ||
                          /\n>\s*$/.test(lastLines) ||
                          />\s*[\x00-\x1f]*$/.test(lastLines);

    // OpenCode 空闲提示符
    const openCodeIdle = /@general\s*$/m.test(lastLines) ||
                         /\[build\]\s*$/m.test(lastLines) ||
                         /\[plan\]\s*$/m.test(lastLines) ||
                         /OpenCode\s*>\s*$/m.test(lastLines);

    // Shell 空闲提示符（更宽松）
    const shellIdle = /[\$#%]\s*[\x00-\x1f]*$/.test(lastLines) ||
                     /\n.*[\$#%]\s*$/.test(lastLines);

    // 通用空闲检测
    const genericIdle = />>>\s*$|In \[\d+\]:\s*$/m.test(lastLines);

    return claudeCodeIdle || openCodeIdle || shellIdle || genericIdle;
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
