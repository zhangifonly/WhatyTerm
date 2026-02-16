import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import subscriptionService from '../SubscriptionService.js';

// 获取当前目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 监控策略插件管理器
 * 负责加载、注册和选择监控策略插件
 */
class PluginManager {
  constructor() {
    this.plugins = new Map();
    this.defaultPlugin = null;
    this.initialized = false;
    this.subscriptionService = subscriptionService;
  }

  /**
   * 检查插件是否可用（基于订阅状态）
   * @param {string} pluginId - 插件 ID
   * @returns {boolean} 是否可用
   */
  isPluginAvailable(pluginId) {
    return this.subscriptionService.isPluginAvailable(pluginId);
  }

  /**
   * 注册插件
   * @param {BasePlugin} plugin - 插件实例
   */
  register(plugin) {
    if (!plugin || !plugin.id) {
      console.warn('[PluginManager] 无效的插件，跳过注册');
      return;
    }

    this.plugins.set(plugin.id, plugin);
    console.log(`[PluginManager] 注册插件: ${plugin.name} (${plugin.id})`);

    // 设置默认插件
    if (plugin.id === 'default') {
      this.defaultPlugin = plugin;
    }
  }

  /**
   * 加载内置插件
   */
  async loadBuiltinPlugins() {
    const pluginsDir = path.join(__dirname, 'plugins');

    try {
      // 动态导入内置插件
      const { default: DefaultPlugin } = await import('./plugins/DefaultPlugin.js');
      const { default: PaperWritingPlugin } = await import('./plugins/PaperWritingPlugin.js');
      const { default: AppDevPlugin } = await import('./plugins/AppDevPlugin.js');
      const { default: DataAnalysisPlugin } = await import('./plugins/DataAnalysisPlugin.js');
      const { default: DeploymentPlugin } = await import('./plugins/DeploymentPlugin.js');
      const { default: FullStackDevPlugin } = await import('./plugins/FullStackDevPlugin.js');
      const { default: CodeReviewPlugin } = await import('./plugins/CodeReviewPlugin.js');
      const { default: RefactoringPlugin } = await import('./plugins/RefactoringPlugin.js');
      const { default: BugFixPlugin } = await import('./plugins/BugFixPlugin.js');
      const { default: ScientificResearchPlugin } = await import('./plugins/ScientificResearchPlugin.js');
      const { default: TDDDevelopmentPlugin } = await import('./plugins/TDDDevelopmentPlugin.js');
      const { default: FrontendDesignPlugin } = await import('./plugins/FrontendDesignPlugin.js');
      const { default: APIIntegrationPlugin } = await import('./plugins/APIIntegrationPlugin.js');
      const { default: SecurityAuditPlugin } = await import('./plugins/SecurityAuditPlugin.js');
      const { default: DocumentProcessingPlugin } = await import('./plugins/DocumentProcessingPlugin.js');
      const { default: PlanExecutionPlugin } = await import('./plugins/PlanExecutionPlugin.js');

      // 注册插件（顺序很重要，default 应该最后注册作为兜底）
      this.register(new FullStackDevPlugin());  // 全栈开发插件
      this.register(new PaperWritingPlugin());
      this.register(new AppDevPlugin());
      this.register(new DataAnalysisPlugin());
      this.register(new DeploymentPlugin());
      this.register(new CodeReviewPlugin());    // 代码审查插件
      this.register(new RefactoringPlugin());   // 重构优化插件
      this.register(new BugFixPlugin());        // Bug 修复插件
      this.register(new ScientificResearchPlugin());   // 科学研究插件
      this.register(new TDDDevelopmentPlugin());       // TDD 开发插件
      this.register(new FrontendDesignPlugin());       // 前端设计插件
      this.register(new APIIntegrationPlugin());       // API 集成插件
      this.register(new SecurityAuditPlugin());        // 安全审计插件
      this.register(new DocumentProcessingPlugin());   // 文档处理插件
      this.register(new PlanExecutionPlugin());        // 计划执行插件
      this.register(new DefaultPlugin());

      console.log(`[PluginManager] 内置插件加载完成，共 ${this.plugins.size} 个`);
    } catch (error) {
      console.error('[PluginManager] 加载内置插件失败:', error);
    }
  }

