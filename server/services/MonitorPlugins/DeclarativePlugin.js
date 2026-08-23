import BasePlugin from './BasePlugin.js';
import promptLoader from './PromptLoader.js';

/**
 * 声明式监控插件基类
 *
 * 背景（P3）：有 7 个插件（前端设计/安全审计/计划执行/API集成/文档处理/科研/TDD）
 * 逐字复制了同一套骨架，1300 多行代码里真正不同的只是正则和文案。任何一处骨架级
 * 修复（比如给 detectPhase 加一条规则）都得改 7 遍，实际上从来只改了其中一两个。
 *
 * 这里把骨架收成一份，各插件只提供数据定义。行为与原实现逐字等价，
 * 由 tests/test-declarative-plugins.mjs 对照锁定。
 *
 * 定义对象结构见 plugins/definitions/*.js 与下方 JSDoc。
 */
class DeclarativePlugin extends BasePlugin {
  /**
   * @param {object} def - 插件定义
   * @param {string} def.id/name/description/version
   * @param {RegExp[]} def.projectPatterns - 命中任一即认领该项目
   * @param {Array<{id:string,name:string,priority:number}>} def.phases
   * @param {Array<{phase:string,any:RegExp,all?:RegExp}>} def.phaseRules
   *   按顺序匹配，命中即返回；all 存在时须同时满足（TDD 的"通过/失败"要配合 test 关键词）
   * @param {string} def.defaultPhase - 所有规则都不命中时的阶段
   * @param {object} def.phaseConfigs - 阶段 id -> 配置
   * @param {RegExp} def.completePattern - 命中即视为该插件的工作完成
   * @param {string} def.completeMessage
   * @param {object} def.onWarning - 命中 warningPatterns 时返回的状态形状
   * @param {string} def.idlePrefix - 空闲提示消息的前缀
   */
  constructor(def) {
    super();
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.description = def.description;
    this.version = def.version || '2.0.0';
    this.projectPatterns = def.projectPatterns;
    this.phases = def.phases;
  }

  matches(projectContext) {
    const { projectPath, projectDesc, workingDir, goal } = projectContext;
    const searchText = `${projectPath || ''} ${projectDesc || ''} ${workingDir || ''} ${goal || ''}`;
    return this.projectPatterns.some(p => p.test(searchText));
  }

  detectPhase(terminalContent, projectContext) {
    const lastLines = terminalContent.split('\n').slice(-40).join('\n');
    for (const rule of this.def.phaseRules) {
      if (!rule.any.test(lastLines)) continue;
      if (rule.all && !rule.all.test(lastLines)) continue;
      return rule.phase;
    }
    return this.def.defaultPhase;
  }

  getPhaseConfig(phase) {
    const configs = this.def.phaseConfigs;
    const config = configs[phase] || configs[this.def.defaultPhase];
    // 提示词仍从文件加载，保持各插件的 prompts/ 目录不变
    const promptTemplate = promptLoader.getPrompt(this.id, phase) || '';
    return { ...config, promptTemplate };
  }

  analyzeStatus(terminalContent, phase, context) {
    const config = this.getPhaseConfig(phase);
    const lastLines = terminalContent.split('\n').slice(-20).join('\n');

    if (this.def.completePattern.test(lastLines)) {
      return {
        needsAction: false,
        actionType: 'success',
        suggestedAction: null,
        phase,
        phaseConfig: config,
        message: this.def.completeMessage
      };
    }

    for (const pattern of config.warningPatterns || []) {
      if (pattern.test(lastLines)) {
        return { ...this.def.onWarning, phase, phaseConfig: config };
      }
    }

    if (config.autoActionEnabled && this.isIdle(terminalContent)) {
      return {
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: config.autoActions[0],
        phase,
        phaseConfig: config,
        message: `${this.def.idlePrefix} - ${this.phases.find(p => p.id === phase)?.name}: 发送继续指令`
      };
    }

    return null;
  }
}

export default DeclarativePlugin;
