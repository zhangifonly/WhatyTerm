import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// 验证路径是否在允许的目录内，防止路径遍历攻击
function isPathSafe(targetPath, baseDir) {
  const resolved = path.resolve(targetPath);
  const base = path.resolve(baseDir);
  return resolved.startsWith(base + path.sep) || resolved === base;
}

class ClaudeSessionFixer {
  constructor() {
    // Claude Code 项目目录
    this.claudeDir = path.join(os.homedir(), '.claude', 'projects');
  }

  /**
   * 检测终端内容中是否有 Claude Code API 错误
   * 包括 tool_use_id 错误和 thinking blocks 相关错误
   */
  detectApiError(terminalContent) {
    if (!terminalContent) return false;

    // 检测各类 API 错误
    const errorPatterns = [
      // tool_use_id 相关错误
      /API Error:\s*400.*tool_use_id/i,
      /tool_result.*block must have a corresponding.*tool_use/i,
      /unexpected `tool_use_id` found in `tool_result`/i,
      // thinking blocks 相关错误（不同 API 服务器对 thinking 支持不一致）
      /thinking.*is not supported/i,
      /extended_thinking.*not.*enabled/i,
      /thinking.*block.*not.*allowed/i,
      /interleaved.*thinking.*error/i,
      /API Error:\s*400.*thinking/i,
      /invalid.*thinking.*block/i,
      /invalid.*signature.*in.*thinking/i,  // thinking block 签名错误
      /thinking\.signature.*Field required/i,  // 新增：thinking.signature: Field required
      /signature.*Field required/i,  // 新增：通用签名字段缺失
      // 通用会话污染错误
      /unexpected.*content.*type/i,
      /invalid.*message.*format/i
    ];

    return errorPatterns.some(pattern => pattern.test(terminalContent));
  }

