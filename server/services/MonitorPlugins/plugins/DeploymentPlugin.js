import BasePlugin from '../BasePlugin.js';
import promptLoader from '../PromptLoader.js';

/**
 * 部署运维监控策略插件
 * 针对服务器运维、部署、监控等任务的专业监控策略
 */
class DeploymentPlugin extends BasePlugin {
  constructor() {
    super();
    this.id = 'deployment';
    this.name = '部署运维';
    this.description = '服务器部署和运维监控策略，支持配置、部署、监控、故障排查等阶段';
    this.version = '2.1.0';

    // 匹配规则
    this.projectPatterns = [
      /docker|kubernetes|k8s|helm|ansible|terraform/i,
      /nginx|apache|caddy|systemd|systemctl/i,
      /deploy|运维|部署|服务器|server/i,
      /ssh|scp|rsync/i,
      /\.yml$|\.yaml$|Dockerfile|docker-compose/i
    ];

    // 运维阶段
    this.phases = [
      { id: 'config', name: '配置准备', priority: 1 },
      { id: 'deploy', name: '部署执行', priority: 2 },
      { id: 'monitor', name: '监控验证', priority: 3 },
      { id: 'troubleshoot', name: '故障排查', priority: 4 },
      { id: 'backup', name: '备份归档', priority: 5 }
    ];

    // 阶段配置
    this.phaseConfigs = {
      config: {
        autoActions: ['继续', '检查配置', '验证语法'],
        checkpoints: [
          '配置语法是否正确',
          '环境变量是否设置',
          '权限是否正确',
          '路径是否存在'
        ],
        warningPatterns: [
          /syntax error|语法错误/i,
          /permission denied|权限拒绝/i,
          /not found|找不到/i
        ],
        autoActionEnabled: true,
        idleTimeout: 30000
      },
      deploy: {
        autoActions: ['检查部署状态', '查看日志'],
        checkpoints: [
          '服务是否启动成功',
          '端口是否正常监听',
          '健康检查是否通过',
          '是否有错误日志'
        ],
        warningPatterns: [
          /deploy.*failed|部署失败/i,
          /connection refused|连接拒绝/i,
          /timeout|超时/i,
          /exit code [1-9]/i
        ],
        autoActionEnabled: false,
        requireConfirmation: true,
        idleTimeout: 120000
      },
      monitor: {
        autoActions: ['继续', '刷新状态', '查看详情'],
        checkpoints: [
          '服务是否正常运行',
          'CPU/内存使用是否正常',
          '磁盘空间是否充足',
          '网络是否正常'
        ],
        warningPatterns: [
          /high.*usage|使用率过高/i,
          /disk.*full|磁盘满/i,
          /memory.*low|内存不足/i
        ],
        autoActionEnabled: true,
        idleTimeout: 30000
      },
      troubleshoot: {
        autoActions: ['查看日志', '检查状态', '分析原因'],
        checkpoints: [
          '错误信息是什么',
          '何时开始出现问题',
          '是否有相关日志',
          '是否影响其他服务'
        ],
        warningPatterns: [
          /error|failed|故障/i,
          /exception|异常/i
        ],
        autoActionEnabled: false,
        requireConfirmation: true,
        idleTimeout: 60000
      },
      backup: {
        autoActions: ['等待完成', '检查备份状态'],
        checkpoints: [
          '备份是否完整',
          '备份文件是否可用',
          '存储空间是否充足',
          '是否需要清理旧备份'
        ],
        warningPatterns: [
          /backup.*failed|备份失败/i,
          /no space|空间不足/i
        ],
        autoActionEnabled: false,
        idleTimeout: 300000
      }
    };
  }

  /**
   * 检测当前阶段
   */
  detectPhase(terminalContent, projectContext) {
    const lastLines = terminalContent.split('\n').slice(-30).join('\n');

    // 故障排查阶段
    if (/error|failed|故障|排查|debug|troubleshoot/i.test(lastLines) ||
        /journalctl|dmesg|tail.*log/i.test(lastLines)) {
      return 'troubleshoot';
    }

    // 备份恢复阶段
    if (/backup|restore|备份|恢复|dump|snapshot/i.test(lastLines)) {
      return 'backup';
    }

    // 监控检查阶段
    if (/status|health|monitor|监控|检查|htop|top|ps aux/i.test(lastLines) ||
        /systemctl status|docker ps|kubectl get/i.test(lastLines)) {
      return 'monitor';
    }

    // 部署发布阶段
    if (/deploy|push|pull|restart|reload|发布|部署|重启/i.test(lastLines) ||
        /docker.*up|kubectl apply|ansible.*playbook/i.test(lastLines)) {
      return 'deploy';
    }

    // 默认为配置管理阶段
    return 'config';
  }

  /**
   * 获取阶段配置
   */
  getPhaseConfig(phase) {
    const config = this.phaseConfigs[phase] || this.phaseConfigs.config;

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

    // 部署阶段特殊处理
    if (phase === 'deploy') {
      // 检测部署成功
      if (/success|completed|started|running|active/i.test(lastLines) &&
          !/failed|error/i.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'success',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: '部署成功'
        };
      }

      // 检测部署失败
      if (/failed|error|exit code [1-9]/i.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'error',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: '部署失败，需要人工处理',
          requireConfirmation: true
        };
      }
    }

    // 故障排查阶段
    if (phase === 'troubleshoot') {
      if (/error|failed|exception/i.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'error',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: '检测到错误，需要分析处理',
          requireConfirmation: true
        };
      }
    }

    // 备份阶段
    if (phase === 'backup') {
      // 检测备份进行中
      if (/backing up|dumping|copying/i.test(lastLines) ||
          /\d+%|\d+ MB|\d+ GB/i.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'running',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: '备份进行中...'
        };
      }

      // 检测备份完成
      if (/backup.*complete|备份完成|done/i.test(lastLines)) {
        return {
          needsAction: false,
          actionType: 'success',
          suggestedAction: null,
          phase,
          phaseConfig: config,
          message: '备份完成'
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
        message: `部署运维 - ${this.phases.find(p => p.id === phase)?.name}: 发送继续指令`
      };
    }

    return null;
  }

  /**
   * 检测是否空闲（重写以支持 SSH 等环境）
   */
  isIdle(terminalContent) {
    const lastLines = terminalContent.split('\n').slice(-10).join('\n');

    // SSH/Shell 提示符
    if (/\$\s*$|#\s*$|>\s*$/.test(lastLines) &&
        !/running|processing|loading/i.test(lastLines)) {
      return true;
    }

    // 通用空闲检测
    return super.isIdle(terminalContent);
  }

  /**
   * 生成 AI 分析提示词
   */
  getAnalysisPrompt(terminalContent, phase, context) {
    const config = this.getPhaseConfig(phase);
    const phaseName = this.phases.find(p => p.id === phase)?.name || '运维';

    return `
## 部署运维监控 - ${phaseName}阶段

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
1. 判断当前运维任务的状态
2. 检查是否有错误或警告
3. 如果需要操作，给出具体命令
4. 如果发现问题，提供解决方案
`;
  }
}

export default DeploymentPlugin;
