/**
 * TeamManager - Agent Teams 多 Agent 协作管理服务
 *
 * 核心功能：
 * 1. Team 生命周期管理（创建/暂停/恢复/销毁）
 * 2. SharedTask 任务管理（创建/分配/完成/依赖解锁）
 * 3. TeamMessage 消息系统
 * 4. 协调循环（空闲检测 + 任务分配）
 */

import { v4 as uuidv4 } from 'uuid';

class TeamManager {
  constructor(db, sessionManager, aiEngine) {
    this.db = db;
    this.sessionManager = sessionManager;
    this.aiEngine = aiEngine;
    this._initTables();
  }

  // ==================== 数据库初始化 ====================

  _initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT,
        goal TEXT,
        working_dir TEXT,
        status TEXT DEFAULT 'active',
        lead_session_id TEXT,
        member_session_ids TEXT,
        max_members INTEGER DEFAULT 4,
        created_at TEXT,
        updated_at TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS team_tasks (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'pending',
        assignee_session_id TEXT,
        blocked_by TEXT,
        priority INTEGER DEFAULT 0,
        result TEXT,
        expected_files TEXT DEFAULT '[]',
        files_modified TEXT DEFAULT '[]',
        assigned_at TEXT,
        completed_at TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS team_messages (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        from_session_id TEXT,
        to_session_id TEXT,
        type TEXT DEFAULT 'info',
        content TEXT,
        created_at TEXT
      )
    `);

    // 迁移：为已有数据库添加新列
    const migrateCols = [
      ['team_tasks', 'expected_files', "TEXT DEFAULT '[]'"],
      ['team_tasks', 'files_modified', "TEXT DEFAULT '[]'"],
      ['team_tasks', 'assigned_at', 'TEXT'],
      ['team_tasks', 'completed_at', 'TEXT'],
    ];
    for (const [table, col, type] of migrateCols) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
      } catch { /* 列已存在，忽略 */ }
    }
  }

  // ==================== Team 生命周期 ====================

  /**
   * 创建团队
   * @param {Object} options - { name, goal, workingDir, memberCount }
   * @returns {Object} team 对象
   */
  async createTeam({ name, goal, workingDir, memberCount = 2 }) {
    const teamId = uuidv4();
    const now = new Date().toISOString();
    const maxMembers = Math.min(Math.max(memberCount, 1), 6);

    // 1. 创建 Lead Session
    const leadSession = await this.sessionManager.createSession({
      name: `${name}-lead`,
      goal: `[Team Lead] ${goal}`,
      teamId,
      teamRole: 'lead'
    });
    leadSession.teamId = teamId;
    leadSession.teamRole = 'lead';
    leadSession.autoActionEnabled = true;
    this.sessionManager.updateSession(leadSession);

    // 2. 创建 Teammate Sessions
    const memberSessionIds = [];
    for (let i = 0; i < maxMembers; i++) {
      const memberSession = await this.sessionManager.createSession({
        name: `${name}-agent${i + 1}`,
        goal: `[Teammate] 等待任务分配...`,
        teamId,
        teamRole: 'member'
      });
      memberSession.teamId = teamId;
      memberSession.teamRole = 'member';
      memberSession.autoActionEnabled = true;
      this.sessionManager.updateSession(memberSession);
      memberSessionIds.push(memberSession.id);
    }

    // 3. 保存 Team 到数据库
    const team = {
      id: teamId,
      name,
      goal,
      workingDir: workingDir || '',
      status: 'active',
      leadSessionId: leadSession.id,
      memberSessionIds,
      maxMembers,
      createdAt: now,
      updatedAt: now
    };

    this.db.prepare(`
      INSERT INTO teams (id, name, goal, working_dir, status, lead_session_id, member_session_ids, max_members, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      team.id, team.name, team.goal, team.workingDir, team.status,
      team.leadSessionId, JSON.stringify(team.memberSessionIds),
      team.maxMembers, team.createdAt, team.updatedAt
    );

    // 4. AI 分解目标为子任务（异步执行，不阻塞团队创建）
    this._decomposeGoal(team).catch(err => {
      console.error(`[TeamManager] 目标分解失败:`, err.message);
      // 创建一个默认任务
      try {
        this.createTask(teamId, {
          subject: goal,
          description: `完成目标: ${goal}`
        });
      } catch (createErr) {
        console.error(`[TeamManager] 创建回退任务失败:`, createErr.message);
      }
    });

    // 5. 记录创建消息
    this.sendMessage(teamId, null, null, `团队 "${name}" 已创建，目标: ${goal}`, 'info');

    return this._formatTeam(team);
  }

