import React, { useState, useRef, useEffect } from 'react';
import { socket } from './socket';

/** 危险按钮第一次点后保持「待确认」多久。够人看清并再点一次，又不至于忘了它还挂着 */
const ARM_MS = 3000;

/**
 * 危险操作按钮：点一次变成「再点一次确认…」，3 秒内再点才执行。
 *
 * 为什么不用 window.confirm：主屏幕打开的网页（PWA）里原生确认框有时会被系统拦掉，
 * 那样按钮就成了"点了没反应"；两次点击在任何环境都成立。
 * 为什么手机上要确认而电脑上可以不：手机误触的代价是整轮长程停掉，而那时你不在电脑前。
 */
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled, className = '' }) {
  const [armed, setArmed] = useState(false);
  const t = useRef(null);
  useEffect(() => () => clearTimeout(t.current), []);
  const click = () => {
    if (!armed) {
      setArmed(true);
      clearTimeout(t.current);
      t.current = setTimeout(() => setArmed(false), ARM_MS);
      return;
    }
    clearTimeout(t.current);
    setArmed(false);
    onConfirm();
  };
  return (
    <button className={`m-btn ${armed ? 'danger' : ''} ${className}`} disabled={disabled} onClick={click}>
      {armed ? confirmLabel : label}
    </button>
  );
}

/** 运行中的长程操作：暂停/继续、停下当前这发、终止 */
export default function LongRunMobileActions({ task, onChanged }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const run = (event, payload, okText) => {
    setBusy(event); setMsg('');
    socket.emit(event, { taskId: task.id, ...payload }, (r) => {
      setBusy('');
      setMsg(r?.ok ? okText : `失败：${r?.error || '无响应'}`);
      onChanged?.();
    });
  };

  if (!task || task.state !== 'running') return null;
  const paused = !!task.pauseArmed;

  return (
    <div className="m-lr-actions">
      <button className="m-btn" disabled={!!busy}
        onClick={() => run('longrun:pause', { on: !paused }, paused ? '已继续' : '已暂停：当前这发跑完后停在派发口')}>
        {paused ? '▶ 继续' : '⏸ 暂停'}
      </button>
      {/* 停下 = 立即打断当前这发并暂停，可恢复；终止 = 整轮收工，不可恢复 */}
      <ConfirmButton label="停下当前这发" confirmLabel="再点一次：打断并暂停" disabled={!!busy}
        onConfirm={() => run('longrun:stop', {}, '已打断并暂停，点「继续」可接着跑')} />
      <ConfirmButton label="终止" confirmLabel="再点一次：整轮收工" disabled={!!busy} className="danger-text"
        onConfirm={() => run('longrun:terminate', {}, '已终止')} />
      {msg && <div className="m-lr-msg">{msg}</div>}
    </div>
  );
}
