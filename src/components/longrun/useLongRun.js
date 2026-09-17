import { useState, useEffect, useRef, useCallback } from 'react';
import { applyEvent, normalizeSnapshot } from './longrunBoard.js';

/**
 * 长程任务的前端状态：列表（运行中的任务 + 可回放的历史沙箱）、当前打开的看板、响铃。
 *
 * 看板数据流与原版一致：打开时取快照，之后收增量。快照带 seq，丢弃 ≤ 它的增量（订阅与推送的交界处去重）。
 * 断线重连后重新订阅当前任务 —— socket.io 重连不会自动回到房间。
 */
export function useLongRun(socket) {
  const [tasks, setTasks] = useState([]);
  const [sandboxes, setSandboxes] = useState([]);
  const [view, setView] = useState(null);            // {kind:'task', id} | {kind:'replay', sandboxName}
  const [board, setBoard] = useState(null);
  const [meta, setMeta] = useState({});              // {task, notices, file, error, loading}
  const [muted, setMuted] = useState(false);
  const seqRef = useRef(0);
  const viewRef = useRef(null);

  /**
   * socket 请求。带超时：服务端没有这个接口（进程还在跑旧代码）或断线时回调永远不来，
   * 不设超时按钮会一直卡在"处理中"。解析大会话记录要几秒，给足 30 秒。
   */
  const call = useCallback((event, payload = {}) => new Promise((resolve) => {
    if (!socket) { resolve({ ok: false, error: '未连接' }); return; }
    const timer = setTimeout(() => resolve({ ok: false, error: `服务端无响应（${event}）：可能断线，或服务端还在跑旧代码需要重启` }), 30000);
    socket.emit(event, payload, (r) => { clearTimeout(timer); resolve(r || { ok: false, error: '无响应' }); });
  }), [socket]);

  const refreshLists = useCallback(async () => {
    const [st, sb] = await Promise.all([call('longrun:status', {}), call('longrun:sandboxes', {})]);
    if (st?.ok) setTasks(Array.isArray(st.task) ? st.task : []);
    if (sb?.ok) setSandboxes(sb.sandboxes || []);
  }, [call]);

  /** 打开一个任务或一轮历史回放 */
  const open = useCallback(async (next) => {
    viewRef.current = next;
    setView(next);
    setBoard(null);
    setMeta({ loading: true });
    if (!next) return;
    if (next.kind === 'task') {
      const r = await call('longrun:subscribe', { taskId: next.id });
      if (viewRef.current !== next) return;
      if (!r.ok) { setMeta({ error: r.error }); return; }
      seqRef.current = r.seq;
      setBoard(normalizeSnapshot(r.snapshot));
      setMeta({ task: r.task });
    } else {
      const r = await call('longrun:replay', { sandboxName: next.sandboxName });
      if (viewRef.current !== next) return;
      if (!r.ok) { setMeta({ error: r.error }); return; }
      if (r.live && r.taskId) { open({ kind: 'task', id: r.taskId }); return; }   // 内存里有，直接看实时的
      setBoard(normalizeSnapshot(r.snapshot));
      setMeta({ notices: r.notices, file: r.file, count: r.count, spanMinutes: r.spanMinutes });
    }
  }, [call]);

  useEffect(() => {
    if (!socket) return undefined;
    const onEvent = (ev) => {
      const v = viewRef.current;
      if (!v || v.kind !== 'task' || ev.taskId !== v.id || ev.seq <= seqRef.current) return;
      seqRef.current = ev.seq;
      setBoard((s) => applyEvent(s, ev));
    };
    const onTask = (t) => {
      setTasks((prev) => [...prev.filter((x) => x.id !== t.id), t]);
      if (viewRef.current?.kind === 'task' && viewRef.current.id === t.id) setMeta((m) => ({ ...m, task: t }));
      if (t.state !== 'running') call('longrun:sandboxes', {}).then((sb) => sb?.ok && setSandboxes(sb.sandboxes || []));
    };
    const onConnect = () => { refreshLists(); if (viewRef.current) open(viewRef.current); };
    socket.on('longrun:event', onEvent);
    socket.on('longrun:task', onTask);
    socket.on('connect', onConnect);
    refreshLists();
    return () => { socket.off('longrun:event', onEvent); socket.off('longrun:task', onTask); socket.off('connect', onConnect); };
  }, [socket, refreshLists, open, call]);

  // 耗时本地走秒，不为它推事件；回放与已停机不走
  useEffect(() => {
    const timer = setInterval(() => {
      setBoard((s) => (s && !s.finished && !s.replay ? { ...s, elapsed_s: (s.elapsed_s || 0) + 1 } : s));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const close = useCallback(() => { viewRef.current = null; setView(null); setBoard(null); setMeta({}); }, []);

  return { tasks, sandboxes, view, board, meta, muted, setMuted, open, close, call, refreshLists };
}