  /**
   * 获取团队
   */
  getTeam(teamId) {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    if (!row) return null;
    return this._formatTeam(this._rowToTeam(row));
  }

  /**
   * 列出所有团队
   */
  listTeams() {
    const rows = this.db.prepare('SELECT * FROM teams ORDER BY created_at DESC').all();
    return rows.map(row => this._formatTeam(this._rowToTeam(row)));
  }

  /**
   * 暂停团队（暂停所有成员的 autoAction）
   */
  pauseTeam(teamId) {
    const team = this.getTeam(teamId);
    if (!team) return null;

    const allSessionIds = [team.leadSessionId, ...team.memberSessionIds];
    for (const sid of allSessionIds) {
      const session = this.sessionManager.getSession(sid);
      if (session) {
        session.autoActionEnabled = false;
        this.sessionManager.updateSession(session);
      }
    }

    this._updateTeamStatus(teamId, 'paused');
    this.sendMessage(teamId, null, null, '团队已暂停', 'info');
    return this.getTeam(teamId);
  }

  /**
   * 恢复团队
   */
  resumeTeam(teamId) {
    const team = this.getTeam(teamId);
    if (!team) return null;

    const allSessionIds = [team.leadSessionId, ...team.memberSessionIds];
    for (const sid of allSessionIds) {
      const session = this.sessionManager.getSession(sid);
      if (session) {
        session.autoActionEnabled = true;
        this.sessionManager.updateSession(session);
      }
    }

    this._updateTeamStatus(teamId, 'active');
    this.sendMessage(teamId, null, null, '团队已恢复', 'info');
    return this.getTeam(teamId);
  }

