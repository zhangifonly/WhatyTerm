import React, { useState, useEffect } from 'react';
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

  useEffect(() => {
    setProgress(null);
    setPlanning(false);
    setRalphRunning(false);
    setRalphPhase('idle');
    setRalphTask(null);
    setRalphLogs([]);
    if (!socket || !sessionId) return;

    socket.emit('progress:get', sessionId);
    socket.emit('ralph:status', { sessionId });

    const handleData = (data) => {
      if (data.sessionId === sessionId) {
        setProgress(data.progress);
        setPlanning(false);
      }
    };
    const handleUpdated = (data) => {
      if (data.sessionId === sessionId) {
        setProgress(data.progress);
      }
    };
    const handleRalphState = (data) => {
      if (data.sessionId !== sessionId) return;
      setRalphRunning(!!data.running);
      if (data.phase) setRalphPhase(data.phase);
      if (data.currentTask !== undefined) setRalphTask(data.currentTask);
      // 状态变化时刷新进度
      socket.emit('progress:get', sessionId);
    };
    const handleRalphLog = (data) => {
      if (data.sessionId !== sessionId) return;
      setRalphLogs(prev => [...prev.slice(-49), data.line]);
    };

    socket.on('progress:data', handleData);
    socket.on('progress:updated', handleUpdated);
    socket.on('ralph:state', handleRalphState);
    socket.on('ralph:log', handleRalphLog);

    return () => {
      socket.off('progress:data', handleData);
      socket.off('progress:updated', handleUpdated);
      socket.off('ralph:state', handleRalphState);
      socket.off('ralph:log', handleRalphLog);
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

  if (!progress?.features?.length) {
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
                <span className="feature-status-icon">
                  {f.blocked ? '🚫' :
                   f.status === 'completed' ? '✅' :
                   f.status === 'in_progress' ? '🔨' : '⬜'}
                </span>
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
            <div className="ralph-controls">
              <button className="ralph-replan-btn" onClick={ralphPlan} disabled={planning}
                title="按需求文档/设计文档拆分为带验收标准的可执行任务">
                {planning ? '⏳ 拆分中' : '🧩 自主拆分'}
              </button>
              <button className={`ralph-run-btn ${ralphRunning ? 'running' : ''}`} onClick={toggleRalph}
                title={ralphRunning ? '停止自主执行' : '启动自主执行（Developer→Validator 循环）'}>
                {ralphRunning ? '⏹ 停止自主' : '🤖 自主执行'}
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
                </span>
              )}
            </div>
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
