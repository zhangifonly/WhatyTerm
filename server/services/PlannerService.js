/**
 * PlannerService - Harness Planner 角色
 * 将用户 goal 扩展为结构化的 feature list 和 Sprint Contract
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import progressManager from './ProgressManager.js';

class PlannerService {
  constructor(aiEngine) {
    this.aiEngine = aiEngine;
  }

  /** 扫描项目现状 */
  _scanProject(workingDir, terminalOutput) {
    const parts = [];

    if (workingDir && fs.existsSync(workingDir)) {
      // 文件结构（排除 node_modules 等）
      // Windows 用 dir，Unix 用 find
      try {
        const isWin = process.platform === 'win32';
        const cmd = isWin
          ? 'dir /s /b /a:-d 2>nul | findstr /v "node_modules .git dist __pycache__"'
          : 'find . -maxdepth 3 -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/__pycache__/*" | head -60';
        const tree = execSync(cmd, { cwd: workingDir, timeout: 5000, encoding: 'utf-8' }).trim();
        if (tree) parts.push(`### 文件结构\n${tree.substring(0, 2000)}`);
      } catch {}

      // 最近 git 提交
      try {
        const gitLog = execSync(
          'git log --oneline -10 2>/dev/null',
          { cwd: workingDir, timeout: 3000, encoding: 'utf-8' }
        ).trim();
        if (gitLog) parts.push(`### 最近提交\n${gitLog}`);
      } catch {}

      // package.json 或 pyproject.toml 摘要
      for (const f of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']) {
        const fp = path.join(workingDir, f);
        if (fs.existsSync(fp)) {
          try {
            const content = fs.readFileSync(fp, 'utf-8').substring(0, 500);
            parts.push(`### ${f}\n${content}`);
          } catch {}
          break;
        }
      }
    }

    // 终端最近输出（反映 AI 当前工作进度）
    if (terminalOutput) {
      parts.push(`### 终端最近输出（反映当前进度）\n${terminalOutput.substring(0, 3000)}`);
    }

    return parts.length ? '\n## 项目现状\n' + parts.join('\n\n') : '';
  }

  /**
   * 将 goal 展开为 feature list
   * @param {string} sessionId
   * @param {string} goal - 用户 1-4 句需求描述
   * @param {object} projectContext - { projectPath, projectDesc, workingDir, terminalOutput }
   * @returns {object|null} progress 对象
   */
  async expandGoal(sessionId, goal, projectContext = {}) {
    if (!goal || goal.trim().length < 2) return null;

    // 创建初始 progress
    progressManager.createProgress(sessionId, goal);

    const projectScan = this._scanProject(projectContext.workingDir, projectContext.terminalOutput);
    const prompt = this._buildPlannerPrompt(goal, projectContext, projectScan);

    try {
      console.log(`[Planner] 开始规划: ${goal.substring(0, 50)}...`);
      const result = await this.aiEngine.generateText(prompt);
      if (!result) {
        console.error('[Planner] AI 返回空结果');
        return null;
      }

      const parsed = this._parseResult(result);
      if (!parsed) return null;

      progressManager.setFeatures(
        sessionId,
        parsed.features,
        parsed.sprintContract
      );

      const progress = progressManager.loadProgress(sessionId);
      console.log(`[Planner] 规划完成: ${parsed.features.length} 个 feature`);
      return progress;
    } catch (err) {
      console.error('[Planner] 规划失败:', err.message);
      return null;
    }
  }

  _buildPlannerPrompt(goal, ctx, projectScan) {
    const projectInfo = ctx.projectDesc
      ? `\n项目背景: ${ctx.projectDesc}`
      : '';
    const workDir = ctx.workingDir
      ? `\n工作目录: ${ctx.workingDir}`
      : '';

    return `你是一个软件项目规划专家。请根据用户需求和项目现状，拆解出剩余待完成的 feature 列表。
${projectInfo}${workDir}
${projectScan}

## 用户需求
${goal}

## 要求
1. 仔细分析项目现状（文件结构、git 提交、依赖配置）
2. 根据现有代码判断哪些功能已经实现，哪些还未完成
3. 只列出**尚未完成或需要改进**的 feature（3-8 个）
4. 如果项目已有大量代码，聚焦于目标中**尚未实现的部分**
5. 每个 feature 包含清晰的完成标准
6. 如果有已完成的 feature，也列出并标记 status 为 "completed"

## 输出格式（严格 JSON）
\`\`\`json
{
  "features": [
    {
      "id": "feat-001",
      "name": "feature 简短名称",
      "description": "详细描述，包含完成标准",
      "status": "completed 或 pending"
    }
  ],
  "sprintContract": "整体完成标准描述"
}
\`\`\`

只输出 JSON，不要其他内容。`;
  }

  _parseResult(result) {
    try {
      // 提取 JSON（可能包裹在 ```json 中）
      let json = result;
      const match = result.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) json = match[1];

      // 尝试直接解析
      const parsed = JSON.parse(json.trim());
      if (!parsed.features || !Array.isArray(parsed.features)) {
        console.error('[Planner] 缺少 features 数组');
        return null;
      }
      if (parsed.features.length === 0) {
        console.error('[Planner] features 为空');
        return null;
      }
      return parsed;
    } catch (err) {
      console.error('[Planner] JSON 解析失败:', err.message);
      return null;
    }
  }
}

export default PlannerService;
