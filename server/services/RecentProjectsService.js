import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const HOME_DIR = os.homedir();

/**
 * 获取各 CLI 工具的最近项目列表
 */
export class RecentProjectsService {

  /**
   * 获取项目简介
   * 优先级: package.json description > README.md 第一段
   */
  static _getProjectDescription(projectPath) {
    try {
      // 1. 尝试从 package.json 获取
      const pkgPath = path.join(projectPath, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.description) {
          return pkg.description.slice(0, 100);
        }
      }

      // 2. 尝试从 README.md 获取第一段
      const readmeNames = ['README.md', 'readme.md', 'README.MD', 'Readme.md'];
      for (const name of readmeNames) {
        const readmePath = path.join(projectPath, name);
        if (fs.existsSync(readmePath)) {
          const content = fs.readFileSync(readmePath, 'utf-8');
          const lines = content.split('\n');

          // 跳过标题行和空行，找第一段正文
          for (const line of lines) {
            const trimmed = line.trim();
            // 跳过空行、标题、徽章图片、HTML标签
            if (!trimmed ||
                trimmed.startsWith('#') ||
                trimmed.startsWith('![') ||
                trimmed.startsWith('<') ||
                trimmed.startsWith('[![')) {
              continue;
            }
            // 找到第一段正文
            return trimmed.slice(0, 100);
          }
        }
      }

      return '';
    } catch {
      return '';
    }
  }

  /**
   * 获取所有 CLI 的最近项目
   * @param {number} limit - 每个 CLI 返回的最大项目数
   */
  static async getAllRecentProjects(limit = 10) {
    const [claude, codex, gemini] = await Promise.all([
      this.getClaudeProjects(limit),
      this.getCodexProjects(limit),
      this.getGeminiProjects(limit)
    ]);

    return { claude, codex, gemini };
  }

  /**
   * 解码 Claude 项目目录名为实际路径
   * Claude 编码规则: / -> -，但目录名中的 - 保持不变
   * 需要逐级验证路径是否存在
   */
  static _decodeClaudePath(encodedName) {
    // 去掉开头的 -，然后按 - 分割
    const parts = encodedName.replace(/^-/, '').split('-');

    // 逐级构建路径，合并不存在的部分
    let currentPath = '/';
    let i = 0;

    while (i < parts.length) {
      // 尝试单个部分
      let testPath = path.join(currentPath, parts[i]);

      if (fs.existsSync(testPath)) {
        currentPath = testPath;
        i++;
      } else {
        // 尝试合并多个部分（处理目录名中包含 - 的情况）
        let found = false;
        for (let j = i + 1; j <= parts.length; j++) {
          const combined = parts.slice(i, j).join('-');
          testPath = path.join(currentPath, combined);

          if (fs.existsSync(testPath)) {
            currentPath = testPath;
            i = j;
            found = true;
            break;
          }
        }

        if (!found) {
          // 无法找到有效路径
          return null;
        }
      }
    }

    return currentPath;
  }

  /**
   * 获取 Claude Code 最近项目
   */
  static async getClaudeProjects(limit = 10) {
    const projectsDir = path.join(HOME_DIR, '.claude', 'projects');

    if (!fs.existsSync(projectsDir)) {
      return [];
    }

    try {
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      const projects = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        // 解码目录名为路径
        const projectPath = this._decodeClaudePath(entry.name);

        // 检查路径是否有效
        if (!projectPath || !fs.existsSync(projectPath)) continue;

        // 排除非项目目录（如 Documents、Desktop 等根目录）
        const pathParts = projectPath.split(path.sep).filter(Boolean);
        if (pathParts.length <= 3) continue;  // 至少要 /Users/xxx/Documents/project

        const dirPath = path.join(projectsDir, entry.name);
        const stat = fs.statSync(dirPath);

        projects.push({
          name: path.basename(projectPath),
          path: projectPath,
          description: this._getProjectDescription(projectPath),
          lastUsed: stat.mtime.getTime(),
          aiType: 'claude',
          resumeCommand: 'claude -c'
        });
      }

      // 按最后使用时间排序
      projects.sort((a, b) => b.lastUsed - a.lastUsed);
      return projects.slice(0, limit);
    } catch (error) {
      console.error('[RecentProjects] 获取 Claude 项目失败:', error);
      return [];
    }
  }

  /**
   * 获取 Codex CLI 最近项目
   */
  static async getCodexProjects(limit = 10) {
    const sessionsDir = path.join(HOME_DIR, '.codex', 'sessions');

    if (!fs.existsSync(sessionsDir)) {
      return [];
    }

    try {
      const projectMap = new Map(); // path -> { lastUsed, ... }

      // 遍历年/月/日目录结构
      const years = fs.readdirSync(sessionsDir).filter(f => /^\d{4}$/.test(f));

      for (const year of years) {
        const yearDir = path.join(sessionsDir, year);
        const months = fs.readdirSync(yearDir).filter(f => /^\d{1,2}$/.test(f));

        for (const month of months) {
          const monthDir = path.join(yearDir, month);
          const days = fs.readdirSync(monthDir).filter(f => /^\d{1,2}$/.test(f));

          for (const day of days) {
            const dayDir = path.join(monthDir, day);
            const files = fs.readdirSync(dayDir).filter(f => f.endsWith('.jsonl'));

            for (const file of files) {
              const filePath = path.join(dayDir, file);
              const cwd = this._extractCodexCwd(filePath);

              if (cwd && fs.existsSync(cwd)) {
                const stat = fs.statSync(filePath);
                const existing = projectMap.get(cwd);

                if (!existing || stat.mtime.getTime() > existing.lastUsed) {
                  projectMap.set(cwd, {
                    name: path.basename(cwd),
                    path: cwd,
                    description: this._getProjectDescription(cwd),
                    lastUsed: stat.mtime.getTime(),
                    aiType: 'codex',
                    resumeCommand: 'codex resume --last'
                  });
                }
              }
            }
          }
        }
      }

      const projects = Array.from(projectMap.values());
      projects.sort((a, b) => b.lastUsed - a.lastUsed);
      return projects.slice(0, limit);
    } catch (error) {
      console.error('[RecentProjects] 获取 Codex 项目失败:', error);
      return [];
    }
  }

  /**
   * 从 Codex jsonl 文件提取 cwd
   * session_meta 总是在第一行
   * 优化：使用流式读取只获取第一行，避免读取整个文件
   */
  static _extractCodexCwd(filePath) {
    try {
      // 使用 Buffer 只读取文件开头部分（足够包含 session_meta）
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(4096); // 4KB 足够读取第一行
      const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
      fs.closeSync(fd);

      if (bytesRead === 0) return null;

      const content = buffer.toString('utf-8', 0, bytesRead);
      const newlineIndex = content.indexOf('\n');
      const firstLine = newlineIndex > 0 ? content.slice(0, newlineIndex) : content;

      if (!firstLine) return null;

      const data = JSON.parse(firstLine);
      if (data.type === 'session_meta' && data.payload?.cwd) {
        return data.payload.cwd;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 获取 Gemini CLI 最近项目
   * Gemini 使用路径的 SHA256 哈希作为目录名
   * 优化：按 mtime 排序哈希目录，只扫描必要的候选路径
   */
  static async getGeminiProjects(limit = 10) {
    const tmpDir = path.join(HOME_DIR, '.gemini', 'tmp');

    if (!fs.existsSync(tmpDir)) {
      return [];
    }

    try {
      // 获取所有 Gemini 哈希目录并按 mtime 排序
      const geminiDirs = fs.readdirSync(tmpDir)
        .filter(f => f !== 'bin' && f.length === 64)
        .map(name => {
          const dirPath = path.join(tmpDir, name);
          try {
            const stat = fs.statSync(dirPath);
            return { name, mtime: stat.mtime.getTime() };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit * 2); // 多取一些以防部分无法匹配

      if (geminiDirs.length === 0) {
        return [];
      }

      // 构建哈希到 mtime 的映射
      const hashToMtime = new Map(geminiDirs.map(d => [d.name, d.mtime]));
      const hashSet = new Set(geminiDirs.map(d => d.name));

      // 扫描常用项目父目录（优化：只扫描存在的目录）
      const scanParentDirs = [
        HOME_DIR,
        path.join(HOME_DIR, 'Documents'),
        path.join(HOME_DIR, 'Documents', 'ClaudeCode'),
        path.join(HOME_DIR, 'Documents', 'CodexProjects'),
        path.join(HOME_DIR, 'Documents', 'GeminiProjects'),
        path.join(HOME_DIR, 'Projects'),
        path.join(HOME_DIR, 'Code'),
        path.join(HOME_DIR, 'Developer'),
        path.join(HOME_DIR, 'Desktop')
      ].filter(dir => fs.existsSync(dir));

      const projects = [];
      const foundHashes = new Set();

      // 只在需要更多结果时继续扫描
      for (const parentDir of scanParentDirs) {
        if (projects.length >= limit) break;

        try {
          const entries = fs.readdirSync(parentDir, { withFileTypes: true });
          for (const entry of entries) {
            if (projects.length >= limit) break;
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

            const level1Path = path.join(parentDir, entry.name);
            const hash1 = crypto.createHash('sha256').update(level1Path).digest('hex');

            if (hashSet.has(hash1) && !foundHashes.has(hash1)) {
              foundHashes.add(hash1);
              projects.push({
                name: path.basename(level1Path),
                path: level1Path,
                description: this._getProjectDescription(level1Path),
                lastUsed: hashToMtime.get(hash1),
                aiType: 'gemini',
                resumeCommand: 'gemini --resume'
              });
            }

            // 扫描二级目录
            try {
              const subEntries = fs.readdirSync(level1Path, { withFileTypes: true });
              for (const subEntry of subEntries) {
                if (projects.length >= limit) break;
                if (!subEntry.isDirectory() || subEntry.name.startsWith('.')) continue;

                const level2Path = path.join(level1Path, subEntry.name);
                const hash2 = crypto.createHash('sha256').update(level2Path).digest('hex');

                if (hashSet.has(hash2) && !foundHashes.has(hash2)) {
                  foundHashes.add(hash2);
                  projects.push({
                    name: path.basename(level2Path),
                    path: level2Path,
                    description: this._getProjectDescription(level2Path),
                    lastUsed: hashToMtime.get(hash2),
                    aiType: 'gemini',
                    resumeCommand: 'gemini --resume'
                  });
                }
              }
            } catch {
              // 忽略无权限的子目录
            }
          }
        } catch {
          // 忽略无权限的目录
        }
      }

      projects.sort((a, b) => b.lastUsed - a.lastUsed);
      return projects.slice(0, limit);
    } catch (error) {
      console.error('[RecentProjects] 获取 Gemini 项目失败:', error);
      return [];
    }
  }
}

export default RecentProjectsService;
