/**
 * ProgressManager - Harness 结构化进度追踪
 * 管理 ~/.webtmux/sessions/{sessionId}/progress.json
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const WEBTMUX_DIR = path.join(os.homedir(), '.webtmux', 'sessions');

class ProgressManager {

  /** 获取 progress.json 路径 */
  getProgressPath(sessionId) {
    return path.join(WEBTMUX_DIR, sessionId, 'progress.json');
  }

  /** 确保目录存在 */
  _ensureDir(sessionId) {
    const dir = path.join(WEBTMUX_DIR, sessionId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** 读取 progress.json，不存在返回 null */
  loadProgress(sessionId) {
    try {
      const filePath = this.getProgressPath(sessionId);
      if (!fs.existsSync(filePath)) return null;
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      console.error(`[ProgressManager] 读取失败:`, err.message);
      return null;
    }
  }

  /** 原子写入 progress.json */
  saveProgress(sessionId, data) {
    try {
      this._ensureDir(sessionId);
      data.updatedAt = new Date().toISOString();
      const filePath = this.getProgressPath(sessionId);
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);
      return true;
    } catch (err) {
      console.error(`[ProgressManager] 写入失败:`, err.message);
      return false;
    }
  }

  /** 创建初始 progress（status: planning） */
  createProgress(sessionId, goal) {
    const data = {
      version: '1.0',
      sessionId,
      goal,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'planning',
      currentFeatureIndex: 0,
      sprint: null,
      features: [],
      evaluatorConfig: { enabled: false, strictMode: false }
    };
    this.saveProgress(sessionId, data);
    return data;
  }

  /** 设置 features（Planner 生成后调用） */
  setFeatures(sessionId, features, sprintContract) {
    const progress = this.loadProgress(sessionId);
    if (!progress) return false;
    progress.features = features.map((f, i) => ({
      id: f.id || `feat-${String(i + 1).padStart(3, '0')}`,
      name: f.name,
      description: f.description || '',
      priority: f.priority || i + 1,
      status: 'pending',
      passes: { implemented: false, compiles: false, tested: false },
      startedAt: null,
      completedAt: null,
      evaluations: []
    }));
    progress.sprint = {
      name: 'Sprint 1',
      startedAt: new Date().toISOString(),
      completionCriteria: sprintContract || '所有 feature 完成'
    };
    progress.status = 'in_progress';
    progress.currentFeatureIndex = 0;
    return this.saveProgress(sessionId, progress);
  }

  /** 更新单个 feature 状态 */
  updateFeatureStatus(sessionId, featureId, updates) {
    const progress = this.loadProgress(sessionId);
    if (!progress) return false;
    const feature = progress.features.find(f => f.id === featureId);
    if (!feature) return false;
    Object.assign(feature, updates);
    if (updates.status === 'in_progress' && !feature.startedAt) {
      feature.startedAt = new Date().toISOString();
    }
    if (updates.status === 'completed') {
      feature.completedAt = new Date().toISOString();
    }
    return this.saveProgress(sessionId, progress);
  }

  /** 获取当前正在进行的 feature */
  getCurrentFeature(sessionId) {
    const progress = this.loadProgress(sessionId);
    if (!progress?.features?.length) return null;
    // 优先返回 in_progress 的
    const active = progress.features.find(f => f.status === 'in_progress');
    if (active) return active;
    // 否则返回第一个 pending 的
    return progress.features.find(f => f.status === 'pending') || null;
  }

  /** 推进到下一个 feature，返回下一个 feature 或 null */
  advanceToNext(sessionId) {
    const progress = this.loadProgress(sessionId);
    if (!progress) return null;
    const nextFeature = progress.features.find(f => f.status === 'pending');
    if (!nextFeature) {
      progress.status = 'completed';
      this.saveProgress(sessionId, progress);
      return null;
    }
    nextFeature.status = 'in_progress';
    nextFeature.startedAt = new Date().toISOString();
    progress.currentFeatureIndex = progress.features.indexOf(nextFeature);
    this.saveProgress(sessionId, progress);
    return nextFeature;
  }

  /** 添加评估记录 */
  addEvaluation(sessionId, featureId, evalResult) {
    const progress = this.loadProgress(sessionId);
    if (!progress) return false;
    const feature = progress.features.find(f => f.id === featureId);
    if (!feature) return false;
    feature.evaluations.push({
      timestamp: new Date().toISOString(),
      passed: evalResult.passed,
      confidence: evalResult.confidence || 0,
      summary: evalResult.feedback || ''
    });
    return this.saveProgress(sessionId, progress);
  }

  /** 检查是否所有 feature 都已完成 */
  isAllCompleted(sessionId) {
    const progress = this.loadProgress(sessionId);
    if (!progress?.features?.length) return false;
    return progress.features.every(f => f.status === 'completed');
  }

  /** 获取进度摘要 */
  getSummary(sessionId) {
    const progress = this.loadProgress(sessionId);
    if (!progress) return null;
    const total = progress.features.length;
    const completed = progress.features.filter(f => f.status === 'completed').length;
    const current = this.getCurrentFeature(sessionId);
    return {
      total, completed,
      percent: total > 0 ? Math.round(completed / total * 100) : 0,
      status: progress.status,
      currentFeature: current?.name || null
    };
  }

  /** 清理会话进度文件 */
  deleteProgress(sessionId) {
    try {
      const dir = path.join(WEBTMUX_DIR, sessionId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true });
      }
    } catch (err) {
      console.error(`[ProgressManager] 删除失败:`, err.message);
    }
  }
}

const progressManager = new ProgressManager();
export default progressManager;