  /**
   * 加载自定义插件
   * @param {string} customDir - 自定义插件目录
   */
  async loadCustomPlugins(customDir) {
    const dir = customDir || path.join(__dirname, 'custom');

    if (!fs.existsSync(dir)) {
      console.log('[PluginManager] 自定义插件目录不存在，跳过');
      return;
    }

    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));

      for (const file of files) {
        try {
          const pluginPath = path.join(dir, file);
          const { default: PluginClass } = await import(`file://${pluginPath}`);

          if (PluginClass && typeof PluginClass === 'function') {
            const plugin = new PluginClass();
            this.register(plugin);
          }
        } catch (err) {
          console.warn(`[PluginManager] 加载自定义插件 ${file} 失败:`, err.message);
        }
      }

      console.log(`[PluginManager] 自定义插件加载完成`);
    } catch (error) {
      console.error('[PluginManager] 加载自定义插件目录失败:', error);
    }
  }

  /**
   * 初始化插件管理器
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    await this.loadBuiltinPlugins();
    await this.loadCustomPlugins();

    this.initialized = true;
    console.log(`[PluginManager] 初始化完成，可用插件: ${this.listPluginIds().join(', ')}`);
  }

  /**
   * 根据项目上下文选择合适的插件
   * @param {Object} projectContext - 项目上下文
   * @param {string} forcedPluginId - 强制使用的插件 ID（可选）
   * @returns {BasePlugin} 选中的插件
   */
  selectPlugin(projectContext, forcedPluginId = null) {
    // 如果指定了插件 ID，直接返回
    if (forcedPluginId && forcedPluginId !== 'auto') {
      const plugin = this.plugins.get(forcedPluginId);
      if (plugin) {
        return plugin;
      }
      console.warn(`[PluginManager] 指定的插件 ${forcedPluginId} 不存在，使用自动选择`);
    }

    // 自动选择：遍历所有非默认插件，找到第一个匹配的
    for (const plugin of this.plugins.values()) {
      if (plugin.id !== 'default' && plugin.matches(projectContext)) {
        console.log(`[PluginManager] 自动选择插件: ${plugin.name} (${plugin.id})`);
        return plugin;
      }
    }

    // 没有匹配的，返回默认插件
    console.log('[PluginManager] 使用默认插件');
    return this.defaultPlugin;
  }

  /**
   * 获取插件
   * @param {string} pluginId - 插件 ID
   * @returns {BasePlugin|null} 插件实例
   */
  getPlugin(pluginId) {
    return this.plugins.get(pluginId) || null;
  }

  /**
   * 获取所有插件 ID
   * @returns {Array<string>} 插件 ID 列表
   */
  listPluginIds() {
    return Array.from(this.plugins.keys());
  }

  /**
   * 获取所有插件信息
   * @returns {Array<Object>} 插件信息列表
   */
  listPlugins() {
    return Array.from(this.plugins.values()).map(p => ({
      ...p.getInfo(),
      available: this.isPluginAvailable(p.id),
      requiresSubscription: !this.subscriptionService.isPluginAvailable(p.id) && p.id !== 'default'
    }));
  }

  /**
   * 获取可用插件列表（已订阅的）
   * @returns {Array<Object>} 可用插件信息列表
   */
  listAvailablePlugins() {
    return this.listPlugins().filter(p => p.available);
  }

  /**
   * 获取订阅状态
   * @returns {Object} 订阅状态信息
   */
  getSubscriptionStatus() {
    return this.subscriptionService.getStatus();
  }

  /**
   * 获取插件数量
   * @returns {number} 插件数量
   */
  get size() {
    return this.plugins.size;
  }
}

// 创建单例
const pluginManager = new PluginManager();

export { PluginManager };
export default pluginManager;
