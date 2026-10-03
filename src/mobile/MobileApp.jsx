import React, { useState, useEffect } from 'react';
import { onConnectionChange } from './socket';
import { useSessions } from './useSessions';
import SessionList from './SessionList';
import SessionDetail from './SessionDetail';
import ProjectPicker from './ProjectPicker';
import LoginPage from './LoginPage';
import { useAuth } from './useAuth';
import PushSettings from './PushSettings';
import { sessionFromUrl } from './deepLink';

// 视图状态机：list（会话列表）| projects（历史项目，点一下开工）| detail（会话详情）
export default function MobileApp() {
  const auth = useAuth();
  const [conn, setConn] = useState('disconnected');
  const [view, setView] = useState('list');
  const [currentId, setCurrentId] = useState(null);
  const sessionsData = useSessions();

  useEffect(() => onConnectionChange(setConn), []);

  // 点推送通知进来：冷启动带 ?session=；页面已开着时由 SW 发 open-url 消息
  useEffect(() => {
    const go = (href) => {
      const id = sessionFromUrl(href);
      if (!id) return;
      setCurrentId(id); setView('detail');
      // 去掉参数：否则之后刷新页面会一直跳回这个会话
      window.history.replaceState(null, '', window.location.pathname);
    };
    go(window.location.href);
    const onMsg = (e) => { if (e.data?.type === 'open-url') go(e.data.url); };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, []);

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
        {view !== 'list' && (
          <button className="m-btn m-back" aria-label="返回会话列表" onClick={() => { setView('list'); setCurrentId(null); }}>
            ←
          </button>
        )}
        <span className={`m-conn-dot ${conn}`} title={conn} />
        <span className="m-topbar-title">
          {view === 'detail'
            ? (currentSession?.projectName || currentSession?.name || '会话')
            : view === 'projects' ? '历史项目' : '网梯终端'}
        </span>
        {view === 'list' && <PushSettings />}
        {view === 'list' && <a className="m-desktop-link" href="/?desktop=1">桌面版</a>}
      </header>
      <main className="m-content">
        {view !== 'detail' && (
          <div className="m-switch" role="tablist" aria-label="切换会话与历史项目">
            <button role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
              会话 {sessionsData.sessions.length || ''}
            </button>
            <button role="tab" aria-selected={view === 'projects'} className={view === 'projects' ? 'active' : ''} onClick={() => setView('projects')}>
              历史项目
            </button>
          </div>
        )}
        {view === 'projects' && (
          <ProjectPicker sessions={sessionsData.sessions} onOpen={(id) => { setCurrentId(id); setView('detail'); }} />
        )}
        {view === 'list' && (
          <SessionList
            {...sessionsData}
            onOpen={(id) => { setCurrentId(id); setView('detail'); }}
          />
        )}
        {/* 点通知冷启动时列表还没到：先说"加载中"，别闪一下「会话不存在」 */}
        {view === 'detail' && !sessionsData.loaded && <div className="m-empty">加载中…</div>}
        {view === 'detail' && sessionsData.loaded && (
          <SessionDetail
            session={currentSession}
            aiStatus={sessionsData.aiStatusMap[currentId]}
            loading={sessionsData.loadingMap[currentId]}
            longRunTasks={sessionsData.longRunTasks}
          />
        )}
      </main>
    </div>
  );
}
