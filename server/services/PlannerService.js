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

    // 自主模式：拆分前先把需求专业化（补全技术方案/UI美化/完整性），避免产出简陋。
    // 已有 doc/design.md 则视为已专业化或用户自备设计，跳过（幂等、尊重手改）。
    let designDoc = '';
    if (autonomous && projectContext.workingDir) {
      const hasDesign = !!this._readDoc(projectContext.workingDir, ['doc/design.md', 'doc/设计文档.md', 'design.md']);
      if (!hasDesign) {
        await this._professionalize(sessionId, goal, projectContext, projectScan);
      }
      // 读取（可能刚专业化生成的）设计与需求文档
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
          aiType: projectContext.aiType || 'claude',
          providerEnv: projectContext.providerEnv || {},
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
   * 需求专业化提示词：把用户的简短/简陋需求扩写成可直接据以开发的专业规格。
   * 自动补全用户未明说的技术方案、前端 UI/UX 美化、功能完整性、质量要求。
   */
  _buildSpecPrompt(goal, ctx, projectScan) {
    const projectInfo = ctx.projectDesc ? `\n项目背景: ${ctx.projectDesc}` : '';
    const workDir = ctx.workingDir ? `\n工作目录: ${ctx.workingDir}` : '';
    return `你是一位资深产品经理 + 软件架构师 + UI/UX 设计师。用户给出的需求往往很简短、缺少技术与设计细节。请把它扩写成一份**可直接据以开发的专业规格**，主动补全用户没有明说但专业项目必备的内容，避免最终产物简陋。
${projectInfo}${workDir}
${projectScan}

## 用户原始需求
${goal}

## 必须补全（用户没提到也要补）
1. **产品**：一句话定位、核心用户与使用场景、完整功能清单（核心功能 + 边界情况 + 错误/空/加载状态）。
2. **技术方案**：选用现代主流技术栈并给出理由（语言/框架/数据库/关键库）、架构分层、数据模型(schema/字段)、关键 API 设计、目录结构。优先成熟稳定、生态好、适合该需求规模的方案。
3. **前端 UI/UX（若该项目有前端）**：明确设计风格与视觉基调、配色方案、组件库选型、布局与响应式、关键交互与微动效、空态/错误态/加载态/骨架屏。**强调要美观、专业、有设计感，禁止使用简陋的默认样式直接堆砌**。
4. **质量**：测试策略（单测/集成/E2E）、性能要点、可访问性、安全要点。
5. **按项目类型自适应**：若是纯后端服务/CLI/库，则不要硬塞前端，转而强化 API 契约、错误处理、健壮性、可观测性、文档。

## 输出格式（严格 Markdown，只输出文档本身，不要寒暄）
# 需求规格
（产品定位、用户场景、完整功能清单——尽量具体、可落地）

# 技术设计
（技术栈选型+理由、架构、数据模型、API、目录结构；有前端则含 UI/UX 设计与美化规范；质量/测试/非功能要点）`;
  }

  /**
   * 拆分前先把需求专业化：CLI 生成专业规格并落盘 doc/requirement.md + doc/design.md。
   * 失败时返回 false（降级为直接用原始需求拆分，不阻断）。
   */
  async _professionalize(sessionId, goal, ctx, projectScan) {
    if (!ctx.workingDir) return false;
    try {
      const prompt = this._buildSpecPrompt(goal, ctx, projectScan);
      console.log('[Planner] 需求专业化中（补全技术方案/UI设计/完整性）...');
      let spec = null;
      if (typeof this.aiEngine.generateTextViaCLI === 'function') {
        spec = await this.aiEngine.generateTextViaCLI(prompt, {
          cwd: ctx.workingDir,
          aiType: ctx.aiType || 'claude',
          providerEnv: ctx.providerEnv || {},
          timeout: 240000,
        });
      }
      if (!spec) spec = await this.aiEngine.generateText(prompt);
      if (!spec || spec.trim().length < 50) {
        console.warn('[Planner] 专业化无有效结果，降级用原始需求拆分');
        return false;
      }
      // 切分 # 需求规格 / # 技术设计 两节
      const docDir = path.join(ctx.workingDir, 'doc');
      if (!fs.existsSync(docDir)) fs.mkdirSync(docDir, { recursive: true });
      const m = spec.match(/#\s*技术设计/);
      if (m && m.index > 0) {
        const reqPart = spec.slice(0, m.index).trim();
        const designPart = spec.slice(m.index).trim();
        fs.writeFileSync(path.join(docDir, 'requirement.md'), reqPart + '\n', 'utf-8');
        fs.writeFileSync(path.join(docDir, 'design.md'), designPart + '\n', 'utf-8');
      } else {
        // 切分失败：整篇作为设计文档
        fs.writeFileSync(path.join(docDir, 'design.md'), spec.trim() + '\n', 'utf-8');
      }
      console.log('[Planner] 专业化完成，已写入 doc/requirement.md + doc/design.md');
      return true;
    } catch (e) {
      console.error('[Planner] 专业化失败，降级:', e.message);
      return false;
    }
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
9. **必须覆盖完整交付链，而非只拆主功能**：除核心功能外，要包含——(a) 关键模块/核心逻辑的自动化测试任务（单测/集成测试）；(b) 错误处理、边界与加载/空/失败状态；(c) 最后一个"集成验证与收尾"任务（typecheck/lint/build/test 全通过、关键流程端到端可用、必要的 README/启动说明）。不要拆完主功能链路就结束。
10. **按需求真实复杂度拆，不要刻意压缩任务数**：需求越完整/模块越多，就拆越多任务；宁可多个小而可验证的任务，也不要把不相邻模块塞进一个大任务。每个仍须满足铁律 1 的"足够小、单次迭代可完成"。

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
