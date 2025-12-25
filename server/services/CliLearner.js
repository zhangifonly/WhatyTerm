/**
 * CliLearner - CLI 工具特征自动学习服务
 *
 * 通过 AI 分析网页内容和终端输出，自动提取 CLI 工具的配置信息
 */

import { AIEngine } from './AIEngine.js';
import cliRegistry from './CliRegistry.js';

class CliLearner {
  constructor() {
    this.aiEngine = new AIEngine();
  }

  /**
   * 从 URL 获取 CLI 工具信息
   * @param {string} url - CLI 工具的官网或文档 URL
   * @returns {Promise<object>} CLI 配置信息
   */
  async learnFromUrl(url) {
    try {
      // 获取网页内容
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WebTmux/1.0)'
        }
      });

      if (!response.ok) {
        throw new Error(`获取网页失败: ${response.status}`);
      }

      const html = await response.text();
      // 提取文本内容（简单去除 HTML 标签）
      const textContent = this._extractText(html).slice(0, 8000);

      return await this._analyzeWithAI(textContent, url);
    } catch (err) {
      console.error('[CliLearner] 从 URL 学习失败:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * 从终端内容学习 CLI 特征
   */
  async learnFromTerminal(terminalContent, processName) {
    try {
      const prompt = this._buildTerminalPrompt(terminalContent, processName);
      const result = await this.aiEngine.generateText(prompt);

      if (!result) {
        return { success: false, error: 'AI 分析失败' };
      }

      return this._parseAIResponse(result);
    } catch (err) {
      console.error('[CliLearner] 从终端学习失败:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * 提取 HTML 文本内容
   */
  _extractText(html) {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 使用 AI 分析内容
   */
  async _analyzeWithAI(content, url) {
    const prompt = this._buildUrlPrompt(content, url);

    try {
      const result = await this.aiEngine.generateText(prompt);
      if (!result) {
        return { success: false, error: 'AI 分析失败' };
      }
      return this._parseAIResponse(result);
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 构建 URL 分析提示词
   */
  _buildUrlPrompt(content, url) {
    return `分析以下 CLI 工具的网页内容，提取配置信息。

URL: ${url}

网页内容:
${content}

请返回 JSON 格式（不要 markdown）:
{
  "name": "工具名称",
  "id": "工具ID（小写，无空格）",
  "processNames": ["进程名1", "进程名2"],
  "terminalPatterns": {
    "running": ["运行中的正则特征"],
    "idle": ["空闲状态的正则特征"],
    "confirm": ["确认界面的正则特征"]
  },
  "commands": {
    "start": "启动命令",
    "quit": "退出命令"
  },
  "description": "简短描述"
}

注意：
1. processNames 应包含可能的进程名
2. terminalPatterns 中的正则要能匹配终端输出
3. 如果信息不足，相应字段留空数组`;
  }

  /**
   * 构建终端分析提示词
   */
  _buildTerminalPrompt(terminalContent, processName) {
    return `分析以下终端输出，提取 CLI 工具 "${processName}" 的特征。

终端内容:
${terminalContent.slice(-3000)}

请返回 JSON 格式（不要 markdown）:
{
  "name": "工具名称",
  "id": "${processName.toLowerCase()}",
  "processNames": ["${processName}"],
  "terminalPatterns": {
    "running": ["检测到的运行中特征正则"],
    "idle": ["检测到的空闲特征正则"],
    "confirm": ["检测到的确认界面特征正则"]
  },
  "commands": {
    "start": "启动命令",
    "quit": "退出命令"
  }
}

从终端输出中识别：
1. 运行中标志（如进度、时间、状态文字）
2. 空闲提示符（如 > 或特定提示）
3. 确认对话框特征`;
  }

  /**
   * 解析 AI 响应
   */
  _parseAIResponse(response) {
    try {
      // 提取 JSON
      let jsonStr = response;
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        jsonStr = match[0];
      }

      const config = JSON.parse(jsonStr);

      // 验证必要字段
      if (!config.name || !config.processNames) {
        return { success: false, error: '缺少必要字段' };
      }

      return {
        success: true,
        config: {
          id: config.id || config.name.toLowerCase().replace(/\s+/g, '-'),
          name: config.name,
          processNames: config.processNames || [],
          terminalPatterns: config.terminalPatterns || {},
          commands: config.commands || {},
          description: config.description || '',
          learnedAt: new Date().toISOString()
        }
      };
    } catch (err) {
      console.error('[CliLearner] 解析响应失败:', err);
      return { success: false, error: '解析 AI 响应失败' };
    }
  }

  /**
   * 学习并注册新工具
   */
  async learnAndRegister(source, data) {
    let result;

    if (source === 'url') {
      result = await this.learnFromUrl(data.url);
    } else if (source === 'terminal') {
      result = await this.learnFromTerminal(data.content, data.processName);
    } else {
      return { success: false, error: '未知来源类型' };
    }

    if (!result.success) {
      return result;
    }

    // 注册到 CliRegistry
    const registerResult = cliRegistry.registerTool(result.config);

    return {
      success: registerResult.success,
      tool: registerResult.tool,
      error: registerResult.error
    };
  }
}

// 导出单例
const cliLearner = new CliLearner();
export default cliLearner;
