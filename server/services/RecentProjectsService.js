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

        // 解码目录名为路径: -Users-xxx -> /Users/xxx
        const projectPath = entry.name.replace(/^-/, '/').replace(/-/g, '/');

        // 检查路径是否存在
        if (!fs.existsSync(projectPath)) continue;

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
              const cwd = await this._extractCodexCwd(filePath);

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
   */
  static async _extractCodexCwd(filePath) {
    try {
      // 只读取第一行（session_meta 总是第一行）
      const content = fs.readFileSync(filePath, 'utf-8');
      const firstLine = content.split('\n')[0];
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
   */
  static async getGeminiProjects(limit = 10) {
    const tmpDir = path.join(HOME_DIR, '.gemini', 'tmp');

    if (!fs.existsSync(tmpDir)) {
      return [];
    }

    try {
      const projects = [];
      const geminiDirs = fs.readdirSync(tmpDir)
        .filter(f => f !== 'bin' && f.length === 64); // SHA256 哈希长度

      if (geminiDirs.length === 0) {
        return [];
      }

      // 扫描常用项目父目录
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
      ];

      // 收集所有可能的项目目录（包括二级目录）
      const candidatePaths = new Set();

      for (const parentDir of scanParentDirs) {
        if (!fs.existsSync(parentDir)) continue;

        try {
          const entries = fs.readdirSync(parentDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
              const level1Path = path.join(parentDir, entry.name);
              candidatePaths.add(level1Path);

              // 也扫描二级目录
              try {
                const subEntries = fs.readdirSync(level1Path, { withFileTypes: true });
                for (const subEntry of subEntries) {
                  if (subEntry.isDirectory() && !subEntry.name.startsWith('.')) {
                    candidatePaths.add(path.join(level1Path, subEntry.name));
                  }
                }
              } catch {
                // 忽略无权限的子目录
              }
            }
          }
        } catch {
          // 忽略无权限的目录
        }
      }

      // 为每个候选路径计算哈希并匹配
      for (const projectPath of candidatePaths) {
        const hash = crypto.createHash('sha256')
          .update(projectPath)
          .digest('hex');

        if (geminiDirs.includes(hash)) {
          const geminiDir = path.join(tmpDir, hash);
          const stat = fs.statSync(geminiDir);

          projects.push({
            name: path.basename(projectPath),
            path: projectPath,
            description: this._getProjectDescription(projectPath),
            lastUsed: stat.mtime.getTime(),
            aiType: 'gemini',
            resumeCommand: 'gemini --resume'
          });
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
