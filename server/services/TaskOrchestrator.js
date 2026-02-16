/**
 * TaskOrchestrator - Agent Team 智能任务编排器
 *
 * 接管 Team Member 会话的自动操作，替代盲目"继续"逻辑。
 * 核心状态机：IDLE → ASSIGNED → WORKING → POSSIBLY_DONE → (完成/继续)
 *
 * 功能：
 * 1. 两级完成检测（正则 + AI 确认）
 * 2. 文件级冲突防护
 * 3. 评分式任务分配
 * 4. Lead 协调与整合
 * 5. 错误恢复
 */

class TaskOrchestrator {
  constructor(teamManager, sessionManager, aiEngine) {
    this.teamManager = teamManager;
    this.sessionManager = sessionManager;
    this.aiEngine = aiEngine;

    // 每个 Agent 的任务执行状态
    this.agentStates = new Map(); // sessionId -> AgentTaskState

    // 文件锁注册表（冲突防护）
    this.fileLocks = new Map(); // filePath -> { sessionId, taskId, lockedAt }

    // 上次输出长度快照（用于检测输出变化）
    this.outputLengths = new Map(); // sessionId -> number

    // AI 确认节流：避免对同一会话频繁调用 AI
    this.lastAiCheck = new Map(); // sessionId -> timestamp
    this.AI_CHECK_COOLDOWN = 15000; // 15 秒内不重复 AI 确认

    // 卡住检测阈值
    this.STUCK_TIMEOUT = 10 * 60 * 1000; // 10 分钟
    this.MAX_RECOVERY_ATTEMPTS = 2;

    // 分配后等待 Claude 开始工作的超时
    this.ASSIGN_TIMEOUT = 30000; // 30 秒
    this.AI_CONFIRM_TIMEOUT = 30000; // AI 确认超时 30 秒

    // 防止 _handleAllTasksCompleted 重复触发
    this.completedTeams = new Set();
  }

  // ==================== 核心入口 ====================

  /**
   * 每秒被 runBackgroundAutoAction 调用，处理一个 team member 会话
   */
  async handleMemberTick(session, terminalContent) {
    if (!session || !session.teamId) return;

    // 团队非 active 状态时不处理（暂停/已完成）
    const team = this.teamManager.getTeam(session.teamId);
    if (!team || team.status !== 'active') return;

    const state = this._getOrCreateState(session);

    // 检测输出是否有变化
    const currentLen = (session.outputBuffer || '').length;
    const prevLen = this.outputLengths.get(session.id) || 0;
    if (currentLen !== prevLen) {
      state.lastActivityAt = Date.now();
      this.outputLengths.set(session.id, currentLen);
    }

    try {
      switch (state.phase) {
        case 'idle':
          await this._handleIdle(session, state, terminalContent);
          break;
        case 'assigned':
          await this._handleAssigned(session, state, terminalContent);
          break;
        case 'working':
          await this._handleWorking(session, state, terminalContent);
          break;
        case 'possibly_done':
          await this._handlePossiblyDone(session, state, terminalContent);
          break;
      }
    } catch (err) {
      console.error(`[TaskOrchestrator] 会话 ${session.name} 处理异常:`, err.message);
    }
  }

  // ==================== 状态机各阶段 ====================

  /**
   * IDLE：查找并分配待处理任务
   */
  async _handleIdle(session, state, terminalContent) {
    const team = this.teamManager.getTeam(session.teamId);
    if (!team || team.status !== 'active') return;

    // 只在 Claude 空闲时才分配任务（避免向正在工作的终端发送指令）
    if (terminalContent) {
      const cleanContent = this._cleanAnsi(terminalContent);
      if (!this._isClaudeIdle(cleanContent)) return;
    }

    const tasks = this.teamManager.getTasksByTeam(team.id);

    // 找到可分配的任务（pending + 无阻塞 + 无文件冲突）
    const pendingTasks = tasks.filter(t =>
      t.status === 'pending' &&
      (!t.blockedBy || t.blockedBy.length === 0 ||
        t.blockedBy.every(bid => {
          const bt = this.teamManager.getTask(bid);
          return bt && bt.status === 'completed';
        }))
    );

    if (pendingTasks.length === 0) {
      // 检查是否所有任务都完成
      const allCompleted = tasks.length > 0 && tasks.every(t => t.status === 'completed');
      if (allCompleted) {
        await this._handleAllTasksCompleted(team);
      }
      return;
    }

    // 评分选最优任务
    let bestTask = null;
    let bestScore = -1;

    for (const task of pendingTasks) {
      const canAssign = this._canAssignTask(task, session.id);
      if (!canAssign.ok) continue;

      const score = this._scoreAssignment(task, session, state);
      if (score > bestScore) {
        bestScore = score;
        bestTask = task;
      }
    }

    if (!bestTask) return;

    // 分配任务
    await this._assignTaskToAgent(bestTask, session, state);
  }

