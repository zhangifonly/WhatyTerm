/**
 * ProjectTaskReader - 读取项目任务文件并生成初始化目标
 *
 * 支持读取以下文件：
 * - CLAUDE.md - Claude Code 项目说明
 * - .claude/ 目录下的任务文件
 * - TODO.md - 任务列表
 * - README.md - 项目说明
 */

import fs from 'fs/promises';
import path from 'path';

class ProjectTaskReader {
  constructor() {
    // 任务文件优先级列表（只读取最重要的几个）
    this.taskFiles = [
      'CLAUDE.md',
      'TODO.md',
      'README.md'
    ];

    // 最大读取字符数
    this.maxCharsPerFile = 1500;
    this.maxTotalChars = 3000;

    // 不再读取 .claude 目录下的文件，因为可能有几百个
  }

  /**
   * 读取项目任务文件
   * @param {string} workingDir - 项目工作目录
   * @returns {Promise<{files: Array, content: string}>}
   */
  async readTaskFiles(workingDir) {
    const result = {
      files: [],
      content: ''
    };

    if (!workingDir) return result;

    let totalChars = 0;

    for (const fileName of this.taskFiles) {
      if (totalChars >= this.maxTotalChars) break;

      const filePath = path.join(workingDir, fileName);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const truncated = content.slice(0, this.maxCharsPerFile);

        result.files.push(fileName);
        result.content += `\n=== ${fileName} ===\n${truncated}\n`;
        totalChars += truncated.length;
      } catch (err) {
        // 文件不存在，跳过
      }
    }

    return result;
  }

  /**
   * 使用 AI 生成项目初始化目标
   * @param {string} workingDir - 项目工作目录
   * @param {object} aiEngine - AI 引擎实例
   * @returns {Promise<string>} - 生成的初始化目标
   */
  async generateProjectGoal(workingDir, aiEngine) {
    const taskData = await this.readTaskFiles(workingDir);

    if (!taskData.content || taskData.files.length === 0) {
      return this.getDefaultGoal();
    }

    const projectName = workingDir.split('/').filter(Boolean).pop() || '项目';

    const prompt = `请根据以下项目文件内容，生成一个简洁的项目初始化目标（AI Agent 的工作目标）。

项目名称: ${projectName}
读取的文件: ${taskData.files.join(', ')}

文件内容:
${taskData.content}

要求:
1. 总结项目的核心任务和目标（1-2句话）
2. 目标应该是积极主动的，鼓励 AI 认真完成任务
3. 强调不逃避问题、不怕麻烦、积极解决
4. 输出格式：直接输出目标文本，不要有其他说明
5. 长度控制在 200 字以内`;

    try {
      // 使用 AI 生成目标
      const response = await this._callAI(prompt, aiEngine);
      if (response && response.trim()) {
        return response.trim();
      }
    } catch (err) {
      console.error('[ProjectTaskReader] AI 生成目标失败:', err.message);
    }

    // 如果 AI 调用失败，返回从文件提取的简单描述
    return this._extractSimpleDesc(taskData.content, projectName);
  }

  /**
   * 调用 AI API 生成文本
   */
  async _callAI(prompt, aiEngine) {
    if (!aiEngine) {
      return null;
    }

    try {
      // 使用 AIEngine 的简单文本生成方法
      const result = await aiEngine.generateText(prompt);
      return result;
    } catch (err) {
      console.error('[ProjectTaskReader] AI 调用失败:', err.message);
      return null;
    }
  }

  /**
   * 从文件内容提取简单描述
   */
  _extractSimpleDesc(content, projectName) {
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed &&
          !trimmed.startsWith('#') &&
          !trimmed.startsWith('===') &&
          !trimmed.startsWith('```') &&
          !trimmed.startsWith('-') &&
          !trimmed.startsWith('*') &&
          trimmed.length > 20 &&
          trimmed.length < 200) {
        return trimmed;
      }
    }
    return this.getDefaultGoal();
  }

  /**
   * 获取默认目标
   */
  getDefaultGoal() {
    return '当前在 AI 编程终端中运行，请积极主动地完成开发任务，在所有选项上选择认真负责的态度，不逃避问题、不怕麻烦，确保任务完整完成。';
  }

  /**
   * 快速获取项目描述（不调用 AI，用于显示）
   */
  async getQuickProjectDesc(workingDir) {
    if (!workingDir) return '';

    // 按优先级尝试读取文件
    const descFiles = ['CLAUDE.md', 'README.md', '.claude/future-plans.md'];

    for (const fileName of descFiles) {
      const filePath = path.join(workingDir, fileName);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < Math.min(lines.length, 30); i++) {
          const line = lines[i].trim();
          // 跳过标题、代码块、列表等
          if (line &&
              !line.startsWith('#') &&
              !line.startsWith('```') &&
              !line.startsWith('-') &&
              !line.startsWith('*') &&
              !line.startsWith('|') &&
              line.length > 10) {
            return line.slice(0, 150);
          }
        }
      } catch {}
    }

    return '';
  }
}

export default new ProjectTaskReader();
