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

    const autonomous = projectContext.autonomous === true;

    // 创建初始 progress
    progressManager.createProgress(sessionId, goal);
    if (autonomous) progressManager.setMode(sessionId, 'autonomous');

    const projectScan = this._scanProject(projectContext.workingDir, projectContext.terminalOutput);

    // 自主模式：尝试读取设计文档（doc/design.md），需求可来自 doc/requirement.md
    let designDoc = '';
    if (autonomous && projectContext.workingDir) {
      designDoc = this._readDoc(projectContext.workingDir, ['doc/design.md', 'doc/设计文档.md', 'design.md']);
      const reqDoc = this._readDoc(projectContext.workingDir, ['doc/requirement.md', 'doc/需求文档.md', 'requirement.md']);
      if (reqDoc) goal = `${goal}\n\n${reqDoc}`;
    }

    const prompt = autonomous
      ? this._buildAutonomousPrompt(goal, projectContext, projectScan, designDoc)
      : this._buildPlannerPrompt(goal, projectContext, projectScan);

    try {
      console.log(`[Planner] 开始规划${autonomous ? '(自主模式)' : ''}: ${goal.substring(0, 50)}...`);
      // 优先用 claude CLI 子进程（照搬 WhatRalph：复用 Claude Code 当前供应商/登录态，
      // 官方登录或中转均可，不受单个中转 504 影响）；CLI 不可用时回退 HTTP。
      let result = null;
      if (typeof this.aiEngine.generateTextViaCLI === 'function') {
        result = await this.aiEngine.generateTextViaCLI(prompt, {
          cwd: projectContext.workingDir,
          timeout: 180000,
        });
        if (!result) console.warn('[Planner] CLI 拆分无结果，回退 HTTP API');
      }
      if (!result) {
        result = await this.aiEngine.generateText(prompt);
      }
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
      if (autonomous) progressManager.setMode(sessionId, 'autonomous');

      const progress = progressManager.loadProgress(sessionId);
      console.log(`[Planner] 规划完成: ${parsed.features.length} 个 feature`);
      return progress;
    } catch (err) {
      console.error('[Planner] 规划失败:', err.message);
      return null;
    }
  }

  /** 读取项目内的文档文件（按候选路径列表，返回第一个存在的内容） */
  _readDoc(workingDir, candidates) {
    for (const rel of candidates) {
      try {
        const p = path.join(workingDir, rel);
        if (fs.existsSync(p)) {
          return fs.readFileSync(p, 'utf-8').substring(0, 4000);
        }
      } catch {}
    }
    return '';
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

  /**
   * Ralph 自主模式专用：将需求/设计文档拆分为可被自主引擎执行的小颗粒任务。
   * 每个任务带可验证的验收标准、依赖关系、统一 branch。
   */
  _buildAutonomousPrompt(goal, ctx, projectScan, designDoc = '') {
    const projectInfo = ctx.projectDesc ? `\n项目背景: ${ctx.projectDesc}` : '';
    const workDir = ctx.workingDir ? `\n工作目录: ${ctx.workingDir}` : '';
    const designSection = designDoc
      ? `\n## 设计文档\n${designDoc.substring(0, 3000)}\n`
      : '';

    return `你是一个资深软件任务拆分专家。请把需求拆分成一组可被自主 AI Agent 一次一个、顺序执行的开发任务。
${projectInfo}${workDir}
${projectScan}

## 需求文档
${goal}
${designSection}
## 拆分铁律（必须遵守）
1. **每个任务必须足够小**：能在一次 AI 迭代（单个 Claude/CLI 实例）中稳定完成。单实体的 schema→service→API→UI 全链路算正常；跨多个独立实体/不相邻模块则必须拆开。
2. **按真实开发顺序拆**：基础准备→数据层→接口服务层→页面组件层→集成层→验证收尾。不要按"前端部分/后端部分/优化代码/联调"这种模糊方式拆。
3. **每个任务必须有可验证的验收标准**（acceptanceCriteria）：写成 Agent 能实际检查的事实/命令，例如 "users 表新增 last_login_at 列"、"npm run typecheck 通过"、"/api/x 支持 status 参数并返回过滤结果"。禁止 "功能正常""代码整洁" 这种无法验证的标准。
4. **编号即执行顺序**，三位数：001、002...；较早任务不能依赖较晚任务。
5. **dependsOn 只写直接前置任务**的 id。
6. **所有任务共用同一个 branch**：从功能名派生，kebab-case，前缀 ralph/。禁止按阶段拆多个分支。
7. 只生成开发任务，不要"继续思考""阅读代码""人工确认"这类空任务。
8. 分析项目现状，已完成的部分标记 status 为 "completed"，只对未完成部分产出 pending 任务。

## 输出格式（严格 JSON）
\`\`\`json
{
  "features": [
    {
      "id": "feat-001",
      "name": "任务标题",
      "description": "背景+需求+技术设计：要改哪些文件、新增什么类型/接口/组件、数据如何流转、与现有模块如何集成",
      "priority": 1,
      "status": "pending",
      "dependsOn": [],
      "branch": "ralph/feature-name",
      "acceptanceCriteria": ["可验证标准1", "可验证标准2", "typecheck/test 通过"]
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
