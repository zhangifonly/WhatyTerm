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
    socket.on('connect', refresh);

    refresh();

    return () => {
      socket.off('sessions:list', handleList);
      socket.off('sessions:updated', handleList);
      socket.off('ai:status', handleAiStatus);
      socket.off('ai:statusLoading', handleLoading);
      socket.off('sessions:memory', handleMemory);
      socket.off('connect', refresh);
    };
  }, []);

  const refresh = () => {
    socket.emit('sessions:list');
    socket.emit('ai:statusAll');
  };

  return { sessions, aiStatusMap, loadingMap, memoryMap, loaded, refresh };
}
