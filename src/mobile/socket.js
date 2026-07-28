import { io } from 'socket.io-client';

// 移动版独立 socket 单例：同源连接自动携带 session cookie，
// 服务端 io.engine 复用 express-session 完成认证（远程需已登录）。
export const socket = io({ autoConnect: true });

// 连接状态集中管理：'connected' | 'disconnected' | 'unauthorized'
const listeners = new Set();
let state = socket.connected ? 'connected' : 'disconnected';

function setState(next) {
  if (state === next) return;
  state = next;
  listeners.forEach((cb) => cb(state));
}

socket.on('connect', () => setState('connected'));
socket.on('disconnect', () => setState('disconnected'));
socket.on('connect_error', (err) => {
  // 服务端 io.use 认证失败时 message 为「需要登录」
  if (err?.message === '需要登录') {
    setState('unauthorized');
  } else {
    setState('disconnected');
  }
});

/** 订阅连接状态变化，返回取消函数；立即回调一次当前状态 */
export function onConnectionChange(cb) {
  listeners.add(cb);
  cb(state);
  return () => listeners.delete(cb);
}

export function getConnectionState() {
  return state;
}
