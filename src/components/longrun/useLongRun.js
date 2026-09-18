import { useState, useEffect, useRef, useCallback } from 'react';
import { applyEvent, normalizeSnapshot } from './longrunBoard.js';

/**
 * 长程任务的前端状态：任务摘要（列表徽标用）、跑过长程的项目、当前打开的看板、响铃。
 *
 * 长程是会话条目的一种运行模式：选中长程模式的条目时 openForSession(条目 id) ——
 * 该条目有任务就订阅实时看板，没有（服务重启后）就按条目工作目录回放上一轮。
 *
 * 看板数据流与原版一致：打开时取快照，之后收增量。快照带 seq，丢弃 ≤ 它的增量（订阅与推送的交界处去重）。
 * 断线重连后重新订阅当前任务 —— socket.io 重连不会自动回到房间。
 */
export function useLongRun(socket) {
  const [tasks, setTasks] = useState([]);
  const [sandboxes, setSandboxes] = useState([]);
  const [view, setView] = useState(null);            // {kind:'task', id, sessionId} | {kind:'replay', sessionId}
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

  /** 订阅一个任务的实时看板（{kind:'task', id, sessionId}）。回放走 openForSession */
  const open = useCallback(async (next) => {
    viewRef.current = next;
    setView(next);
    setBoard(null);
    setMeta({ loading: true });
    if (!next) return;
    const r = await call('longrun:subscribe', { taskId: next.id });
    if (viewRef.current !== next) return;
    if (!r.ok) { setMeta({ error: r.error }); return; }
    seqRef.current = r.seq;
    setBoard(normalizeSnapshot(r.snapshot));
    setMeta({ task: r.task });
  }, [call]);

  /** 按会话条目打开：有任务订阅实时看板，没有就回放该条目工作目录的上一轮 */
  const openForSession = useCallback(async (sessionId) => {
    const pending = { kind: 'pending', sessionId };
    viewRef.current = pending;
    setView(pending);
    setBoard(null);
    setMeta({ loading: true });
    const r = await call('longrun:forSession', { sessionId });
    if (viewRef.current !== pending) return;
    if (r.taskId) { open({ kind: 'task', id: r.taskId, sessionId }); return; }
    const next = { kind: 'replay', sessionId };
    viewRef.current = next;
    setView(next);
    if (!r.ok) { setMeta({ error: r.error, projectRoot: r.projectRoot }); return; }
    setBoard(normalizeSnapshot(r.snapshot));
    // report：服务重启后内存里没有任务了，结论卡的成果摘要只能靠回放读回来的 report.json
    setMeta({ notices: r.notices, file: r.file, count: r.count, spanMinutes: r.spanMinutes, projectRoot: r.projectRoot, report: r.report });
  }, [call, open]);


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
      const v = viewRef.current;
      if (v?.kind === 'task' && v.id === t.id) setMeta((m) => ({ ...m, task: t }));
      // 正在看的条目上起了新一轮（续跑、接管）：切到新任务
      else if (v?.sessionId && t.sessionId === v.sessionId && t.state === 'running' && v.id !== t.id) {
        open({ kind: 'task', id: t.id, sessionId: t.sessionId });
      }
      if (t.state !== 'running') call('longrun:sandboxes', {}).then((sb) => sb?.ok && setSandboxes(sb.sandboxes || []));
    };
    const onConnect = () => {
      refreshLists();
      const v = viewRef.current;
      if (v?.sessionId) openForSession(v.sessionId);
      else if (v) open(v);
    };
    socket.on('longrun:event', onEvent);
    socket.on('longrun:task', onTask);
    socket.on('connect', onConnect);
    refreshLists();
    return () => { socket.off('longrun:event', onEvent); socket.off('longrun:task', onTask); socket.off('connect', onConnect); };
  }, [socket, refreshLists, open, openForSession, call]);

  // 耗时本地走秒，不为它推事件；回放与已停机不走
  useEffect(() => {
    const timer = setInterval(() => {
      setBoard((s) => (s && !s.finished && !s.replay ? { ...s, elapsed_s: (s.elapsed_s || 0) + 1 } : s));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const close = useCallback(() => { viewRef.current = null; setView(null); setBoard(null); setMeta({}); }, []);

  /** 某个会话条目最近一次任务的摘要（列表徽标用） */
  const taskForSession = useCallback((sessionId) => tasks.filter((t) => t.sessionId === sessionId)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] || null, [tasks]);

  return { tasks, sandboxes, view, board, meta, muted, setMuted, open, openForSession, close, call, refreshLists, taskForSession };
}
