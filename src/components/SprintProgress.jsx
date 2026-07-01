import React, { useState, useEffect } from 'react';
import RalphOffice from './RalphOffice';
import './SprintProgress.css';

const SprintProgress = ({ socket, sessionId, goal }) => {
  const [progress, setProgress] = useState(null);
  const [collapsed, setCollapsed] = useState(true);
  const [planning, setPlanning] = useState(false);
  // Ralph 自主模式状态
  const [ralphRunning, setRalphRunning] = useState(false);
  const [ralphPhase, setRalphPhase] = useState('idle');
  const [ralphTask, setRalphTask] = useState(null);
  const [ralphLogs, setRalphLogs] = useState([]);
  // 向导异步拆分状态 + 任务确认
  const [planningStatus, setPlanningStatus] = useState(null); // null|running|done|failed
  const [planError, setPlanError] = useState('');
  const [enabledTasks, setEnabledTasks] = useState({});       // featureId -> bool（待确认勾选）
  const [pauseEach, setPauseEach] = useState(false);
  const [starting, setStarting] = useState(false);
  // 执行实时反馈
  const [ralphElapsed, setRalphElapsed] = useState(0); // 当前阶段已运行毫秒
  const [ralphBytes, setRalphBytes] = useState(0);     // 当前阶段输出字节
  const [ralphStream, setRalphStream] = useState([]);  // CLI 实时输出行
  const [officeView, setOfficeView] = useState('anim'); // anim|raw 执行可视化视图
  const [theater, setTheater] = useState(false);        // 剧场模式全屏

  useEffect(() => {
    setProgress(null);
    setPlanning(false);
    setRalphRunning(false);
    setRalphPhase('idle');
    setRalphTask(null);
    setRalphLogs([]);
    setPlanningStatus(null);
    setPlanError('');
    setEnabledTasks({});
    setRalphElapsed(0);
    setRalphBytes(0);
    setRalphStream([]);
    if (!socket || !sessionId) return;

    socket.emit('progress:get', sessionId);
    socket.emit('ralph:status', { sessionId });

    // 收到 features 时初始化勾选（默认全选未完成的任务）
    const initEnabled = (progress) => {
      if (!progress?.features) return;
      setEnabledTasks(prev => {
        const en = { ...prev };
        progress.features.forEach(f => { if (en[f.id] === undefined) en[f.id] = f.status !== 'completed'; });
        return en;
      });
    };
    const handleData = (data) => {
      if (data.sessionId === sessionId) {
        setProgress(data.progress);
        setPlanning(false);
        initEnabled(data.progress);
      }
    };
    const handleUpdated = (data) => {
      if (data.sessionId === sessionId) {
        setProgress(data.progress);
        initEnabled(data.progress);
      }
    };
    // 向导后台拆分进度
    const handlePlanning = (data) => {
      if (data.sessionId !== sessionId) return;
      setPlanningStatus(data.status);
      if (data.status === 'running') { setPlanError(''); setCollapsed(false); }
      if (data.status === 'failed') setPlanError(data.error || '拆分失败');
      if (data.status === 'done') socket.emit('progress:get', sessionId);
    };
    const handleRalphState = (data) => {
      if (data.sessionId !== sessionId) return;
      setRalphRunning(!!data.running);
      if (data.phase) setRalphPhase(data.phase);
      if (data.currentTask !== undefined) setRalphTask(data.currentTask);
      // 阶段切换：清空上一阶段的实时输出与计时
      setRalphStream([]); setRalphElapsed(0); setRalphBytes(0);
      // 状态变化时刷新进度
      socket.emit('progress:get', sessionId);
    };
    const handleRalphLog = (data) => {
      if (data.sessionId !== sessionId) return;
      setRalphLogs(prev => [...prev.slice(-49), data.line]);
    };
    // CLI 实时输出流（headless 输出 + 运行计时 + 输出量）
    const handleRalphProgress = (data) => {
      if (data.sessionId !== sessionId) return;
      if (typeof data.elapsedMs === 'number') setRalphElapsed(data.elapsedMs);
      if (typeof data.bytes === 'number') setRalphBytes(data.bytes);
      if (data.lines?.length) setRalphStream(prev => [...prev, ...data.lines].slice(-60));
    };

    socket.on('progress:data', handleData);
    socket.on('progress:updated', handleUpdated);
    socket.on('ralph:state', handleRalphState);
    socket.on('ralph:log', handleRalphLog);
    socket.on('ralph:planning', handlePlanning);
    socket.on('ralph:progress', handleRalphProgress);

    return () => {
      socket.off('progress:data', handleData);
      socket.off('progress:updated', handleUpdated);
      socket.off('ralph:state', handleRalphState);
      socket.off('ralph:log', handleRalphLog);
      socket.off('ralph:planning', handlePlanning);
      socket.off('ralph:progress', handleRalphProgress);
    };
  }, [socket, sessionId]);

  const rePlan = (e) => {
    e.stopPropagation();
    if (!goal || planning) return;
    setPlanning(true);
    socket.emit('progress:plan', { sessionId, goal });
    // planning 状态在收到 progress:data 时自动清除
    setTimeout(() => setPlanning(false), 30000);
  };

  const toggleEvaluator = () => {
    const enabled = !progress.evaluatorConfig?.enabled;
    socket.emit('evaluator:toggle', { sessionId, enabled });
    setProgress(prev => ({
      ...prev,
      evaluatorConfig: { ...prev.evaluatorConfig, enabled }
    }));
  };

  // Ralph 自主模式：拆分（带验收标准）
  const ralphPlan = (e) => {
    e.stopPropagation();
    if (!goal || planning) return;
    setPlanning(true);
    socket.emit('ralph:plan', { sessionId, goal });
    setTimeout(() => setPlanning(false), 60000);
  };

  // Ralph 自主模式：启动/停止
  const toggleRalph = (e) => {
    e.stopPropagation();
    if (ralphRunning) {
      socket.emit('ralph:stop', { sessionId });
    } else {
      socket.emit('ralph:start', { sessionId, maxIterations: 100 });
      setRalphRunning(true);
    }
  };

  // Ralph 自主模式：暂停/继续
  const togglePause = (e) => {
    e.stopPropagation();
    if (ralphPhase === 'paused') {
      socket.emit('ralph:resume', { sessionId });
    } else {
      socket.emit('ralph:stop', { sessionId }); // 无单独暂停指令时，停止即中断
    }
  };

  // 任务确认：勾选/取消某任务
  const toggleTask = (id, e) => {
    e.stopPropagation();
    setEnabledTasks(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // 确认任务清单并开始自主开发（走向导执行入口，带 git 干净护栏）
  const startRalphWizard = (e) => {
    e.stopPropagation();
    if (starting || ralphRunning) return;
    const ids = (progress?.features || []).filter(f => enabledTasks[f.id]).map(f => f.id);
    if (ids.length === 0) { setPlanError('请至少勾选一个任务'); return; }
    setPlanError('');
    const doStart = (ignoreDirty) => {
      setStarting(true);
      socket.emit('ralph:wizard:start',
        { sessionId, enabledTaskIds: ids, pauseAfterEachTask: pauseEach, ignoreDirty },
        (res) => {
          setStarting(false);
          if (res?.blocked === 'dirty') {
            if (window.confirm('工作区有未提交改动，仍要开始吗？\n\n' + (res.files || []).join('\n'))) doStart(true);
            return;
          }
          if (res?.error) { setPlanError(res.error); return; }
          // started：ralph:state 事件会把面板切到执行态
        });
    };
    doStart(false);
  };

  // 断点继续：从未完成任务接着跑（getNextTask 天然跳过已完成，不切分支、不重做）
  const resumeRalph = (e) => {
    e.stopPropagation();
    if (ralphRunning) return;
    socket.emit('ralph:start', { sessionId, maxIterations: 100 });
    setRalphRunning(true);
  };

  const fmtTime = (ms) => {
    const s = Math.floor((ms || 0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const fmtBytes = (b) => (!b ? '0B' : b < 1024 ? `${b}B` : `${(b / 1024).toFixed(1)}KB`);

  if (!progress?.features?.length) {
    // 向导后台拆分中：即使还没任务清单也显示状态（用户此时已在会话窗口，可自由切换）
    if (planningStatus === 'running') {
      return (
        <div className="sprint-progress">
          <div className="sprint-header">
            <div className="sprint-title">
              <span className="sprint-icon">⏳</span>
              <span>正在分析需求、设计技术方案与拆分任务…（可切到其他会话，完成后回来查看）</span>
            </div>
          </div>
        </div>
      );
    }
    if (planningStatus === 'failed') {
      return (
        <div className="sprint-progress">
          <div className="sprint-header" onClick={ralphPlan} style={{ cursor: 'pointer' }}>
            <div className="sprint-title">
              <span className="sprint-icon">⚠️</span>
              <span>{planError || '拆分失败'} · 点击重试</span>
            </div>
          </div>
        </div>
      );
    }
    if (!goal || goal.length < 3) return null;
    return (
      <div className="sprint-progress">
        <div className="sprint-header" onClick={rePlan} style={{ cursor: planning ? 'wait' : 'pointer' }}>
          <div className="sprint-title">
            <span className="sprint-icon">📋</span>
            <span>{planning ? '正在分析项目并规划...' : '点击生成 Sprint 规划'}</span>
          </div>
        </div>
      </div>
    );
  }

  const total = progress.features.length;
  const completed = progress.features.filter(f => f.status === 'completed').length;
  const percent = Math.round(completed / total * 100);
  const current = progress.features.find(f => f.status === 'in_progress')
    || progress.features.find(f => f.status === 'pending');

  // 断点续跑判定：自主模式 + 有未完成 + 当前没在跑 + 已跑过一部分 = 中断态
  const unfinished = progress.features.filter(f => !f.blocked && f.status !== 'completed').length;
  const isAutonomous = progress.mode === 'autonomous';
  const hasStarted = completed > 0 || progress.features.some(f => f.status === 'in_progress');
  const isInterrupted = isAutonomous && unfinished > 0 && !ralphRunning && hasStarted;

  return (
    <div className="sprint-progress">
      <div className="sprint-header" onClick={() => setCollapsed(!collapsed)}>
        <div className="sprint-title">
          <span className="sprint-icon">📋</span>
          <span>Sprint 进度</span>
          <span className="sprint-badge">{completed}/{total}</span>
        </div>
        <div className="sprint-bar-mini">
          <div className="sprint-bar-fill" style={{ width: `${percent}%` }} />
        </div>
        <button className="sprint-replan-btn" onClick={rePlan} disabled={planning}
          title="重新分析项目并规划">
          {planning ? '⏳' : '🔄'}
        </button>
        <span className="sprint-toggle">{collapsed ? '▶' : '▼'}</span>
      </div>

      {!collapsed && (
        <div className="sprint-body">
          <div className="sprint-features">
            {progress.features.map((f, i) => (
              <div key={f.id} className={`sprint-feature ${f.blocked ? 'blocked' : f.status}`}>
                {!ralphRunning && f.status !== 'completed' ? (
                  <input
                    type="checkbox"
                    className="feature-check"
                    checked={!!enabledTasks[f.id]}
                    onChange={(e) => toggleTask(f.id, e)}
                    onClick={(e) => e.stopPropagation()}
                    title="勾选要执行的任务"
                  />
                ) : (
                  <span className="feature-status-icon">
                    {f.blocked ? '🚫' :
                     f.status === 'completed' ? '✅' :
                     f.status === 'in_progress' ? '🔨' : '⬜'}
                  </span>
                )}
                <span className="feature-name">{f.name}</span>
                {f.retryCount > 0 && !f.blocked && (
                  <span className="feature-retry" title={f.validationNotes || ''}>↻{f.retryCount}</span>
                )}
              </div>
            ))}
          </div>
          {current && (
            <div className="sprint-current">
              当前: <strong>{current.name}</strong>
            </div>
          )}
          <div className="sprint-footer">
            <label className="evaluator-toggle">
              <input
                type="checkbox"
                checked={progress.evaluatorConfig?.enabled || false}
                onChange={toggleEvaluator}
              />
              <span>Evaluator 对抗评估</span>
            </label>
            {progress.sprint?.completionCriteria && (
              <div className="sprint-criteria" title={progress.sprint.completionCriteria}>
                目标: {progress.sprint.completionCriteria.substring(0, 40)}...
              </div>
            )}
          </div>

          {/* Ralph 自主模式控制区 */}
          <div className="ralph-panel">
            {planError && <div className="ralph-plan-error">⚠️ {planError}</div>}
            {/* 中断态：一键断点继续（从未完成任务接着跑，不重做已完成） */}
            {isInterrupted && (
              <div className="ralph-resume-banner">
                <span className="ralph-resume-text">⏸ 上次自主开发未完成 · 已完成 {completed}/{total}</span>
                <button className="ralph-start-btn" onClick={resumeRalph}
                  title="从未完成任务接着跑，已完成的不重做">🔄 断点继续</button>
              </div>
            )}
            {/* 全新待确认态：勾选任务 + 开始自主开发（刚拆分完、未开始） */}
            {!ralphRunning && !isInterrupted && (
              <div className="ralph-confirm-row">
                <button className="ralph-start-btn" onClick={startRalphWizard} disabled={starting}
                  title="确认勾选的任务并开始自主开发（Developer→Validator 循环，带 git 干净护栏）">
                  {starting ? '⏳ 启动中…' : '🚀 开始自主开发'}
                </button>
                <label className="ralph-pause-toggle" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={pauseEach} onChange={(e) => setPauseEach(e.target.checked)} />
                  <span>每个任务后暂停</span>
                </label>
              </div>
            )}
            <div className="ralph-controls">
              <button className="ralph-replan-btn" onClick={ralphPlan} disabled={planning}
                title="按需求文档/设计文档拆分为带验收标准的可执行任务">
                {planning ? '⏳ 拆分中' : '🧩 重新拆分'}
              </button>
              <button className={`ralph-run-btn ${ralphRunning ? 'running' : ''}`} onClick={toggleRalph}
                title={ralphRunning ? '停止自主执行' : '直接启动（跳过确认）'}>
                {ralphRunning ? '⏹ 停止自主' : '🤖 直接执行'}
              </button>
              {ralphRunning && ralphPhase === 'paused' && (
                <button className="ralph-resume-btn" onClick={togglePause} title="继续执行下一个任务">
                  ▶ 继续
                </button>
              )}
              {ralphRunning && (
                <span className={`ralph-phase ralph-phase-${ralphPhase}`}>
                  {ralphPhase === 'developing' ? '👨‍💻 开发中' :
                   ralphPhase === 'validating' ? '🔍 验证中' :
                   ralphPhase === 'paused' ? '⏸ 已暂停' :
                   ralphPhase === 'done' ? '✅ 完成' : '⏳ 调度中'}
                  {ralphTask && <em> · {ralphTask.name}</em>}
                  {(ralphPhase === 'developing' || ralphPhase === 'validating') && (
                    <span className="ralph-meter"> · ⏱ {fmtTime(ralphElapsed)} · {fmtBytes(ralphBytes)}
                      <span className="ralph-pulse" /></span>
                  )}
                </span>
              )}
            </div>
            {/* 执行可视化：默认像素办公室动画，可切原始 CLI 输出流 */}
            {ralphRunning && (
              <>
                <div className="ralph-view-switch">
                  <button className={officeView === 'anim' ? 'active' : ''} onClick={() => setOfficeView('anim')}>🏭 动画</button>
                  <button className={officeView === 'raw' ? 'active' : ''} onClick={() => setOfficeView('raw')}>📜 原始输出</button>
                </div>
                {officeView === 'anim' ? (
                  <RalphOffice
                    features={progress.features}
                    phase={ralphPhase}
                    currentTaskId={ralphTask?.id || progress.features.find(f => f.status === 'in_progress')?.id}
                    elapsed={ralphElapsed}
                    completed={completed}
                    total={total}
                    theater={theater}
                    onToggleTheater={() => setTheater(t => !t)}
                  />
                ) : (
                  ralphStream.length > 0 && (
                    <div className="ralph-stream" ref={el => { if (el) el.scrollTop = el.scrollHeight; }}>
                      {ralphStream.slice(-30).map((l, i) => (
                        <div key={i} className="ralph-stream-line">{l}</div>
                      ))}
                    </div>
                  )
                )}
              </>
            )}
            {ralphLogs.length > 0 && (
              <div className="ralph-logs">
                {ralphLogs.slice(-8).map((l, i) => (
                  <div key={i} className="ralph-log-line">{l}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default SprintProgress;
