import { useState, useEffect } from 'react';
import { socket } from './socket';

/**
 * 会话列表 + AI 状态 + 内存监控 hook。
 * 数据源全部为服务端全局广播事件，断线重连后自动重拉。
 */
export function useSessions() {
  const [sessions, setSessions] = useState([]);
  const [aiStatusMap, setAiStatusMap] = useState({});   // sessionId -> ai:status 载荷
  const [loadingMap, setLoadingMap] = useState({});     // sessionId -> bool
  const [memoryMap, setMemoryMap] = useState({});       // sessionId -> {memory, processCount}
  const [loaded, setLoaded] = useState(false);
  // 置顶与排序模式来自**服务端**（不是本机 localStorage）——
  // 手机与电脑因此看到同一个顺序，一端改了另一端跟着变
  const [prefs, setPrefs] = useState({ pinnedSessions: [], sessionSort: 'fixed' });

  useEffect(() => {
    const handleList = (data) => {
      if (Array.isArray(data)) {
        setSessions(data);
        setLoaded(true);
      }
    };
    const handleAiStatus = (status) => {
      if (!status?.sessionId) return;
      setAiStatusMap((prev) => ({ ...prev, [status.sessionId]: status }));
      setLoadingMap((prev) => ({ ...prev, [status.sessionId]: false }));
    };
    const handleLoading = ({ sessionId }) => {
      if (sessionId) setLoadingMap((prev) => ({ ...prev, [sessionId]: true }));
    };
    const handleMemory = (data) => {
      // sessions:memory 载荷: { [sessionId]: {memory, processCount} } 或数组
      if (data && typeof data === 'object') setMemoryMap(data);
    };
    const refresh = () => {
      socket.emit('sessions:list');
      socket.emit('ai:statusAll');  // 批量拉取缓存的 AI 状态（列表首屏）
    };

    socket.on('sessions:list', handleList);
    socket.on('sessions:updated', handleList);
    socket.on('ai:status', handleAiStatus);
    socket.on('ai:statusLoading', handleLoading);
    socket.on('sessions:memory', handleMemory);
    const handlePrefs = (payload) => { if (payload?.prefs) setPrefs(payload.prefs); };
    socket.on('ui:prefs', handlePrefs);
    socket.on('connect', refresh);

    refresh();

    return () => {
      socket.off('sessions:list', handleList);
      socket.off('sessions:updated', handleList);
      socket.off('ai:status', handleAiStatus);
      socket.off('ai:statusLoading', handleLoading);
      socket.off('sessions:memory', handleMemory);
      socket.off('ui:prefs', handlePrefs);
      socket.off('connect', refresh);
    };
  }, []);

  const refresh = () => {
    socket.emit('sessions:list');
    socket.emit('ai:statusAll');
    socket.emit('ui:prefs', {}, (r) => { if (r?.ok) setPrefs(r.prefs); });
  };

  /** 切排序模式：写服务端，广播回来后两端一起变 */
  const setSortMode = (mode) => {
    setPrefs((p) => ({ ...p, sessionSort: mode }));   // 乐观更新，手机上点了立刻有反应
    socket.emit('ui:prefs:set', { sessionSort: mode });
  };

  return { sessions, aiStatusMap, loadingMap, memoryMap, loaded, refresh, prefs, setSortMode };
}