  /**
   * ASSIGNED：等待 Claude 开始工作
   */
  async _handleAssigned(session, state, terminalContent) {
    const cleanContent = this._cleanAnsi(terminalContent);
    const isWorking = this._isClaudeWorking(cleanContent);

    if (isWorking) {
      state.phase = 'working';
      state.lastActivityAt = Date.now();
      console.log(`[TaskOrchestrator] ${session.name}: Claude 开始工作`);
      return;
    }

    // 超时：重新发送任务
    if (Date.now() - state.assignedAt > this.ASSIGN_TIMEOUT) {
      console.log(`[TaskOrchestrator] ${session.name}: 任务分配超时，重新发送`);
      const task = this.teamManager.getTask(state.taskId);
      if (task) {
        this._sendTaskToTerminal(session, task);
        state.assignedAt = Date.now();
      }
    }
  }

  /**
   * WORKING：监控工作进度，检测空闲转 possibly_done
   */
  async _handleWorking(session, state, terminalContent) {
    const cleanContent = this._cleanAnsi(terminalContent);

    // 检测确认界面 — 自动确认（复用现有逻辑）
    if (this._isConfirmationDialog(cleanContent)) {
      this._autoConfirm(session, cleanContent);
      return;
    }

    // 检测 accept edits 等待 — 自动 Tab
    if (this._isWaitingForAccept(cleanContent)) {
      console.log(`[TaskOrchestrator] ${session.name}: 检测到等待接受编辑，发送 Tab`);
      session.write('\t');
      return;
    }

    // 检测 Claude 是否空闲（可能完成了任务）
    if (this._isClaudeIdle(cleanContent)) {
      state.idleCount++;
      // 连续 3 次检测到空闲（约 3 秒），转入完成检测
      if (state.idleCount >= 3) {
        state.phase = 'possibly_done';
        state.completionCheckCount = 0;
        console.log(`[TaskOrchestrator] ${session.name}: Claude 空闲，进入完成检测`);
      }
      return;
    }

    // Claude 还在工作，重置空闲计数
    state.idleCount = 0;

    // 卡住检测
    if (this._isStuck(state)) {
      await this._handleStuck(session, state);
    }
  }

