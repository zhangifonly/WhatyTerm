import React, { useEffect, useState, useCallback } from 'react';

const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
};
const left = (ms) => {
  const d = Math.ceil((ms - Date.now()) / 86400000);
  return d <= 1 ? '今天到期' : `${d} 天后到期`;
};

/**
 * 已授权登录的远程设备（二维码面板下方）。每台设备登录后 30 天内免登录，到期需重新登录；
 * 在这里点「退出」立即失效，它开着的页面会被断开并要求重新登录。只有本机能看到和操作。
 */
export default function TrustedDevices({ socket }) {
  const [devices, setDevices] = useState(null);
  const [busy, setBusy] = useState('');
  const [confirmId, setConfirmId] = useState('');

  const load = useCallback(() => {
    fetch('/api/auth/devices').then((r) => (r.ok ? r.json() : { devices: null }))
      .then((d) => setDevices(d.devices)).catch(() => setDevices(null));
  }, []);

  useEffect(() => {
    load();
    socket?.on('devices:changed', load);
    return () => socket?.off('devices:changed', load);
  }, [socket, load]);

  const revoke = async (id) => {
    // 两次点击确认：第一次按钮变成「确认退出」，3 秒内再点才执行
    if (confirmId !== id) { setConfirmId(id); setTimeout(() => setConfirmId((c) => (c === id ? '' : c)), 3000); return; }
    setBusy(id); setConfirmId('');
    try { await fetch(`/api/auth/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST' }); } finally { setBusy(''); load(); }
  };

  if (devices === null) return null;   // 远程打开的桌面版看不到（接口只对本机开放）
  return (
    <div className="trusted-devices">
      <div className="td-head">已授权的移动设备 <span className="td-hint">登录后 30 天内免登录</span></div>
      {devices.length === 0 && <div className="td-empty">还没有设备登录过。手机扫上面的码即可登录。</div>}
      {devices.map((d) => (
        <div key={d.id} className="td-row">
          <div className="td-info">
            <div className="td-name">{d.name}<span className="td-method">{d.method}</span></div>
            <div className="td-meta">{ago(d.lastSeenAt)}使用 · {d.lastIp || d.ip} · {left(d.expiresAt)}</div>
          </div>
          <button type="button" className={`td-revoke ${confirmId === d.id ? 'armed' : ''}`} disabled={busy === d.id}
            onClick={() => revoke(d.id)} title="立即让这台设备退出登录">
            {busy === d.id ? '…' : confirmId === d.id ? '确认退出' : '退出'}
          </button>
        </div>
      ))}
    </div>
  );
}
