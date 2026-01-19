import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 提示词加载器
 * 负责从 Markdown 文件加载和缓存提示词模板
 */
class PromptLoader {
  constructor() {
    this.cache = new Map();
    this.promptsDir = path.join(__dirname, 'prompts');
    this.commonDir = path.join(this.promptsDir, 'common');
  }

  /**
   * 加载提示词文件
   * @param {string} pluginId - 插件 ID
   * @param {string} phase - 阶段 ID
   * @returns {string} 提示词内容
   */
  load(pluginId, phase) {
    const cacheKey = `${pluginId}/${phase}`;

    // 检查缓存
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // 尝试加载文件
    const filePath = path.join(this.promptsDir, pluginId, `${phase}.md`);

    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        this.cache.set(cacheKey, content);
        return content;
      }
    } catch (err) {
      console.warn(`[PromptLoader] 加载提示词失败: ${cacheKey}`, err.message);
    }

    return null;
  }

  /**
   * 加载通用提示词片段
   * @param {string} name - 片段名称（不含扩展名）
   * @returns {string} 提示词内容
   */
  loadCommon(name) {
    const cacheKey = `common/${name}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const filePath = path.join(this.commonDir, `${name}.md`);

    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        this.cache.set(cacheKey, content);
        return content;
      }
    } catch (err) {
      console.warn(`[PromptLoader] 加载通用提示词失败: ${name}`, err.message);
    }

    return null;
  }

  /**
   * 组合提示词
   * 支持在提示词中使用 {{include:common/xxx}} 语法引用通用片段
   * @param {string} template - 提示词模板
   * @returns {string} 处理后的提示词
   */
  compose(template) {
    if (!template) return '';

    // 替换 {{include:common/xxx}} 为实际内容
    return template.replace(/\{\{include:common\/([^}]+)\}\}/g, (match, name) => {
      const content = this.loadCommon(name);
      return content || `<!-- 未找到: common/${name} -->`;
    });
  }

  /**
   * 获取插件的完整提示词
   * @param {string} pluginId - 插件 ID
   * @param {string} phase - 阶段 ID
   * @param {Object} context - 上下文变量
   * @returns {string} 处理后的提示词
   */
  getPrompt(pluginId, phase, context = {}) {
    let template = this.load(pluginId, phase);

    if (!template) {
      return null;
    }

    // 处理 include 指令
    template = this.compose(template);

    // 替换上下文变量 {{variable}}
    for (const [key, value] of Object.entries(context)) {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      template = template.replace(regex, String(value));
    }

    return template;
  }

  /**
   * 清除缓存
   * @param {string} [key] - 可选，指定清除的缓存键
   */
  clearCache(key) {
    if (key) {
      this.cache.delete(key);
    } else {
      this.cache.clear();
    }
  }

  /**
   * 重新加载所有提示词
   */
  reload() {
    this.clearCache();
    console.log('[PromptLoader] 缓存已清除，提示词将在下次访问时重新加载');
  }

  /**
   * 获取可用的提示词列表
   * @param {string} pluginId - 插件 ID
   * @returns {string[]} 阶段列表
   */
  listPrompts(pluginId) {
    const pluginDir = path.join(this.promptsDir, pluginId);

    try {
      if (fs.existsSync(pluginDir)) {
        return fs.readdirSync(pluginDir)
          .filter(f => f.endsWith('.md'))
          .map(f => f.replace('.md', ''));
      }
    } catch (err) {
      console.warn(`[PromptLoader] 列出提示词失败: ${pluginId}`, err.message);
    }

    return [];
  }

  /**
   * 检查提示词是否存在
   * @param {string} pluginId - 插件 ID
   * @param {string} phase - 阶段 ID
   * @returns {boolean}
   */
  exists(pluginId, phase) {
    const filePath = path.join(this.promptsDir, pluginId, `${phase}.md`);
    return fs.existsSync(filePath);
  }
}

// 创建单例
const promptLoader = new PromptLoader();

export { PromptLoader };
export default promptLoader;