  /**
   * POSSIBLY_DONE：两级完成检测
   */
  async _handlePossiblyDone(session, state, terminalContent) {
    const task = this.teamManager.getTask(state.taskId);
    if (!task) {
      this._resetState(state);
      return;
    }

    // 如果 Claude 又开始工作了，回到 working
    const cleanContent = this._cleanAnsi(terminalContent);
    if (this._isClaudeWorking(cleanContent)) {
      state.phase = 'working';
      state.idleCount = 0;
      console.log(`[TaskOrchestrator] ${session.name}: Claude 重新开始工作`);
      return;
    }

    // Tier 1: 正则模式匹配（零成本）
    const outputDiff = this._getOutputDiff(session, state);
    const tier1Result = this._checkCompletionPatterns(outputDiff);

    if (!tier1Result.likelyDone) {
      // 不像完成，发送"继续"让 Claude 继续工作
      state.completionCheckCount++;
      if (state.completionCheckCount >= 2) {
        console.log(`[TaskOrchestrator] ${session.name}: Tier 1 判断未完成，发送"继续"`);
        session.write('继续');
        setTimeout(() => session.write('\r'), 50);
        state.phase = 'working';
        state.idleCount = 0;
        state.completionCheckCount = 0;
      }
      return;
    }

    // Tier 2: AI 确认（有成本，需节流）
    const now = Date.now();
    const lastCheck = this.lastAiCheck.get(session.id) || 0;
    if (now - lastCheck < this.AI_CHECK_COOLDOWN) {
      return; // 等待冷却
    }
    this.lastAiCheck.set(session.id, now);

    console.log(`[TaskOrchestrator] ${session.name}: Tier 1 匹配成功，调用 AI 确认`);
    const aiResult = await this._aiConfirmCompletion(task, outputDiff);

    if (aiResult && aiResult.completed && aiResult.confidence > 0.7) {
      // 任务完成
      console.log(`[TaskOrchestrator] ${session.name}: 任务完成 - ${task.subject}`);
      await this._completeAgentTask(session, state, task, aiResult);
    } else {
      // AI 判断未完成
      console.log(`[TaskOrchestrator] ${session.name}: AI 判断未完成 (confidence=${aiResult?.confidence})`);
      state.completionCheckCount++;

      if (state.completionCheckCount >= 3) {
        // 多次检查仍不确定，主动询问 Claude
        console.log(`[TaskOrchestrator] ${session.name}: 多次检查不确定，主动询问`);
        session.write('请确认当前任务是否已完成。如果已完成，请总结你做了什么修改。');
        setTimeout(() => session.write('\r'), 50);
        state.phase = 'working';
        state.idleCount = 0;
        state.completionCheckCount = 0;
      } else {
        session.write('继续');
        setTimeout(() => session.write('\r'), 50);
        state.phase = 'working';
        state.idleCount = 0;
      }
    }
  }

  // ==================== 任务分配 ====================

  async _assignTaskToAgent(task, session, state) {
    // 二次检查：防止多个 agent 同时抢同一个任务
    const currentTask = this.teamManager.getTask(task.id);
    if (!currentTask || currentTask.status !== 'pending') {
      console.log(`[TaskOrchestrator] ${session.name}: 任务 "${task.subject}" 已被其他 Agent 领取，跳过`);
      return;
    }

    // 锁定文件
    this._lockFiles(task, session.id);

    // 更新 TeamManager 中的任务状态
    this.teamManager.updateTask(task.id, {
      status: 'in_progress',
      assigneeSessionId: session.id,
      assignedAt: new Date().toISOString()
    });

    // 更新 session goal
    session.goal = `[任务] ${task.subject}`;
    this.sessionManager.updateSession(session);

    // 快照当前输出（用于后续 diff）
    state.taskId = task.id;
    state.phase = 'assigned';
    state.assignedAt = Date.now();
    state.lastActivityAt = Date.now();
    state.outputAtAssignment = (session.outputBuffer || '').length;
    state.idleCount = 0;
    state.completionCheckCount = 0;

    // 发送任务到终端
    this._sendTaskToTerminal(session, task);

    console.log(`[TaskOrchestrator] ${session.name}: 分配任务 "${task.subject}"`);

    // 通知团队
    this.teamManager.sendMessage(task.teamId, null, session.id,
      `任务 "${task.subject}" 已分配给 ${session.name}`, 'task_update');
  }

  _sendTaskToTerminal(session, task) {
    const prompt = `请完成以下任务:\n\n## ${task.subject}\n\n${task.description}\n\n注意：完成后请明确说明"任务已完成"并总结修改内容。`;
    session.write(prompt);
    setTimeout(() => session.write('\r'), 50);
  }

  // ==================== 完成检测 ====================

