import BasePlugin from '../BasePlugin.js';
import promptLoader from '../PromptLoader.js';

/**
 * App 开发监控策略插件
 * 针对应用程序开发项目的专业监控策略
 */
class AppDevPlugin extends BasePlugin {
  constructor() {
    super();
    this.id = 'app-dev';
    this.name = 'App 开发';
    this.description = '应用程序开发监控策略，支持编码、测试、构建、部署等阶段';
    this.version = '2.0.0';

    // 匹配规则：检测开发项目
    this.projectPatterns = [
      /package\.json|cargo\.toml|go\.mod|pom\.xml|build\.gradle/i,
      /src\/|lib\/|app\/|components\//i,
      /react|vue|angular|flutter|electron|next|nuxt/i,
      /node_modules|vendor|target/i
    ];

    // 开发阶段
    this.phases = [
      { id: 'planning', name: '需求分析', priority: 1 },
      { id: 'coding', name: '编码开发', priority: 2 },
      { id: 'testing', name: '测试调试', priority: 3 },
      { id: 'building', name: '构建打包', priority: 4 },
      { id: 'deploying', name: '部署上线', priority: 5 }
    ];
  }

  /**
   * 检测当前阶段
   */
  detectPhase(terminalContent, projectContext) {
    const lastLines = terminalContent.split('\n').slice(-30).join('\n');

    // 部署阶段
    if (/npm run deploy|yarn deploy|docker push|kubectl|deploy|上线|发布/i.test(lastLines)) {
      return 'deploying';
    }

    // 构建阶段
    if (/npm run build|yarn build|cargo build|go build|mvn package|gradle build|构建|打包/i.test(lastLines)) {
      return 'building';
    }

    // 测试阶段
    if (/npm test|yarn test|jest|pytest|cargo test|go test|mvn test|测试/i.test(lastLines) ||
        /PASS|FAIL|test.*passed|test.*failed/i.test(lastLines)) {
      return 'testing';
    }

    // 检测错误状态（也归类到测试阶段）
    if (/error\[|Error:|ERROR|failed|FAILED|exception/i.test(lastLines) &&
        !/error handling|on error|error message/i.test(lastLines)) {
      return 'testing';
    }

    // 需求分析阶段
    if (/requirement|需求|spec|规格|design|设计|plan|计划/i.test(lastLines)) {
      return 'planning';
    }

    // 默认为编码阶段
    return 'coding';
  }

  /**
   * 获取阶段配置
   */
  getPhaseConfig(phase) {
    const configs = {
      planning: {
        autoActions: ['继续', '完善需求', '添加细节'],
        checkpoints: [
          '需求是否明确',
          '技术方案是否可行',
          '是否考虑边界情况',
          '是否有遗漏的功能点'
        ],
        warningPatterns: [/需求不明确|方案不可行/],
        autoActionEnabled: true,
        idleTimeout: 45000
      },

      coding: {
        autoActions: ['继续', '完成当前功能', '添加注释'],
        checkpoints: [
          '代码是否符合规范',
          '是否有安全漏洞',
          '是否有性能问题',
          '是否需要重构'
        ],
        warningPatterns: [
          /security|vulnerability|安全漏洞/i,
          /deprecated|过时/i
        ],
        autoActionEnabled: true,
        idleTimeout: 30000
      },

      testing: {
        autoActions: ['修复错误', '继续测试', '查看详情'],
        checkpoints: [
          '测试是否通过',
          '覆盖率是否足够',
          '是否有遗漏的测试用例',
          '错误是否已修复'
        ],
        warningPatterns: [
          /FAILED|Error:|error\[|failed/i,
          /test.*failed|测试失败/i
        ],
        autoActionEnabled: false,
        requireConfirmation: true,
        idleTimeout: 60000
      },

      building: {
        autoActions: ['等待构建完成', '查看构建日志'],
        checkpoints: [
          '构建是否成功',
          '产物是否正确',
          '是否有警告需要处理',
          '构建时间是否正常'
        ],
        warningPatterns: [
          /build failed|构建失败/i,
          /compilation error|编译错误/i,
          /warning:/i
        ],
        autoActionEnabled: false,
        idleTimeout: 300000
      },

      deploying: {
        autoActions: ['检查部署状态', '查看日志'],
        checkpoints: [
          '服务是否正常启动',
          '配置是否正确',
          '是否有健康检查',
          '回滚方案是否就绪'
        ],
        warningPatterns: [
          /deploy failed|部署失败/i,
          /connection refused|连接拒绝/i,
          /timeout|超时/i
        ],
        autoActionEnabled: false,
        requireConfirmation: true,
        idleTimeout: 120000
      }
    };

    const config = configs[phase] || configs.coding;

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
    const lastLines = terminalContent.split('\n').slice(-20).join('\n');

    // 检查警告模式
    for (const pattern of config.warningPatterns || []) {
      if (pattern.test(lastLines)) {
        // 测试失败：标记但不自动操作
        if (phase === 'testing' && /FAILED|failed|Error/i.test(lastLines)) {
          return {
            needsAction: false,
            actionType: 'error',
            suggestedAction: null,
            phase,
            phaseConfig: config,
            message: '检测到测试失败，需要人工处理',
            requireConfirmation: true
          };
        }

        // 构建失败
        if (phase === 'building' && /build failed|compilation error/i.test(lastLines)) {
          return {
            needsAction: false,
            actionType: 'error',
            suggestedAction: null,
            phase,
            phaseConfig: config,
            message: '检测到构建失败，需要人工处理',
            requireConfirmation: true
          };
        }

        // 部署失败
        if (phase === 'deploying') {
          return {
            needsAction: false,
            actionType: 'error',
            suggestedAction: null,
            phase,
            phaseConfig: config,
            message: '检测到部署问题，需要人工处理',
            requireConfirmation: true
          };
        }

        // 其他警告
        return {
          needsAction: true,
          actionType: 'warning',
          suggestedAction: '检测到潜在问题，建议检查',
          phase,
          phaseConfig: config
        };
      }
    }

    // 构建/部署阶段：检测是否完成
    if (phase === 'building' || phase === 'deploying') {
      // 检测成功完成
      if (/success|completed|done|finished|✓|✔/i.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'success',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: `${phase === 'building' ? '构建' : '部署'}完成`
        };
      }

      // 仍在进行中
      if (/building|deploying|processing|uploading/i.test(lastLines) ||
          /\.\.\.|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'running',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: `${phase === 'building' ? '构建' : '部署'}进行中...`
        };
      }
    }

    // 编码阶段：检查空闲状态
    if (phase === 'coding' && config.autoActionEnabled && this.isIdle(terminalContent)) {
      return {
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: config.autoActions[0],
        phase,
        phaseConfig: config,
        message: 'App 开发 - 编码阶段: 发送继续指令'
      };
    }

    // 需求分析阶段
    if (phase === 'planning' && config.autoActionEnabled && this.isIdle(terminalContent)) {
      return {
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: config.autoActions[0],
        phase,
        phaseConfig: config,
        message: 'App 开发 - 需求分析: 发送继续指令'
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
## App 开发监控 - ${phaseName}阶段

${config.promptTemplate}

### 当前阶段特点
- 阶段: ${phaseName}
- 自动操作: ${config.autoActionEnabled ? '启用' : '禁用'}
- 需要确认: ${config.requireConfirmation ? '是' : '否'}

### 检查要点
${config.checkpoints.map(c => `- ${c}`).join('\n')}

### 建议操作
${config.autoActions.map(a => `- ${a}`).join('\n')}

### 终端内容（最后 2000 字符）
\`\`\`
${terminalContent.slice(-2000)}
\`\`\`

请分析当前开发状态：
1. 判断当前处于哪个具体环节
2. 检查是否有错误或警告
3. 如果需要操作，给出具体指令
4. 如果发现问题，提供解决方案
`;
  }
}

export default AppDevPlugin;