  /**
   * 查找当前工作目录对应的 Claude Code 会话文件
   */
  async findSessionFile(workingDir) {
    try {
      // 验证 workingDir 是有效的绝对路径
      if (!workingDir || typeof workingDir !== 'string' || !path.isAbsolute(workingDir)) {
        console.log(`[ClaudeSessionFixer] 无效的工作目录: ${workingDir}`);
        return null;
      }

      // 将工作目录路径转换为 Claude Code 项目目录格式
      // 例如: /Users/xxx/Documents/ClaudeCode/WebTmux -> -Users-xxx-Documents-ClaudeCode-WebTmux
      // 注意：保留开头的 -，这是 Claude Code 的目录命名规则
      const projectDirName = workingDir.replace(/\//g, '-');
      const projectPath = path.join(this.claudeDir, projectDirName);

      // 验证路径安全性，防止路径遍历攻击
      if (!isPathSafe(projectPath, this.claudeDir)) {
        console.error(`[ClaudeSessionFixer] 路径安全检查失败: ${projectPath}`);
        return null;
      }

      // 检查目录是否存在
      try {
        await fs.access(projectPath);
      } catch {
        console.log(`[ClaudeSessionFixer] 项目目录不存在: ${projectPath}`);
        return null;
      }

      // 查找最近修改的 .jsonl 文件（排除 agent- 开头的文件）
      const files = await fs.readdir(projectPath);
      const jsonlFiles = files.filter(f =>
        f.endsWith('.jsonl') &&
        !f.startsWith('agent-') &&
        !f.endsWith('.backup')
      );

      if (jsonlFiles.length === 0) {
        console.log(`[ClaudeSessionFixer] 未找到会话文件: ${projectPath}`);
        return null;
      }

      // 获取文件的修改时间，找到最新的
      const fileStats = await Promise.all(
        jsonlFiles.map(async (file) => {
          const filePath = path.join(projectPath, file);
          const stat = await fs.stat(filePath);
          return { file: filePath, mtime: stat.mtime };
        })
      );

      fileStats.sort((a, b) => b.mtime - a.mtime);
      return fileStats[0].file;

    } catch (err) {
      console.error('[ClaudeSessionFixer] 查找会话文件失败:', err.message);
      return null;
    }
  }

  /**
   * 修复会话文件（移除 thinking blocks）
   * 算法参考 claude_session_fixer_v3.py
   */
  async fixSessionFile(filepath) {
    try {
      // 验证文件
      if (!filepath || !filepath.endsWith('.jsonl')) {
        return { success: false, error: '无效的文件路径' };
      }

      // 验证路径安全性，防止路径遍历攻击
      if (!isPathSafe(filepath, this.claudeDir)) {
        console.error(`[ClaudeSessionFixer] 路径安全检查失败: ${filepath}`);
        return { success: false, error: '路径安全检查失败' };
      }

      // 检查文件是否存在
      try {
        await fs.access(filepath);
      } catch {
        return { success: false, error: '文件不存在' };
      }

      // 创建备份
      const backupPath = filepath + '.backup';
      await fs.copyFile(filepath, backupPath);
      console.log(`[ClaudeSessionFixer] 已创建备份: ${backupPath}`);

      // 读取文件
      const content = await fs.readFile(filepath, 'utf-8');
      const lines = content.split('\n');

      // 处理每一行
      const fixedLines = [];
      let removedCount = 0;

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const data = JSON.parse(line);

          // 处理 message.content 数组
          if (data.message && data.message.content && Array.isArray(data.message.content)) {
            const originalLen = data.message.content.length;

            // 移除 thinking 类型的内容块（完全移除，包括有 signature 的）
            data.message.content = data.message.content.filter(c => {
              if (typeof c === 'object' && c.type === 'thinking') {
                return false;  // 移除所有 thinking blocks
              }
              // 也移除可能残留的 signature 字段
              if (typeof c === 'object' && c.signature) {
                delete c.signature;
              }
              return true;
            });

            removedCount += originalLen - data.message.content.length;
          }

          // 也检查顶层 content 数组（某些格式）
          if (data.content && Array.isArray(data.content)) {
            const originalLen = data.content.length;

            data.content = data.content.filter(c => {
              if (typeof c === 'object' && c.type === 'thinking') {
                return false;
              }
              if (typeof c === 'object' && c.signature) {
                delete c.signature;
              }
              return true;
            });

            removedCount += originalLen - data.content.length;
          }

          fixedLines.push(JSON.stringify(data) + '\n');
        } catch (jsonErr) {
          // 保留无法解析的行
          fixedLines.push(line);
        }
      }

      // 写回文件
      await fs.writeFile(filepath, fixedLines.join(''), 'utf-8');

      console.log(`[ClaudeSessionFixer] 修复完成！移除了 ${removedCount} 个 thinking blocks`);

      return {
        success: true,
        backupPath,
        removedCount,
        message: `修复完成！移除了 ${removedCount} 个 thinking blocks。备份文件: ${backupPath}`
      };

    } catch (err) {
      console.error('[ClaudeSessionFixer] 修复失败:', err);

      // 尝试从备份恢复
      const backupPath = filepath + '.backup';
      try {
        await fs.access(backupPath);
        await fs.copyFile(backupPath, filepath);
        console.log('[ClaudeSessionFixer] 已从备份恢复');
      } catch {
        // 备份不存在或恢复失败
      }

      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * 自动检测并修复（主入口）
   */
  async autoFixIfNeeded(terminalContent, workingDir) {
    // 1. 检测是否有 API 错误
    if (!this.detectApiError(terminalContent)) {
      return { needed: false };
    }

    console.log('[ClaudeSessionFixer] 检测到 Claude Code API 错误，开始自动修复...');

    // 2. 查找会话文件
    const sessionFile = await this.findSessionFile(workingDir);
    if (!sessionFile) {
      return {
        needed: true,
        success: false,
        error: '未找到对应的会话文件'
      };
    }

    console.log(`[ClaudeSessionFixer] 找到会话文件: ${sessionFile}`);

    // 3. 修复文件
    const result = await this.fixSessionFile(sessionFile);

    return {
      needed: true,
      ...result,
      sessionFile
    };
  }
}

export default new ClaudeSessionFixer();
