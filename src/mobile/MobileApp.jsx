import React, { useState, useEffect } from 'react';
import { onConnectionChange } from './socket';
import { useSessions } from './useSessions';
import SessionList from './SessionList';
import SessionDetail from './SessionDetail';
import LoginPage from './LoginPage';
import { useAuth } from './useAuth';

// 视图状态机：list（会话列表）| detail（会话详情，M3 接入）
export default function MobileApp() {
  const auth = useAuth();
  const [conn, setConn] = useState('disconnected');
  const [view, setView] = useState('list');
  const [currentId, setCurrentId] = useState(null);
  const sessionsData = useSessions();

  useEffect(() => onConnectionChange(setConn), []);

  // socket 层报「需要登录」（session 过期）时刷新认证状态，回到登录页
  useEffect(() => {
    if (conn === 'unauthorized') auth.checkAuth();
  }, [conn]);

  const currentSession = sessionsData.sessions.find((s) => s.id === currentId);

  if (auth.loading) {
    return <div className="m-app"><div className="m-empty">加载中…</div></div>;
  }
  if (!auth.authenticated) {
    return <div className="m-app"><LoginPage auth={auth} /></div>;
  }

  return (
    <div className="m-app">
      <header className="m-topbar">
        {view === 'detail' && (
          <button className="m-btn m-back" onClick={() => { setView('list'); setCurrentId(null); }}>
            ←
          </button>
        )}
        <span className={`m-conn-dot ${conn}`} title={conn} />
        <span className="m-topbar-title">
          {view === 'detail'
            ? (currentSession?.projectName || currentSession?.name || '会话')
            : '网梯终端'}
        </span>
        {view === 'list' && <a className="m-desktop-link" href="/?desktop=1">桌面版</a>}
      </header>
      <main className="m-content">
        {view === 'list' && (
          <SessionList
            {...sessionsData}
            onOpen={(id) => { setCurrentId(id); setView('detail'); }}
          />
        )}
        {view === 'detail' && (
          <SessionDetail
            session={currentSession}
            aiStatus={sessionsData.aiStatusMap[currentId]}
            loading={sessionsData.loadingMap[currentId]}
          />
        )}
      </main>
    </div>
  );
}
