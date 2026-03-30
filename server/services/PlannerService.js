/**
 * PlannerService - Harness Planner 角色
 * 将用户 goal 扩展为结构化的 feature list 和 Sprint Contract
 */
import progressManager from './ProgressManager.js';

class PlannerService {
  constructor(aiEngine) {
    this.aiEngine = aiEngine;
  }

  /**
   * 将 goal 展开为 feature list
   * @param {string} sessionId
   * @param {string} goal - 用户 1-4 句需求描述
   * @param {object} projectContext - { projectPath, projectDesc, workingDir }
   * @returns {object|null} progress 对象
   */
  async expandGoal(sessionId, goal, projectContext = {}) {
    if (!goal || goal.trim().length < 2) return null;

    // 创建初始 progress
    progressManager.createProgress(sessionId, goal);

    const prompt = this._buildPlannerPrompt(goal, projectContext);

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

  _buildPlannerPrompt(goal, ctx) {
    const projectInfo = ctx.projectDesc
      ? `\n项目背景: ${ctx.projectDesc}`
      : '';
    const workDir = ctx.workingDir
      ? `\n工作目录: ${ctx.workingDir}`
      : '';

    return `你是一个软件项目规划专家。请将以下需求拆解为可执行的 feature 列表。
${projectInfo}${workDir}

## 用户需求
${goal}

## 要求
1. 将需求拆解为 3-8 个独立的 feature
2. 每个 feature 应该是可独立完成和验证的
3. 按优先级和依赖关系排序（先做基础，再做上层）
4. 每个 feature 包含清晰的完成标准
5. 生成一个总体的 Sprint 完成标准

## 输出格式（严格 JSON）
\`\`\`json
{
  "features": [
    {
      "id": "feat-001",
      "name": "feature 简短名称",
      "description": "详细描述，包含完成标准"
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
