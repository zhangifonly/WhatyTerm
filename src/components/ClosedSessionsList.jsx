import React, { useState, useEffect } from 'react';
import { useTranslation } from '../i18n';
import './ClosedSessionsList.css';

const ClosedSessionsList = ({ socket, onRestore, compact = false }) => {
  const { t } = useTranslation();
  const [closedSessions, setClosedSessions] = useState([]);

  useEffect(() => {
    if (!socket) return;

    // 获取关闭的会话列表
    socket.emit('closedSessions:get');

    // 监听列表更新
    const handleList = (sessions) => {
      setClosedSessions(sessions);
    };

    const handleUpdated = (sessions) => {
      setClosedSessions(sessions);
    };

    const handleRestored = (session) => {
      if (onRestore) {
        onRestore(session);
      }
    };

    const handleRestoreError = (data) => {
      if (data.expired) {
        alert(t('closedSessions.sessionExpired'));
      } else {
        alert(t('closedSessions.restoreFailed') + ': ' + data.error);
      }
    };

    socket.on('closedSessions:list', handleList);
    socket.on('closedSessions:updated', handleUpdated);
    socket.on('session:restored', handleRestored);
    socket.on('session:restoreError', handleRestoreError);

    return () => {
      socket.off('closedSessions:list', handleList);
      socket.off('closedSessions:updated', handleUpdated);
      socket.off('session:restored', handleRestored);
      socket.off('session:restoreError', handleRestoreError);
    };
  }, [socket, onRestore, t]);

  const handleRestore = (sessionId) => {
    socket.emit('session:restore', sessionId);
  };

  const handleDelete = (e, sessionId) => {
    e.stopPropagation();
    if (confirm(t('closedSessions.confirmDelete'))) {
      socket.emit('closedSession:delete', sessionId);
    }
  };

  const formatTimeAgo = (timestamp) => {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);

    if (minutes < 1) return t('closedSessions.timeAgo.justNow');
    if (minutes < 60) return t('closedSessions.timeAgo.minutes', { count: minutes });
    if (hours < 24) return t('closedSessions.timeAgo.hours', { count: hours });
    return t('closedSessions.timeAgo.days', { count: Math.floor(hours / 24) });
  };

  if (closedSessions.length === 0) {
    return null;
  }

  // Compact 模式：VS Code 风格简洁列表
  if (compact) {
    return (
      <div className="closed-sessions compact">
        <ul className="compact-list">
          {closedSessions.slice(0, 5).map((session) => (
            <li
              key={session.id}
              className="compact-item"
              onClick={() => handleRestore(session.id)}
            >
              <span className="compact-name">{session.projectName || session.name}</span>
              <span className="compact-path">{session.projectDesc || session.goal || ''}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // 完整模式
  return (
    <div className="closed-sessions">
      <div className="closed-sessions-header">
        <h3>
          📋 {t('closedSessions.title')}
          <span className="count">{closedSessions.length}</span>
        </h3>
      </div>

      <div className="closed-sessions-list">
        {closedSessions.map((session) => (
          <div
            key={session.id}
            className="closed-session-card"
            onClick={() => handleRestore(session.id)}
          >
            <div className="closed-session-info">
              <div className="closed-session-name">
                <span className="name">{session.projectName || session.name}</span>
                <span className={`ai-type ${session.aiType}`}>{session.aiType}</span>
              </div>
              {(session.projectDesc || session.goal) && (
                <div className="closed-session-goal">
                  {(session.projectDesc || session.goal).slice(0, 60)}
                  {(session.projectDesc || session.goal).length > 60 ? '...' : ''}
                </div>
              )}
              <div className="closed-session-time">
                🕐 {formatTimeAgo(session.closedAt)}
              </div>
            </div>
            <div className="closed-session-actions">
              <button
                className="btn-restore"
                onClick={(e) => { e.stopPropagation(); handleRestore(session.id); }}
              >
                {t('closedSessions.restore')}
              </button>
              <button
                className="btn-delete-closed"
                onClick={(e) => handleDelete(e, session.id)}
              >
                {t('closedSessions.delete')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ClosedSessionsList;