  /**
   * Tier 1: 正则模式匹配（零成本）
   */
  _checkCompletionPatterns(outputDiff) {
    if (!outputDiff || outputDiff.length < 100) {
      return { likelyDone: false, reason: '输出太短' };
    }

    const clean = this._cleanAnsi(outputDiff);
    const last2000 = clean.slice(-2000);

    // 完成关键词
    const completionPatterns = [
      /任务已完成/,
      /已完成.*修改/,
      /所有.*修改.*完成/,
      /I've completed/i,
      /I've finished/i,
      /All changes have been made/i,
      /task is (done|complete)/i,
      /changes are ready/i,
      /implementation is complete/i,
      /Brewed for \d+m\s*\d+s/i,  // Claude Code 任务完成标志
    ];

    for (const pattern of completionPatterns) {
      if (pattern.test(last2000)) {
        return { likelyDone: true, reason: `匹配模式: ${pattern}` };
      }
    }

    // 大量输出（>2000字符）后进入空闲，也可能是完成
    if (outputDiff.length > 2000) {
      return { likelyDone: true, reason: '大量输出后空闲' };
    }

    return { likelyDone: false, reason: '无匹配模式' };
  }

  /**
   * Tier 2: AI 确认完成
   */
  async _aiConfirmCompletion(task, outputDiff) {
    if (!this.aiEngine) return null;

    const recentOutput = (outputDiff || '').slice(-3000);
    const prompt = `你是一个任务完成检测器。分析以下终端输出，判断指定任务是否已完成。

任务标题: ${task.subject}
任务描述: ${task.description}

终端最近输出（最后 3000 字符）:
---
${recentOutput}
---

判断标准:
1. Claude 是否明确表示任务完成
2. 是否有实际的代码修改或文件操作
3. 是否回到了空闲等待状态

请严格返回 JSON（不要包含其他文字）:
{"completed":true/false,"confidence":0.0到1.0,"summary":"完成摘要或当前进度","filesModified":["file1.js"]}`;

    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AI 确认超时')), this.AI_CONFIRM_TIMEOUT)
      );
      const result = await Promise.race([
        this.aiEngine.generateText(prompt),
        timeoutPromise
      ]);
      if (!result) return null;

      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      return JSON.parse(jsonMatch[0]);
    } catch (err) {
      console.error(`[TaskOrchestrator] AI 确认失败:`, err.message);
      return null;
    }
  }

  // ==================== 任务完成处理 ====================

  async _completeAgentTask(session, state, task, aiResult) {
    // 标记任务完成
    this.teamManager.completeTask(task.id, aiResult.summary || '');

    // 更新任务的实际修改文件
    if (aiResult.filesModified && aiResult.filesModified.length > 0) {
      this.teamManager.updateTask(task.id, {
        result: JSON.stringify({
          summary: aiResult.summary,
          filesModified: aiResult.filesModified
        })
      });
    }

    // 释放文件锁
    this._unlockFiles(task.id);

    // 记录历史文件（用于亲和度评分）
    if (aiResult.filesModified) {
      state.previousFiles = [
        ...(state.previousFiles || []),
        ...aiResult.filesModified
      ].slice(-20); // 保留最近 20 个文件
    }

    // 重置状态为 idle，等待下一个任务
    state.taskId = null;
    state.phase = 'idle';
    state.idleCount = 0;
    state.completionCheckCount = 0;

    // 更新 session goal
    session.goal = '[Teammate] 等待任务分配...';
    this.sessionManager.updateSession(session);

    console.log(`[TaskOrchestrator] ${session.name}: 任务 "${task.subject}" 完成，结果: ${aiResult.summary}`);

    // 检查是否所有任务都完成了
    const team = this.teamManager.getTeam(task.teamId);
    if (team) {
      const allTasks = this.teamManager.getTasksByTeam(team.id);
      const allCompleted = allTasks.length > 0 && allTasks.every(t => t.status === 'completed');
      if (allCompleted) {
        await this._handleAllTasksCompleted(team);
      }
    }
  }

  // ==================== 冲突防护 ====================

  _canAssignTask(task, sessionId) {
    const expectedFiles = this._parseExpectedFiles(task);

    for (const file of expectedFiles) {
      const lock = this.fileLocks.get(file);
      if (lock && lock.sessionId !== sessionId) {
        return { ok: false, conflictWith: lock.taskId, file };
      }
    }
    return { ok: true };
  }

  _lockFiles(task, sessionId) {
    const expectedFiles = this._parseExpectedFiles(task);

    const now = Date.now();
    for (const file of expectedFiles) {
      this.fileLocks.set(file, { sessionId, taskId: task.id, lockedAt: now });
    }
  }

  _unlockFiles(taskId) {
    for (const [file, lock] of this.fileLocks.entries()) {
      if (lock.taskId === taskId) {
        this.fileLocks.delete(file);
      }
    }
  }

  // ==================== 评分分配 ====================

  _scoreAssignment(task, session, state) {
    let score = 0;

    // 优先级加分
    score += (task.priority || 0) * 10;

    // 空闲时间加分（优先分配给空闲更久的 Agent）
    const idleTime = Date.now() - (state.lastActivityAt || 0);
    score += Math.min(idleTime / 1000, 30);

    // 文件亲和度（Agent 之前处理过相关文件）
    const previousFiles = state.previousFiles || [];
    const expectedFiles = this._parseExpectedFiles(task);

    const overlap = expectedFiles.filter(f => previousFiles.includes(f)).length;
    score += overlap * 5;

    return score;
  }

  // ==================== Lead 协调 ====================

  async _notifyLead(team, message) {
    const leadSession = this.sessionManager.getSession(team.leadSessionId);
    if (!leadSession) return;

    // 只在 Lead 空闲时发送
    const content = leadSession.getScreenContent();
    if (!content) return;

    const cleanContent = this._cleanAnsi(content);
    const isIdle = this._isClaudeIdle(cleanContent);

    if (isIdle) {
      leadSession.write(message);
      setTimeout(() => leadSession.write('\r'), 50);
    }
  }

  async _handleAllTasksCompleted(team) {
    // 防止多个 agent 同时完成最后任务时重复触发
    if (this.completedTeams.has(team.id)) return;
    this.completedTeams.add(team.id);

    const tasks = this.teamManager.getTasksByTeam(team.id);
    const results = tasks.map(t => {
      let summary = t.result || '无结果';
      try {
        const parsed = JSON.parse(summary);
        summary = parsed.summary || summary;
      } catch { /* ignore */ }
      return `- ${t.subject}: ${summary}`;
    }).join('\n');

    const integrationPrompt = `所有团队子任务已完成！请整合检查：\n\n${results}\n\n请检查所有修改是否一致，运行测试确认没有冲突。如果一切正常，请总结整体完成情况。`;

    await this._notifyLead(team, integrationPrompt);

    this.teamManager.sendMessage(team.id, null, null,
      '所有子任务已完成，已通知 Lead 进行整合检查', 'info');

    console.log(`[TaskOrchestrator] 团队 ${team.name}: 所有任务完成，通知 Lead 整合`);
  }

  // ==================== 错误恢复 ====================

  _isStuck(state) {
    if (state.phase !== 'working') return false;
    return Date.now() - state.lastActivityAt > this.STUCK_TIMEOUT;
  }

  async _handleStuck(session, state) {
    state.recoveryAttempts = (state.recoveryAttempts || 0) + 1;
    console.log(`[TaskOrchestrator] ${session.name}: 检测到卡住，恢复尝试 ${state.recoveryAttempts}/${this.MAX_RECOVERY_ATTEMPTS}`);

    if (state.recoveryAttempts > this.MAX_RECOVERY_ATTEMPTS) {
      // 放弃：标记任务失败，释放锁，重置状态
      const task = this.teamManager.getTask(state.taskId);
      if (task) {
        this.teamManager.updateTask(task.id, {
          status: 'pending',
          assigneeSessionId: null,
          assignedAt: null
        });
        this._unlockFiles(task.id);
        this.teamManager.sendMessage(task.teamId, session.id, null,
          `任务 "${task.subject}" 执行失败（Agent 卡住），已重新放回队列`, 'error');
      }
      this._resetState(state);
      return;
    }

    // 发送 Escape 中断 + 恢复提示
    session.write('\x1b');
    setTimeout(() => {
      session.write('当前任务似乎卡住了。请总结你目前的进度，然后继续完成任务。');
      setTimeout(() => session.write('\r'), 50);
    }, 500);

    state.lastActivityAt = Date.now(); // 重置活动时间
  }

  // ==================== 终端状态检测辅助 ====================

  _isClaudeWorking(cleanContent) {
    const last500 = cleanContent.slice(-500);
    return /esc to interrupt/i.test(last500) ||
           (/thinking/i.test(last500) && !/I've been thinking/i.test(last500)) ||
           /Context left/i.test(last500);
  }

  _isClaudeIdle(cleanContent) {
    // 只检查最后几行，避免匹配历史输出中的提示符
    const lines = cleanContent.split('\n');
    const lastLine = (lines[lines.length - 1] || '').trim();
    const last3Lines = lines.slice(-3).join('\n');

    if (/^[❯>]\s*$/.test(lastLine)) {
      if (!/esc to interrupt/i.test(last3Lines)) {
        return true;
      }
    }
    return false;
  }

  _isConfirmationDialog(cleanContent) {
    const last3000 = cleanContent.slice(-3000);
    return (/Do you want to (make this edit|create|delete|run)/i.test(last3000) ||
            /Do you want to proceed\?/i.test(last3000)) &&
           /1\.\s*Yes/i.test(last3000);
  }

  _isWaitingForAccept(cleanContent) {
    const last3000 = cleanContent.slice(-3000);
    const last500 = cleanContent.slice(-500);
    const hasIdlePrompt = /^[❯>]\s*$/m.test(last500);
    return !hasIdlePrompt &&
           !this._isConfirmationDialog(cleanContent) &&
           (/accept edits on/i.test(last3000) || /shift\+tab to cycle/i.test(last3000));
  }

  _autoConfirm(session, cleanContent) {
    const last3000 = cleanContent.slice(-3000);
    const hasOption2Yes = /2\.\s*Yes/i.test(last3000);
    const option = hasOption2Yes ? '2' : '1';
    console.log(`[TaskOrchestrator] ${session.name}: 自动确认，选择选项 ${option}`);
    session.write(option);
  }

  // ==================== 通用辅助 ====================

  _getOrCreateState(session) {
    let state = this.agentStates.get(session.id);
    if (!state) {
      state = {
        sessionId: session.id,
        taskId: null,
        phase: 'idle',
        assignedAt: 0,
        lastActivityAt: Date.now(),
        outputAtAssignment: 0,
        idleCount: 0,
        completionCheckCount: 0,
        recoveryAttempts: 0,
        previousFiles: []
      };
      this.agentStates.set(session.id, state);
    }
    return state;
  }

  _resetState(state) {
    state.taskId = null;
    state.phase = 'idle';
    state.idleCount = 0;
    state.completionCheckCount = 0;
    state.recoveryAttempts = 0;
  }

  _getOutputDiff(session, state) {
    const buffer = session.outputBuffer || '';
    const startPos = state.outputAtAssignment || 0;
    if (startPos >= buffer.length) return buffer.slice(-5000);
    return buffer.slice(startPos);
  }

  _cleanAnsi(text) {
    if (!text) return '';
    return text
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
  }

  _parseExpectedFiles(task) {
    if (Array.isArray(task.expectedFiles)) return task.expectedFiles;
    try {
      return JSON.parse(task.expectedFiles || '[]');
    } catch {
      return [];
    }
  }

  /**
   * 清理指定会话的编排状态（会话关闭或团队销毁时调用）
   */
  cleanupSession(sessionId) {
    this.agentStates.delete(sessionId);
    this.outputLengths.delete(sessionId);
    this.lastAiCheck.delete(sessionId);

    // 释放该会话持有的所有文件锁
    for (const [file, lock] of this.fileLocks.entries()) {
      if (lock.sessionId === sessionId) {
        this.fileLocks.delete(file);
      }
    }
  }

  /**
   * 清理团队的完成标记（团队销毁时调用）
   */
  cleanupTeam(teamId) {
    this.completedTeams.delete(teamId);
  }

  /**
   * 获取编排器状态摘要（用于前端展示）
   */
  getStatus() {
    const states = {};
    for (const [sessionId, state] of this.agentStates.entries()) {
      states[sessionId] = {
        phase: state.phase,
        taskId: state.taskId,
        idleCount: state.idleCount,
        lastActivityAt: state.lastActivityAt
      };
    }
    return {
      agentStates: states,
      fileLocks: Object.fromEntries(this.fileLocks)
    };
  }
}

export default TaskOrchestrator;
