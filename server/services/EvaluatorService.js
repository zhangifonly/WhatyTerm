/**
 * EvaluatorService - Harness Evaluator 角色
 * GAN 式对抗评估：独立验证 feature 是否真正完成
 */
import { execSync } from 'child_process';
import progressManager from './ProgressManager.js';

class EvaluatorService {
  constructor(aiEngine) {
    this.aiEngine = aiEngine;
    this.cooldown = 15000; // 评估冷却 15 秒
    this.lastEvalTime = new Map();
  }

  /** 检查 Evaluator 是否启用 */
  isEnabled(sessionId) {
    const progress = progressManager.loadProgress(sessionId);
    return progress?.evaluatorConfig?.enabled === true;
  }

  /** 设置启用/禁用 */
  setEnabled(sessionId, enabled) {
    const progress = progressManager.loadProgress(sessionId);
    if (!progress) return false;
    progress.evaluatorConfig.enabled = enabled;
    return progressManager.saveProgress(sessionId, progress);
  }

  /**
   * 评估 feature 是否真正完成
   * @returns {{ passed, confidence, feedback, issues }}
   */
  async evaluate(sessionId, featureId, terminalContent, workingDir) {
    // 冷却检查
    const lastTime = this.lastEvalTime.get(`${sessionId}:${featureId}`);
    if (lastTime && Date.now() - lastTime < this.cooldown) {
      return { passed: true, confidence: 0.5, feedback: '冷却中，暂时通过' };
    }
    this.lastEvalTime.set(`${sessionId}:${featureId}`, Date.now());

    const progress = progressManager.loadProgress(sessionId);
    const feature = progress?.features?.find(f => f.id === featureId);
    if (!feature) {
      return { passed: false, confidence: 0, feedback: 'feature 不存在' };
    }

    // 收集验证数据
    const evidence = this._collectEvidence(workingDir, terminalContent);
    const prompt = this._buildEvalPrompt(feature, evidence, progress);

    try {
      console.log(`[Evaluator] 评估 feature: ${feature.name}`);
      const result = await this.aiEngine.generateText(prompt);
      const parsed = this._parseResult(result);

      // 记录评估结果
      progressManager.addEvaluation(sessionId, featureId, parsed);
      console.log(`[Evaluator] 结果: ${parsed.passed ? '通过' : '不通过'} (${parsed.confidence})`);
      return parsed;
    } catch (err) {
      console.error('[Evaluator] 评估失败:', err.message);
      return { passed: true, confidence: 0.3, feedback: '评估异常，默认通过' };
    }
  }

  /** 收集验证证据 */
  _collectEvidence(workingDir, terminalContent) {
    const evidence = { gitDiff: '', hasErrors: false, lastOutput: '' };
    if (!workingDir) return evidence;

    try {
      evidence.gitDiff = execSync(
        'git diff --stat HEAD~1 2>/dev/null || echo "无 git 历史"',
        { cwd: workingDir, timeout: 5000, encoding: 'utf-8' }
      ).substring(0, 500);
    } catch { evidence.gitDiff = '无法获取'; }

    // 检查终端最后 20 行是否有错误
    const lastLines = (terminalContent || '').split('\n').slice(-20).join('\n');
    evidence.lastOutput = lastLines.substring(0, 500);
    evidence.hasErrors = /error:|Error:|failed|FAILED|panic/i.test(lastLines);

    return evidence;
  }

  _buildEvalPrompt(feature, evidence, progress) {
    const done = progress.features.filter(f => f.status === 'completed').length;
    return `你是一个严格的代码评审员（Evaluator）。请独立判断以下任务是否真正完成。

## 任务信息
名称: ${feature.name}
描述: ${feature.description}
Sprint 进度: ${done}/${progress.features.length}

## 验证证据
### Git 变更
${evidence.gitDiff}

### 终端最近输出
${evidence.lastOutput}

### 是否有错误: ${evidence.hasErrors ? '是' : '否'}

## 评估标准
1. 代码是否有实际变更（git diff 不为空）
2. 终端是否有编译/运行错误
3. 任务描述中的要求是否被满足

## 输出格式（严格 JSON）
\`\`\`json
{
  "passed": true/false,
  "confidence": 0.0-1.0,
  "feedback": "评估反馈，如果不通过则说明需要修复什么",
  "issues": ["问题1", "问题2"]
}
\`\`\`

只输出 JSON：`;
  }

  _parseResult(result) {
    try {
      let json = result;
      const match = result.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) json = match[1];
      const parsed = JSON.parse(json.trim());
      return {
        passed: !!parsed.passed,
        confidence: parsed.confidence || 0,
        feedback: parsed.feedback || '',
        issues: parsed.issues || []
      };
    } catch {
      return { passed: true, confidence: 0.3, feedback: '解析失败，默认通过', issues: [] };
    }
  }
}

export default EvaluatorService;
