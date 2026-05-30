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

    // 移除换行符和多余空格以处理跨行的错误信息（如 "th\ninking.signature"）
    const cleanContent = terminalContent.replace(/\r?\n\s*/g, '');

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
      /thinking\.signature.*Field required/i,  // thinking.signature: Field required
      /thinking\.signature:\s*Field required/i,  // JSON 格式的签名字段缺失
      /"signature":\s*"Field required"/i,  // JSON 格式的签名字段缺失错误
      // 通用会话污染错误
      /unexpected.*content.*type/i,
      /invalid.*message.*format/i,
      // 空内容错误（移除 thinking 后 content 变空）
      /text content blocks must be non-empty/i,
      /content blocks must be non-empty/i,
      // 请求格式错误（上游 API 不支持某些字段）
      /Improperly formed request/i
    ];

    // 调试：检查每个模式
    for (const pattern of errorPatterns) {
      if (pattern.test(cleanContent)) {
        console.log(`[ClaudeSessionFixer] 匹配到错误模式: ${pattern.source}`);
        return true;
      }
    }

    return false;
  }

  /**
   * 检测终端内容中是否有 Settings Error
   * 返回 { hasError: boolean, settingsPath: string | null }
   */
  detectSettingsError(terminalContent) {
    if (!terminalContent) return { hasError: false, settingsPath: null };

    // 检测 "Settings Error" 关键字
    if (!terminalContent.includes('Settings Error')) {
      return { hasError: false, settingsPath: null };
    }

    // 提取 settings.local.json 文件路径
    const pathMatch = terminalContent.match(/([\/\w\-\.]+\/\.claude\/settings\.local\.json)/);
    const settingsPath = pathMatch ? pathMatch[1] : null;

    console.log(`[ClaudeSessionFixer] 检测到 Settings Error, 路径: ${settingsPath}`);
    return { hasError: true, settingsPath };
  }

  /**
   * 修复 settings.local.json 文件（删除 permissions 部分）
   */
  async fixSettingsError(settingsPath) {
    if (!settingsPath) {
      return { success: false, error: '未找到 settings.local.json 路径' };
    }

    try {
      // 读取文件
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);

      // 删除 permissions 部分
      if (settings.permissions) {
        delete settings.permissions;
        console.log(`[ClaudeSessionFixer] 删除 permissions 配置`);
      }

      // 写回文件
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      console.log(`[ClaudeSessionFixer] 已修复 settings.local.json: ${settingsPath}`);

      return { success: true, path: settingsPath };
    } catch (err) {
      console.error(`[ClaudeSessionFixer] 修复 settings.local.json 失败:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * 扫描所有 Claude Code 项目目录，找到最近修改的会话文件
   * 当无法确定工作目录时使用此方法作为备用
   */
  async findMostRecentSessionFile() {
    try {
      // 检查 Claude Code 项目目录是否存在
      try {
        await fs.access(this.claudeDir);
      } catch {
        console.log(`[ClaudeSessionFixer] Claude Code 项目目录不存在: ${this.claudeDir}`);
        return null;
      }

      // 获取所有项目目录
      const projectDirs = await fs.readdir(this.claudeDir);

      let mostRecentFile = null;
      let mostRecentTime = 0;

      for (const dir of projectDirs) {
        const projectPath = path.join(this.claudeDir, dir);

        // 跳过非目录
        try {
          const stat = await fs.stat(projectPath);
          if (!stat.isDirectory()) continue;
        } catch {
          continue;
        }

        // 查找该项目目录下的 .jsonl 文件
        try {
          const files = await fs.readdir(projectPath);
          const jsonlFiles = files.filter(f =>
            f.endsWith('.jsonl') &&
            !f.startsWith('agent-') &&
            !f.endsWith('.backup')
          );

          for (const file of jsonlFiles) {
            const filePath = path.join(projectPath, file);
            try {
              const stat = await fs.stat(filePath);
              if (stat.mtime.getTime() > mostRecentTime) {
                mostRecentTime = stat.mtime.getTime();
                mostRecentFile = filePath;
              }
            } catch {
              continue;
            }
          }
        } catch {
          continue;
        }
      }

      if (mostRecentFile) {
        console.log(`[ClaudeSessionFixer] 找到最近修改的会话文件: ${mostRecentFile}`);
      }

      return mostRecentFile;
    } catch (err) {
      console.error('[ClaudeSessionFixer] 扫描项目目录失败:', err.message);
      return null;
    }
  }

  /**
   * 查找当前工作目录对应的 Claude Code 会话文件
   */
  async findSessionFile(workingDir) {
    try {
      // 验证 workingDir 是有效的绝对路径
      if (!workingDir || typeof workingDir !== 'string' || !path.isAbsolute(workingDir)) {
        console.log(`[ClaudeSessionFixer] 无效的工作目录: ${workingDir}，尝试查找最近修改的会话文件`);
        // 备用方案：扫描所有项目目录找最近修改的文件
        return await this.findMostRecentSessionFile();
      }

      // 将工作目录路径转换为 Claude Code 项目目录格式
      // 例如: /Users/xxx/Documents/ClaudeCode/WebTmux -> -Users-xxx-Documents-ClaudeCode-WebTmux
      // Windows: D:\AI\ClaudeCode\test -> D--AI-ClaudeCode-test
      // 注意：Claude Code 把所有路径分隔符和冒号都替换为 -
      const projectDirName = workingDir
        .replace(/:/g, '-')   // 替换冒号为 -（Windows 盘符）
        .replace(/\\/g, '-')  // 替换反斜杠（Windows）
        .replace(/\//g, '-'); // 替换正斜杠（Unix）
      const projectPath = path.join(this.claudeDir, projectDirName);
      console.log(`[ClaudeSessionFixer] 查找会话文件: workingDir=${workingDir}, projectDirName=${projectDirName}, projectPath=${projectPath}`);

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

      let removedCount = 0;
      let fixedEmptyCount = 0;
      let removedMessagesCount = 0;

      // 移除 thinking / redacted_thinking 块，并清理残留签名与空 text 块
      const cleanBlocks = (arr) => {
        const originalLen = arr.length;
        let blocks = arr.filter(c =>
          !(c && typeof c === 'object' && (c.type === 'thinking' || c.type === 'redacted_thinking'))
        );
        removedCount += originalLen - blocks.length;
        // 删除残留 signature 字段（thinking 外的块上不应携带）
        for (const c of blocks) {
          if (c && typeof c === 'object' && c.signature !== undefined) delete c.signature;
        }
        // 移除空 text 块
        blocks = blocks.filter(c => {
          if (c && typeof c === 'object' && c.type === 'text' && (!c.text || c.text.trim() === '')) {
            fixedEmptyCount++;
            return false;
          }
          return true;
        });
        return blocks;
      };

      // 第一遍：逐行清理，记录被删除条目的 uuid -> parentUuid，用于后续重链
      // Claude Code 把每个 thinking 块单独存为一行，并通过 uuid/parentUuid 串成链；
      // 直接删除这些行会让后续行的 parentUuid 悬空，导致 `claude -c` 重建对话时断链。
      const entries = [];               // { data } 或 { raw }
      const deletedParent = new Map();  // 被删除条目 uuid -> 其 parentUuid

      for (const line of lines) {
        if (!line.trim()) continue;

        let data;
        try {
          data = JSON.parse(line);
        } catch {
          entries.push({ raw: line });   // 保留无法解析的行
          continue;
        }

        if (data.message && Array.isArray(data.message.content)) {
          data.message.content = cleanBlocks(data.message.content);

          if (data.message.content.length === 0) {
            if (data.message.role === 'assistant') {
              // assistant 内容清空（典型为 thinking-only 行）：删除整条并记录重链关系
              removedMessagesCount++;
              if (data.uuid) deletedParent.set(data.uuid, data.parentUuid ?? null);
              continue;
            }
            // user 内容清空：补占位 text 块，保持链完整
            data.message.content = [{ type: 'text', text: '.' }];
            fixedEmptyCount++;
          }
        }

        // 也检查顶层 content 数组（某些格式）
        if (Array.isArray(data.content)) {
          data.content = cleanBlocks(data.content);
        }

        // 清理可能导致 "Improperly formed request" 的顶层字段
        if (data.thinking) delete data.thinking;
        if (data.budget_tokens !== undefined) delete data.budget_tokens;

        entries.push({ data });
      }

      // 沿 parentUuid 链向上跳过所有已删除条目，得到最近的存活祖先
      const resolveParent = (uuid) => {
        const seen = new Set();
        let cur = uuid;
        while (cur && deletedParent.has(cur) && !seen.has(cur)) {
          seen.add(cur);
          cur = deletedParent.get(cur);
        }
        return cur;
      };

      // 第二遍：重链幸存条目的 parentUuid，避免删除 thinking 行后断链
      const fixedLines = [];
      let relinkedCount = 0;
      for (const e of entries) {
        if (e.raw !== undefined) {
          fixedLines.push(e.raw + '\n');
          continue;
        }
        const data = e.data;
        if (data.parentUuid && deletedParent.has(data.parentUuid)) {
          data.parentUuid = resolveParent(data.parentUuid);
          relinkedCount++;
        }
        fixedLines.push(JSON.stringify(data) + '\n');
      }

      // 写回文件
      await fs.writeFile(filepath, fixedLines.join(''), 'utf-8');
      if (relinkedCount > 0) {
        console.log(`[ClaudeSessionFixer] 重链 ${relinkedCount} 条记录的 parentUuid，保持对话链完整`);
      }

      console.log(`[ClaudeSessionFixer] 修复完成！移除 ${removedCount} 个 thinking blocks, 修复 ${fixedEmptyCount} 个空内容, 删除 ${removedMessagesCount} 条空消息`);

      return {
        success: true,
        backupPath,
        removedCount,
        fixedEmptyCount,
        removedMessagesCount,
        message: `修复完成！移除 ${removedCount} 个 thinking blocks, 修复 ${fixedEmptyCount} 个空内容, 删除 ${removedMessagesCount} 条空消息`
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
    const hasError = this.detectApiError(terminalContent);
    console.log(`[ClaudeSessionFixer] detectApiError 结果: ${hasError}`);
    if (!hasError) {
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

  /**
   * 快速检测会话文件是否有问题（不修复，仅扫描）
   * @returns {object} { hasIssues, thinkingCount, emptyTextCount, signatureCount }
   */
  async quickScanFile(filepath) {
    try {
      const content = await fs.readFile(filepath, 'utf-8');
      const lines = content.split('\n');
      let thinkingCount = 0;
      let emptyTextCount = 0;
      let signatureCount = 0;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          const msgContent = data.message?.content;
          if (Array.isArray(msgContent)) {
            for (const block of msgContent) {
              if (!block || typeof block !== 'object') continue;
              if (block.type === 'thinking' || block.type === 'redacted_thinking') thinkingCount++;
              if (block.signature !== undefined) signatureCount++;
              if (block.type === 'text' && (!block.text || block.text.trim() === '')) emptyTextCount++;
            }
          }
        } catch {
          continue;
        }
      }

      return {
        hasIssues: thinkingCount > 0 || emptyTextCount > 0,
        thinkingCount,
        emptyTextCount,
        signatureCount
      };
    } catch (err) {
      return { hasIssues: false, thinkingCount: 0, emptyTextCount: 0, signatureCount: 0, error: err.message };
    }
  }

  /**
   * 主动扫描并修复所有有问题的会话文件
   * 定期调用，在错误发生前就清理 thinking 块和空 text 块
   * @param {number} maxAgeDays - 只扫描最近 N 天内修改的文件
   * @returns {object} { scanned, fixed, errors, details }
   */
  async proactiveScanAndFix(maxAgeDays = 7) {
    const startTime = Date.now();
    const results = { scanned: 0, fixed: 0, errors: 0, details: [] };

    try {
      await fs.access(this.claudeDir);
    } catch {
      return results;
    }

    const projectDirs = await fs.readdir(this.claudeDir);
    const cutoff = Date.now() - maxAgeDays * 86400000;

    for (const dir of projectDirs) {
      const projectPath = path.join(this.claudeDir, dir);
      try {
        const stat = await fs.stat(projectPath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      try {
        const files = await fs.readdir(projectPath);
        const jsonlFiles = files.filter(f =>
          f.endsWith('.jsonl') &&
          !f.startsWith('agent-') &&
          !f.endsWith('.backup')
        );

        for (const file of jsonlFiles) {
          const filePath = path.join(projectPath, file);
          try {
            const stat = await fs.stat(filePath);
            if (stat.mtime.getTime() < cutoff) continue;

            results.scanned++;
            const scan = await this.quickScanFile(filePath);

            if (scan.hasIssues) {
              console.log(`[ClaudeSessionFixer] 主动修复: ${dir}/${file} (thinking=${scan.thinkingCount}, emptyText=${scan.emptyTextCount})`);
              const fixResult = await this.fixSessionFile(filePath);
              if (fixResult.success) {
                results.fixed++;
                results.details.push({
                  project: dir.replace(/-Users-[^-]+-Documents-ClaudeCode-/, ''),
                  file: file.substring(0, 12),
                  thinking: fixResult.removedCount,
                  emptyText: fixResult.fixedEmptyCount,
                  removedMessages: fixResult.removedMessagesCount
                });
              } else {
                results.errors++;
              }
            }
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (results.fixed > 0) {
      console.log(`[ClaudeSessionFixer] 主动扫描完成: 扫描 ${results.scanned} 个文件，修复 ${results.fixed} 个，耗时 ${elapsed}s`);
    }

    return results;
  }
}

export default new ClaudeSessionFixer();
