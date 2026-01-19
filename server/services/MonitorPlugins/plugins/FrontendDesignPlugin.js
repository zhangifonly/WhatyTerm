import BasePlugin from '../BasePlugin.js';
import promptLoader from '../PromptLoader.js';

/**
 * 前端设计监控策略插件
 * 针对 UI/UX 设计开发场景
 */
class FrontendDesignPlugin extends BasePlugin {
  constructor() {
    super();
    this.id = 'frontend-design';
    this.name = '前端设计';
    this.description = '前端设计开发监控策略，支持需求分析、原型设计、组件开发、样式调整、响应式适配等阶段';
    this.version = '2.0.0';

    // 匹配规则
    this.projectPatterns = [
      /ui.*design|ux.*design|界面设计/i,
      /frontend.*design|前端设计/i,
      /figma|sketch|adobe.*xd/i,
      /css|scss|sass|less|stylus/i,
      /tailwind|styled.*component|emotion/i,
      /responsive|响应式|mobile.*first/i,
      /component.*library|组件库/i
    ];

    // 前端设计阶段
    this.phases = [
      { id: 'requirements', name: '需求分析', priority: 1 },
      { id: 'prototype', name: '原型设计', priority: 2 },
      { id: 'components', name: '组件开发', priority: 3 },
      { id: 'styling', name: '样式调整', priority: 4 },
      { id: 'responsive', name: '响应式适配', priority: 5 }
    ];
  }

  matches(projectContext) {
    const { projectPath, projectDesc, workingDir, goal } = projectContext;
    const searchText = `${projectPath || ''} ${projectDesc || ''} ${workingDir || ''} ${goal || ''}`;
    return this.projectPatterns.some(p => p.test(searchText));
  }

  detectPhase(terminalContent, projectContext) {
    const lastLines = terminalContent.split('\n').slice(-40).join('\n');

    // 响应式适配阶段
    if (/responsive|响应式|media.*query|breakpoint|mobile|tablet/i.test(lastLines)) {
      return 'responsive';
    }

    // 样式调整阶段
    if (/style|样式|css|color|font|spacing|margin|padding/i.test(lastLines)) {
      return 'styling';
    }

    // 组件开发阶段
    if (/component|组件|button|input|modal|card|form/i.test(lastLines)) {
      return 'components';
    }

    // 原型设计阶段
    if (/prototype|原型|wireframe|线框|mockup|layout|布局/i.test(lastLines)) {
      return 'prototype';
    }

    // 默认为需求分析
    return 'requirements';
  }

  getPhaseConfig(phase) {
    const configs = {
      requirements: {
        autoActions: ['继续', '分析需求', '确定风格'],
        checkpoints: [
          '是否明确了设计目标',
          '是否确定了目标用户',
          '是否有设计参考'
        ],
        autoActionEnabled: true,
        idleTimeout: 45000
      },

      prototype: {
        autoActions: ['继续', '设计原型', '调整布局'],
        checkpoints: [
          '布局是否合理',
          '信息层级是否清晰',
          '交互流程是否顺畅'
        ],
        autoActionEnabled: true,
        idleTimeout: 45000
      },

      components: {
        autoActions: ['继续', '开发组件', '测试组件'],
        checkpoints: [
          '组件是否可复用',
          '接口是否清晰',
          '是否有适当的 props'
        ],
        warningPatterns: [/error|failed|warning/i],
        autoActionEnabled: true,
        idleTimeout: 30000
      },

      styling: {
        autoActions: ['继续', '调整样式', '检查一致性'],
        checkpoints: [
          '颜色是否协调',
          '间距是否一致',
          '字体是否合适'
        ],
        autoActionEnabled: true,
        idleTimeout: 30000
      },

      responsive: {
        autoActions: ['继续', '测试响应式', '调整断点'],
        checkpoints: [
          '移动端是否正常',
          '平板端是否正常',
          '桌面端是否正常'
        ],
        warningPatterns: [/overflow|溢出|broken|错位/i],
        autoActionEnabled: true,
        idleTimeout: 30000
      }
    };

    const config = configs[phase] || configs.requirements;

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

    // 检测设计完成
    if (/design.*complete|设计完成|ui.*done|界面完成/i.test(lastLines)) {
      return {
        needsAction: false,
        actionType: 'success',
        suggestedAction: null,
        phase,
        phaseConfig: config,
        message: '前端设计完成'
      };
    }

    // 检查警告模式
    for (const pattern of config.warningPatterns || []) {
      if (pattern.test(lastLines)) {
        return {
          needsAction: true,
          actionType: 'warning',
          suggestedAction: '检查样式问题',
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
        message: `前端设计 - ${this.phases.find(p => p.id === phase)?.name}: 发送继续指令`
      };
    }

    return null;
  }
}

export default FrontendDesignPlugin;
