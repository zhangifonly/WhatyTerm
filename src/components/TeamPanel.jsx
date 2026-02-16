import React, { useState, useEffect, useRef } from 'react';

/**
 * TeamPanel - 团队信息面板
 * 显示任务列表、消息流、成员状态、操作按钮
 */
function TeamPanel({ team, socket, onClose }) {
  const [tasks, setTasks] = useState([]);
  const [messages, setMessages] = useState([]);
  const [newTaskSubject, setNewTaskSubject] = useState('');
  const [activeTab, setActiveTab] = useState('tasks'); // tasks | messages
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const destroyTimerRef = useRef(null);

  useEffect(() => {
    if (!socket || !team) return;

    const handleTasks = (data) => setTasks(Array.isArray(data) ? data : []);
    const handleTaskUpdated = (task) => {
      if (!task?.id) return;
      setTasks(prev => {
        const idx = prev.findIndex(t => t.id === task.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = task;
          return next;
        }
        // 仅当确实不存在时才追加
        return [...prev, task];
      });
    };
    const handleMessages = (data) => setMessages(Array.isArray(data) ? data : []);
    const handleMessageReceived = (msg) => {
      setMessages(prev => [...prev, msg]);
    };

    socket.on('team:tasks', handleTasks);
    socket.on('team:taskUpdated', handleTaskUpdated);
    socket.on('team:messages', handleMessages);
    socket.on('team:messageReceived', handleMessageReceived);

    return () => {
      socket.off('team:tasks', handleTasks);
      socket.off('team:taskUpdated', handleTaskUpdated);
      socket.off('team:messages', handleMessages);
      socket.off('team:messageReceived', handleMessageReceived);
    };
  }, [socket, team?.id]);

  if (!team) return null;

  const stats = team.taskStats || { total: 0, completed: 0, inProgress: 0, pending: 0 };
  const progress = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;

  const handleAddTask = () => {
    const subject = newTaskSubject.trim();
    if (!subject || !socket || subject.length > 200) return;
    socket.emit('team:task:create', {
      teamId: team.id,
      subject
    });
    setNewTaskSubject('');
  };

  const handlePause = () => socket?.emit('team:pause', team.id);
  const handleResume = () => socket?.emit('team:resume', team.id);
  const handleDestroy = () => {
    if (!confirmDestroy) {
      setConfirmDestroy(true);
      destroyTimerRef.current = setTimeout(() => setConfirmDestroy(false), 3000);
      return;
    }
    clearTimeout(destroyTimerRef.current);
    socket?.emit('team:destroy', team.id);
    onClose?.();
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'completed': return '✓';
      case 'in_progress': return '●';
      case 'blocked': return '⊘';
      default: return '○';
    }
  };

  const getStatusClass = (status) => {
    switch (status) {
      case 'completed': return 'task-completed';
      case 'in_progress': return 'task-in-progress';
      case 'blocked': return 'task-blocked';
      default: return 'task-pending';
    }
  };

  const formatTime = (isoStr) => {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  return (
    <div className="team-panel">
      {/* 团队头部 */}
      <div className="team-panel-header">
        <div className="team-panel-title">{team.name}</div>
        <div className="team-panel-status">
          <span className={`team-status-badge ${team.status}`}>{team.status}</span>
        </div>
      </div>

      {/* 进度条 */}
      <div className="team-progress">
        <div className="team-progress-bar">
          <div className="team-progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="team-progress-text">
          {stats.completed}/{stats.total} 任务完成 ({progress}%)
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="team-panel-tabs" role="tablist">
        <button
          className={`team-tab ${activeTab === 'tasks' ? 'active' : ''}`}
          onClick={() => setActiveTab('tasks')}
          role="tab"
          aria-selected={activeTab === 'tasks'}
          aria-controls="team-tab-tasks"
        >
          任务 ({stats.total})
        </button>
        <button
          className={`team-tab ${activeTab === 'messages' ? 'active' : ''}`}
          onClick={() => setActiveTab('messages')}
          role="tab"
          aria-selected={activeTab === 'messages'}
          aria-controls="team-tab-messages"
        >
          消息 ({messages.length})
        </button>
      </div>

      {/* 内容区 */}
      <div className="team-panel-content">
        {activeTab === 'tasks' && (
          <div className="team-tasks-list" id="team-tab-tasks" role="tabpanel">
            {tasks.map(task => (
              <div key={task.id} className={`team-task-item ${getStatusClass(task.status)}`}>
                <span className="task-status-icon">{getStatusIcon(task.status)}</span>
                <div className="task-info">
                  <div className="task-subject">{task.subject}</div>
                  {task.assigneeSessionId && (
                    <div className="task-assignee">
                      {task.assigneeSessionId.slice(0, 8)}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {tasks.length === 0 && (
              <div className="team-empty">暂无任务</div>
            )}
            {/* 添加任务 */}
            <div className="team-add-task">
              <input
                type="text"
                value={newTaskSubject}
                onChange={(e) => setNewTaskSubject(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddTask()}
                placeholder="添加新任务..."
                className="team-task-input"
                aria-label="添加新任务"
              />
            </div>
          </div>
        )}

        {activeTab === 'messages' && (
          <div className="team-messages-list" id="team-tab-messages" role="tabpanel">
            {messages.map(msg => (
              <div key={msg.id} className={`team-message-item ${msg.type}`}>
                <span className="msg-time">{formatTime(msg.createdAt)}</span>
                <span className="msg-content">{msg.content}</span>
              </div>
            ))}
            {messages.length === 0 && (
              <div className="team-empty">暂无消息</div>
            )}
          </div>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="team-panel-actions">
        {team.status === 'active' ? (
          <button className="team-action-btn pause" onClick={handlePause}>暂停</button>
        ) : team.status === 'paused' ? (
          <button className="team-action-btn resume" onClick={handleResume}>恢复</button>
        ) : null}
        <button className={`team-action-btn destroy ${confirmDestroy ? 'confirming' : ''}`} onClick={handleDestroy}>
          {confirmDestroy ? '确认销毁？' : '销毁'}
        </button>
      </div>
    </div>
  );
}

export default TeamPanel;
