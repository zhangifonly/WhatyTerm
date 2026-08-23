import DeclarativePlugin from '../DeclarativePlugin.js';

/**
 * 前端设计监控策略插件
 * 针对 UI/UX 设计开发场景
 *
 * 骨架统一在 DeclarativePlugin，这里只声明数据（原实现逐字等价）。
 */
const definition = {
  id: 'frontend-design',
  name: '前端设计',
  description: '前端设计开发监控策略，支持需求分析、原型设计、组件开发、样式调整、响应式适配等阶段',
  version: '2.0.0',

  projectPatterns: [
    /ui.*design|ux.*design|界面设计/i,
    /frontend.*design|前端设计/i,
    /figma|sketch|adobe.*xd/i,
    /css|scss|sass|less|stylus/i,
    /tailwind|styled.*component|emotion/i,
    /responsive|响应式|mobile.*first/i,
    /component.*library|组件库/i
  ],

  phases: [
    { id: 'requirements', name: '需求分析', priority: 1 },
    { id: 'prototype', name: '原型设计', priority: 2 },
    { id: 'components', name: '组件开发', priority: 3 },
    { id: 'styling', name: '样式调整', priority: 4 },
    { id: 'responsive', name: '响应式适配', priority: 5 }
  ],

  // 按顺序匹配，命中即返回（顺序与原 detectPhase 的 if 链一致）
  phaseRules: [
    { phase: 'responsive', any: /responsive|响应式|media.*query|breakpoint|mobile|tablet/i },
    { phase: 'styling', any: /style|样式|css|color|font|spacing|margin|padding/i },
    { phase: 'components', any: /component|组件|button|input|modal|card|form/i },
    { phase: 'prototype', any: /prototype|原型|wireframe|线框|mockup|layout|布局/i },
  ],
  defaultPhase: 'requirements',

  phaseConfigs: {
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
  },

  completePattern: /design.*complete|设计完成|ui.*done|界面完成/i,
  completeMessage: '前端设计完成',
  onWarning: {
    needsAction: true,
    actionType: 'warning',
    suggestedAction: '检查样式问题',
  },
  idlePrefix: '前端设计'
};

class FrontendDesignPlugin extends DeclarativePlugin {
  constructor() {
    super(definition);
  }
}

export default FrontendDesignPlugin;