  /**
   * 从现有会话创建团队
   * 现有会话成为 Team Lead，只创建 Teammate 会话并自动启动 Claude
   * @param {Object} existingSession - 已运行的会话对象
   * @param {Object} options - { goal, memberCount }
   * @param {Function} onSessionCreated - 每个 Teammate 创建后的回调（用于注册 bell/exit 回调）
   * @returns {Object} team 对象
   */
  async createTeamFromSession(existingSession, { goal, memberCount = 2 }, onSessionCreated) {
    const teamId = uuidv4();
    const now = new Date().toISOString();
    const maxMembers = Math.min(Math.max(memberCount, 1), 4);
    const workingDir = existingSession.workingDir || '';
    const teamName = existingSession.projectName || existingSession.name || 'team';

    // 1. 将现有会话提升为 Lead
    existingSession.teamId = teamId;
    existingSession.teamRole = 'lead';
    existingSession.autoActionEnabled = true;
    this.sessionManager.updateSession(existingSession);

    // 2. 创建 Teammate Sessions 并启动 Claude
    const memberSessionIds = [];
    for (let i = 0; i < maxMembers; i++) {
      const memberSession = await this.sessionManager.createSession({
        name: `${teamName}-agent${i + 1}`,
        goal: `[Teammate] 等待任务分配...`,
        teamId,
        teamRole: 'member'
      });
      memberSession.teamId = teamId;
      memberSession.teamRole = 'member';
      memberSession.autoActionEnabled = true;
      memberSession.workingDir = workingDir;
      this.sessionManager.updateSession(memberSession);
      memberSessionIds.push(memberSession.id);

      // 回调：让 server/index.js 注册 bell/exit 回调
      if (onSessionCreated) {
        onSessionCreated(memberSession);
      }

      // 在 Teammate 中启动 Claude
      this._launchClaudeInSession(memberSession, workingDir);
    }

    // 3. 保存 Team 到数据库
    const team = {
      id: teamId,
      name: teamName,
      goal,
      workingDir,
      status: 'active',
      leadSessionId: existingSession.id,
      memberSessionIds,
      maxMembers,
      createdAt: now,
      updatedAt: now
    };

    this.db.prepare(`
      INSERT INTO teams (id, name, goal, working_dir, status, lead_session_id, member_session_ids, max_members, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      team.id, team.name, team.goal, team.workingDir, team.status,
      team.leadSessionId, JSON.stringify(team.memberSessionIds),
      team.maxMembers, team.createdAt, team.updatedAt
    );

    // 4. AI 分解目标为子任务
    this._decomposeGoal(team).catch(err => {
      console.error(`[TeamManager] 目标分解失败:`, err.message);
      try {
        this.createTask(teamId, {
          subject: goal,
          description: `完成目标: ${goal}`
        });
      } catch (createErr) {
        console.error(`[TeamManager] 创建回退任务失败:`, createErr.message);
      }
    });

    // 5. 记录消息
    this.sendMessage(teamId, null, null, `团队 "${teamName}" 已从现有会话创建，目标: ${goal}`, 'info');

    return this._formatTeam(team);
  }

  /**
   * 在会话中启动 Claude Code
   * 遵循 session:createAndResume 的时序模式
   */
  _launchClaudeInSession(session, workingDir) {
    setTimeout(() => {
      if (workingDir) {
        session.write(`cd "${workingDir}"\r`);
      }
      setTimeout(() => {
        session.write(`claude -c\r`);
      }, 300);
    }, 500);
  }

  /**
   * 销毁团队
   * 只关闭 Teammate 会话，Lead 会话恢复为普通会话
   */
  async destroyTeam(teamId) {
    const team = this.getTeam(teamId);
    if (!team) return null;

    // 只关闭 Teammate 会话
    for (const sid of team.memberSessionIds) {
      try {
        await this.sessionManager.closeSession(sid);
      } catch (err) {
        console.error(`[TeamManager] 关闭会话 ${sid} 失败:`, err.message);
      }
    }

    // 将 Lead 会话恢复为普通会话
    const leadSession = this.sessionManager.getSession(team.leadSessionId);
    if (leadSession) {
      leadSession.teamId = null;
      leadSession.teamRole = null;
      this.sessionManager.updateSession(leadSession);
    }

    this._updateTeamStatus(teamId, 'completed');
    this.sendMessage(teamId, null, null, '团队已销毁', 'info');
    return this.getTeam(teamId);
  }

  // ==================== 任务管理 ====================

  /**
   * 创建任务
   */
  createTask(teamId, { subject, description = '', priority = 0, blockedBy = [], expectedFiles = [] }) {
    const taskId = uuidv4();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO team_tasks (id, team_id, subject, description, status, assignee_session_id, blocked_by, priority, result, expected_files, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, ?, ?, ?)
    `).run(taskId, teamId, subject, description, JSON.stringify(blockedBy), priority, JSON.stringify(expectedFiles), now, now);

    const task = {
      id: taskId, teamId, subject, description,
      status: 'pending', assigneeSessionId: null,
      blockedBy, priority, result: null,
      expectedFiles,
      createdAt: now, updatedAt: now
    };

    this.sendMessage(teamId, null, null, `新任务: ${subject}`, 'task_update');
    return task;
  }

  /**
   * 更新任务
   */
  updateTask(taskId, updates) {
    const task = this.getTask(taskId);
    if (!task) return null;

    const fields = [];
    const values = [];

    if (updates.subject !== undefined) { fields.push('subject = ?'); values.push(updates.subject); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.assigneeSessionId !== undefined) { fields.push('assignee_session_id = ?'); values.push(updates.assigneeSessionId); }
    if (updates.priority !== undefined) { fields.push('priority = ?'); values.push(updates.priority); }
    if (updates.result !== undefined) { fields.push('result = ?'); values.push(updates.result); }
    if (updates.blockedBy !== undefined) { fields.push('blocked_by = ?'); values.push(JSON.stringify(updates.blockedBy)); }
    if (updates.expectedFiles !== undefined) { fields.push('expected_files = ?'); values.push(JSON.stringify(updates.expectedFiles)); }
    if (updates.filesModified !== undefined) { fields.push('files_modified = ?'); values.push(JSON.stringify(updates.filesModified)); }
    if (updates.assignedAt !== undefined) { fields.push('assigned_at = ?'); values.push(updates.assignedAt); }
    if (updates.completedAt !== undefined) { fields.push('completed_at = ?'); values.push(updates.completedAt); }

    if (fields.length === 0) return task;

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(taskId);

    this.db.prepare(`UPDATE team_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getTask(taskId);
  }

  /**
   * 获取单个任务
   */
  getTask(taskId) {
    const row = this.db.prepare('SELECT * FROM team_tasks WHERE id = ?').get(taskId);
    if (!row) return null;
    return this._rowToTask(row);
  }

  /**
   * 获取团队的所有任务
   */
  getTasksByTeam(teamId) {
    const rows = this.db.prepare('SELECT * FROM team_tasks WHERE team_id = ? ORDER BY priority DESC, created_at ASC').all(teamId);
    return rows.map(row => this._rowToTask(row));
  }

  /**
   * 分配任务给 Teammate
   */
  async assignTask(taskId, sessionId) {
    const task = this.getTask(taskId);
    if (!task) return null;

    this.updateTask(taskId, {
      status: 'in_progress',
      assigneeSessionId: sessionId,
      assignedAt: new Date().toISOString()
    });

    // 向 Teammate 终端发送任务指令
    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      // 更新 session 的 goal
      session.goal = `[任务] ${task.subject}`;
      this.sessionManager.updateSession(session);

      // 向终端写入任务描述
      const taskPrompt = `请完成以下任务:\n\n## ${task.subject}\n\n${task.description}\n\n完成后请告知。`;
      session.write(taskPrompt);
      setTimeout(() => session.write('\r'), 50);
    }

    this.sendMessage(task.teamId, null, sessionId,
      `任务 "${task.subject}" 已分配给 ${session?.name || sessionId}`, 'task_update');

    return this.getTask(taskId);
  }

