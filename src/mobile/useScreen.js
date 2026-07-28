import { useState, useEffect, useRef } from 'react';
import { socket } from './socket';

const THROTTLE_MS = 1500;

/**
 * 详情页屏幕快照 hook（移动版核心）：
 * - lite attach 拿首屏 screenContent（跳过 100KB 滚动历史）
 * - terminal:output 只当"屏幕变脏"信号，节流后向后端要一次 capturePane 快照
 * - 绝不 emit terminal:resize（避免挤窄桌面端 pty）
 * - 锁屏/切后台暂停，恢复时重新 attach
 */
export function useScreen(sessionId) {
  const [screen, setScreen] = useState('');
  const [attached, setAttached] = useState(false);
  const dirtyRef = useRef(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!sessionId) return;

    const attach = () => socket.emit('session:attach', { sessionId, lite: true });

    const requestScreen = () => {
      dirtyRef.current = false;
      socket.emit('session:screen', sessionId);
    };

    const handleAttached = (data) => {
      if (data?.session?.id !== sessionId) return;
      setScreen(data.screenContent || data.fullContent || '');
      setAttached(true);
    };

    const handleScreen = (data) => {
      if (data?.sessionId !== sessionId) return;
      setScreen(data.screenContent || '');
    };

    const handleOutput = (data) => {
      if (data?.sessionId !== sessionId) return;
      // 脏标记 + 节流：THROTTLE_MS 内多次输出只请求一次快照
      if (timerRef.current) {
        dirtyRef.current = true;
        return;
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (dirtyRef.current) handleOutput(data);  // 期间又变脏，再排一轮
      }, THROTTLE_MS);
      requestScreen();
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') attach();  // 回前台重新 attach + 刷屏
    };

    socket.on('session:attached', handleAttached);
    socket.on('session:screen', handleScreen);
    socket.on('terminal:output', handleOutput);
    socket.on('connect', attach);  // 断线重连自愈
    document.addEventListener('visibilitychange', handleVisibility);

    attach();

    return () => {
      socket.off('session:attached', handleAttached);
      socket.off('session:screen', handleScreen);
      socket.off('terminal:output', handleOutput);
      socket.off('connect', attach);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (timerRef.current) clearTimeout(timerRef.current);
      setAttached(false);
      // 后端在该 socket 下次 attach 其他会话时自动 detach，无需显式事件
    };
  }, [sessionId]);

  return { screen, attached };
}
