import React, { useState, useEffect } from 'react';
import './SprintProgress.css';

const SprintProgress = ({ socket, sessionId, goal }) => {
  const [progress, setProgress] = useState(null);
  const [collapsed, setCollapsed] = useState(true);
  const [planning, setPlanning] = useState(false);

  useEffect(() => {
    setProgress(null);
    setPlanning(false);
    if (!socket || !sessionId) return;

    socket.emit('progress:get', sessionId);

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

    socket.on('progress:data', handleData);
    socket.on('progress:updated', handleUpdated);

    return () => {
      socket.off('progress:data', handleData);
      socket.off('progress:updated', handleUpdated);
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
              <div key={f.id} className={`sprint-feature ${f.status}`}>
                <span className="feature-status-icon">
                  {f.status === 'completed' ? '✅' :
                   f.status === 'in_progress' ? '🔨' : '⬜'}
                </span>
                <span className="feature-name">{f.name}</span>
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
        </div>
      )}
    </div>
  );
};

export default SprintProgress;
