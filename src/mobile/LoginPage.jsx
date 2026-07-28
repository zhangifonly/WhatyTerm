import React, { useState, useRef, useEffect } from 'react';
import { requestScanLogin, pollScanLogin } from './api';

/** 移动版登录页：扫码免密（主推）+ 邮箱密码 */
export default function LoginPage({ auth }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState(null);        // {id, code}
  const [cooldown, setCooldown] = useState(0);   // 限频倒计时
  const pollTimer = useRef(null);
  const cdTimer = useRef(null);

  useEffect(() => () => {
    clearInterval(pollTimer.current);
    clearInterval(cdTimer.current);
  }, []);

  const startCooldown = (sec) => {
    setCooldown(sec);
    clearInterval(cdTimer.current);
    cdTimer.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) { clearInterval(cdTimer.current); return 0; }
        return c - 1;
      });
    }, 1000);
  };

  const startScan = async () => {
    setError('');
    const result = await requestScanLogin();
    if (result.error) {
      setError(result.error);
      startCooldown(20);
      return;
    }
    setScan(result);
    startCooldown(60);  // 服务端同 IP 每分钟限 3 次，主动降频
    clearInterval(pollTimer.current);
    pollTimer.current = setInterval(async () => {
      const st = await pollScanLogin(result.id);
      if (st === 'approved') {
        clearInterval(pollTimer.current);
        auth.checkAuth();
      } else if (st === 'denied' || st === 'expired') {
        clearInterval(pollTimer.current);
        setScan(null);
        setError(st === 'denied' ? '电脑端拒绝了本次登录' : '请求已过期，请重新发起');
      }
    }, 1500);
  };

  const cancelScan = () => {
    clearInterval(pollTimer.current);
    setScan(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const result = await auth.login(email, password);
    if (!result.success) setError(result.error || '登录失败');
    setBusy(false);
  };

  return (
    <div className="m-login">
      <h1>网梯终端</h1>
      <p className="m-login-sub">远程监控 · 移动版</p>
      {scan ? (
        <div className="m-scan-box">
          <div className="m-scan-tip">请在电脑上确认登录，核对确认码：</div>
          <div className="m-scan-code">{scan.code}</div>
          <div className="m-scan-wait">等待电脑端点击「允许登录」…</div>
          <button className="m-btn" onClick={cancelScan}>取消</button>
        </div>
      ) : (
        <button className="m-btn primary m-scan-btn" onClick={startScan} disabled={cooldown > 0}>
          {cooldown > 0 ? `免密登录（${cooldown}s）` : '🔓 免密登录（在电脑上确认）'}
        </button>
      )}
      {error && <div className="m-login-error">{error}</div>}
      <div className="m-login-divider">或使用账号登录</div>
      <form onSubmit={submit} className="m-login-form">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="邮箱" autoComplete="email" required />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder="密码" autoComplete="current-password" required />
        <button type="submit" className="m-btn" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