  /**
   * 完成任务 + 解锁被阻塞的任务
   */
  completeTask(taskId, result = '') {
    const task = this.getTask(taskId);
    if (!task) return null;

    this.updateTask(taskId, {
      status: 'completed',
      result,
      completedAt: new Date().toISOString()
    });

    // 解锁被此任务阻塞的其他任务
    const teamTasks = this.getTasksByTeam(task.teamId);
    for (const t of teamTasks) {
      if (t.blockedBy && t.blockedBy.includes(taskId)) {
        const newBlockedBy = t.blockedBy.filter(id => id !== taskId);
        this.updateTask(t.id, { blockedBy: newBlockedBy });
      }
    }

    this.sendMessage(task.teamId, task.assigneeSessionId, null,
      `任务 "${task.subject}" 已完成`, 'task_update');

    return this.getTask(taskId);
  }

  // ==================== 消息系统 ====================

  /**
   * 发送消息
   */
  sendMessage(teamId, fromSessionId, toSessionId, content, type = 'info') {
    const msgId = uuidv4();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO team_messages (id, team_id, from_session_id, to_session_id, type, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(msgId, teamId, fromSessionId, toSessionId, type, content, now);

    return {
      id: msgId, teamId, fromSessionId, toSessionId,
      type, content, createdAt: now
    };
  }

  /**
   * 获取团队消息
   */
  getTeamMessages(teamId, limit = 50) {
    const rows = this.db.prepare(
      'SELECT * FROM team_messages WHERE team_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(teamId, limit);
    return rows.reverse(); // 按时间正序返回
  }

  // ==================== 协调逻辑 ====================

  /**
   * 协调循环：检查空闲 Teammate，分配待处理任务
   * 由 server/index.js 的 setInterval 定时调用
   */
  async runCoordination() {
    const teams = this.db.prepare("SELECT * FROM teams WHERE status = 'active'").all();

    for (const row of teams) {
      const team = this._rowToTeam(row);
      try {
        await this._coordinateTeam(team);
      } catch (err) {
        console.error(`[TeamManager] 协调团队 ${team.id} 失败:`, err.message);
      }
    }
  }

  async _coordinateTeam(team) {
    const tasks = this.getTasksByTeam(team.id);

    // 只检查是否所有任务完成（任务分配已由 TaskOrchestrator 接管）
    if (tasks.length > 0 && tasks.every(t => t.status === 'completed')) {
      this._updateTeamStatus(team.id, 'completed');
      this.sendMessage(team.id, null, null, '所有任务已完成，团队工作结束', 'info');
    }
  }

  // ==================== AI 目标分解 ====================

  async _decomposeGoal(team) {
    if (!this.aiEngine) {
      throw new Error('AIEngine 未初始化');
    }

    const prompt = `你是一个项目管理专家。请将以下目标拆分为可并行执行的子任务。

目标: ${team.goal}
可用 Agent 数量: ${team.memberSessionIds.length}

要求:
1. 每个子任务应该是独立可执行的
2. 如果有依赖关系，用 blockedBy 数组标注（引用其他任务的序号，从 0 开始）
3. 任务数量应该合理（不超过 Agent 数量的 3 倍）
4. 每个任务的描述要具体、可操作
5. expectedFiles 列出该任务预计会修改的文件路径（用于冲突检测）

请严格返回 JSON 数组格式（不要包含其他文字）:
[{"subject":"任务标题","description":"详细描述","expectedFiles":["src/file1.js","src/file2.js"],"blockedBy":[],"priority":0}]

priority: 0=普通, 1=高优先级`;

    const result = await this.aiEngine.generateText(prompt);
    if (!result) {
      throw new Error('AI 返回空结果');
    }

    // 提取 JSON 数组（使用非贪婪匹配，避免匹配到多余内容）
    let jsonMatch = null;
    const matches = result.match(/\[[\s\S]*?\]/g);
    if (matches) {
      for (const match of matches) {
        try {
          const parsed = JSON.parse(match);
          if (Array.isArray(parsed) && parsed.length > 0) {
            jsonMatch = match;
            break;
          }
        } catch { /* 继续尝试下一个匹配 */ }
      }
    }
    if (!jsonMatch) {
      throw new Error('AI 返回格式不正确');
    }

    const taskDefs = JSON.parse(jsonMatch);
    if (!Array.isArray(taskDefs) || taskDefs.length === 0) {
      throw new Error('AI 返回的任务列表为空');
    }

    // 创建任务，建立 ID 映射（序号 → 实际 ID）
    const idMap = new Map();
    const createdTasks = [];

    for (let i = 0; i < taskDefs.length; i++) {
      const def = taskDefs[i];
      const task = this.createTask(team.id, {
        subject: def.subject || `任务 ${i + 1}`,
        description: def.description || '',
        priority: def.priority || 0,
        expectedFiles: def.expectedFiles || [],
        blockedBy: [] // 先创建，后设置依赖
      });
      idMap.set(i, task.id);
      createdTasks.push({ task, def });
    }

    // 设置依赖关系
    for (let idx = 0; idx < createdTasks.length; idx++) {
      const { task, def } = createdTasks[idx];
      if (def.blockedBy && def.blockedBy.length > 0) {
        const blockedByIds = def.blockedBy
          .filter(i => typeof i === 'number' && i >= 0 && i < idx) // 只能依赖序号更小的任务
          .map(i => idMap.get(i))
          .filter(Boolean);
        if (blockedByIds.length > 0) {
          this.updateTask(task.id, { blockedBy: blockedByIds });
        }
      }
    }

    console.log(`[TeamManager] 目标分解完成，创建了 ${createdTasks.length} 个任务`);
    return createdTasks.map(c => c.task);
  }

  // ==================== 内部辅助方法 ====================

  _rowToTeam(row) {
    return {
      id: row.id,
      name: row.name,
      goal: row.goal,
      workingDir: row.working_dir,
      status: row.status,
      leadSessionId: row.lead_session_id,
      memberSessionIds: JSON.parse(row.member_session_ids || '[]'),
      maxMembers: row.max_members,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  _rowToTask(row) {
    return {
      id: row.id,
      teamId: row.team_id,
      subject: row.subject,
      description: row.description,
      status: row.status,
      assigneeSessionId: row.assignee_session_id,
      blockedBy: JSON.parse(row.blocked_by || '[]'),
      priority: row.priority,
      result: row.result,
      expectedFiles: JSON.parse(row.expected_files || '[]'),
      filesModified: JSON.parse(row.files_modified || '[]'),
      assignedAt: row.assigned_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  _formatTeam(team) {
    // 附加任务统计
    const tasks = this.getTasksByTeam(team.id);
    const completedCount = tasks.filter(t => t.status === 'completed').length;
    return {
      ...team,
      taskStats: {
        total: tasks.length,
        completed: completedCount,
        inProgress: tasks.filter(t => t.status === 'in_progress').length,
        pending: tasks.filter(t => t.status === 'pending').length,
        blocked: tasks.filter(t => t.status === 'blocked').length
      }
    };
  }

  _updateTeamStatus(teamId, status) {
    this.db.prepare('UPDATE teams SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), teamId);
  }
}

export default TeamManager;
