import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

/**
 * TeamView - 多终端网格视图
 * 为 Team 的每个成员创建独立的 xterm.js 实例，CSS Grid 布局
 */
function TeamView({ team, socket, onSessionClick }) {
  const containerRef = useRef(null);
  const terminalsRef = useRef({}); // sessionId -> { term, fitAddon, el }
  const [focusedSession, setFocusedSession] = useState(null);
  const [fullscreenSession, setFullscreenSession] = useState(null);

  // 所有成员 session ID（Lead + Members）
  const allSessionIds = team ? [team.leadSessionId, ...team.memberSessionIds] : [];

  // 计算网格布局
  const getGridLayout = useCallback((count) => {
    if (count <= 1) return { cols: 1, rows: 1 };
    if (count <= 2) return { cols: 2, rows: 1 };
    if (count <= 4) return { cols: 2, rows: 2 };
    if (count <= 6) return { cols: 3, rows: 2 };
    return { cols: 3, rows: 3 };
  }, []);

  // 初始化终端实例
  useEffect(() => {
    if (!team || !socket) return;

    // attach 到 team
    socket.emit('team:attach', team.id);

    // 为每个成员创建终端
    const timers = [];
    const dataDisposables = [];
    for (const sid of allSessionIds) {
      if (terminalsRef.current[sid]) continue;

      const el = document.getElementById(`team-term-${sid}`);
      if (!el) continue;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Monaco, Menlo, monospace',
        scrollback: 5000,
        allowProposedApi: true,
        macOptionClickForcesSelection: true,
        theme: {
          background: '#000000',
          foreground: '#eaeaea',
          cursor: '#e94560',
          selectionBackground: 'rgba(255, 255, 255, 0.3)'
        }
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(el);

      const timer = setTimeout(() => {
        try { fitAddon.fit(); } catch {}
      }, 100);
      timers.push(timer);

      // 键盘输入转发
      const disposable = term.onData((data) => {
        socket.emit('team:terminalInput', { sessionId: sid, input: data });
      });
      dataDisposables.push(disposable);

      terminalsRef.current[sid] = { term, fitAddon, el };
    }

    // 监听终端输出
    const handleOutput = ({ sessionId, data }) => {
      const entry = terminalsRef.current[sessionId];
      if (entry) {
        entry.term.write(data);
      }
    };
    socket.on('team:terminalOutput', handleOutput);

    return () => {
      socket.off('team:terminalOutput', handleOutput);
      socket.emit('team:detach');
      timers.forEach(t => clearTimeout(t));
      dataDisposables.forEach(d => { try { d.dispose(); } catch {} });
      // 销毁终端实例
      for (const sid of Object.keys(terminalsRef.current)) {
        try {
          terminalsRef.current[sid].term.dispose();
        } catch {}
      }
      terminalsRef.current = {};
    };
  }, [team?.id, socket]);

  // ResizeObserver 自动 fit
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver(() => {
      for (const entry of Object.values(terminalsRef.current)) {
        try { entry.fitAddon.fit(); } catch {}
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [team?.id]);

  // 全屏切换
  const toggleFullscreen = useCallback((sid) => {
    setFullscreenSession(prev => prev === sid ? null : sid);
    // 延迟 fit
    setTimeout(() => {
      const entry = terminalsRef.current[sid];
      if (entry) {
        try { entry.fitAddon.fit(); } catch {}
      }
    }, 100);
  }, []);

  // 聚焦 pane
  const handlePaneFocus = useCallback((sid) => {
    setFocusedSession(sid);
    const entry = terminalsRef.current[sid];
    if (entry) entry.term.focus();
  }, []);

  if (!team) return null;

  const layout = getGridLayout(allSessionIds.length);
  const gridStyle = fullscreenSession ? {
    gridTemplateColumns: '1fr',
    gridTemplateRows: '1fr'
  } : {
    gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
    gridTemplateRows: `repeat(${layout.rows}, 1fr)`
  };

  // 获取 session 角色标签
  const getRoleLabel = (sid) => {
    if (sid === team.leadSessionId) return 'Lead';
    const idx = team.memberSessionIds.indexOf(sid);
    return `Agent ${idx + 1}`;
  };

  const getRoleClass = (sid) => {
    return sid === team.leadSessionId ? 'lead' : 'member';
  };

  return (
    <div className="team-view" ref={containerRef}>
      <div className="team-terminals-grid" style={gridStyle}>
        {allSessionIds.map(sid => {
          if (fullscreenSession && fullscreenSession !== sid) return null;
          return (
            <div
              key={sid}
              className={`team-terminal-pane ${focusedSession === sid ? 'focused' : ''}`}
              onClick={() => handlePaneFocus(sid)}
              onDoubleClick={() => toggleFullscreen(sid)}
              onKeyDown={(e) => { if (e.key === 'Enter') handlePaneFocus(sid); }}
              role="button"
              tabIndex={0}
              aria-label={`${getRoleLabel(sid)} 终端`}
            >
              <div className="team-terminal-header">
                <span className={`role-badge ${getRoleClass(sid)}`}>
                  {getRoleLabel(sid)}
                </span>
                <span className="pane-session-name">{sid.slice(0, 8)}</span>
                {fullscreenSession === sid && (
                  <button
                    className="pane-exit-fullscreen"
                    onClick={(e) => { e.stopPropagation(); toggleFullscreen(sid); }}
                    title="退出全屏"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div className="team-terminal-body" id={`team-term-${sid}`} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default TeamView;
