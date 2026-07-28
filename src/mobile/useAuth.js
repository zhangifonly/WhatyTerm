import { useState, useEffect, useCallback } from 'react';
import { getAuthStatus, onlineLogin } from './api';
import { socket } from './socket';

/**
 * 移动版认证 hook（桌面版 useAuth 的子集）。
 * 本机访问或未启用认证 → 视为已认证；登录成功后重连 socket
 * （socket 握手时的 session cookie 才带上登录态）。
 */
export function useAuth() {
  const [status, setStatus] = useState({ loading: true, authenticated: false });

  const checkAuth = useCallback(async () => {
    const data = await getAuthStatus();
    setStatus({ loading: false, ...data });
    if (data?.authenticated && !socket.connected) {
      socket.connect();
    } else if (data?.authenticated) {
      // 已连接但可能是未认证时代的连接，重连以携带新 session
      socket.disconnect();
      socket.connect();
    }
    return data;
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  const login = useCallback(async (email, password) => {
    const result = await onlineLogin(email, password);
    if (result.success) await checkAuth();
    return result;
  }, [checkAuth]);

  return { ...status, checkAuth, login };
}
