import React, { useEffect, useState, useCallback } from 'react';

// NSProcessInfo.thermalState 的四档
const THERMAL_NAMES = ['正常', '偏高', '严重', '危急'];

/**
 * 合盖保活开关（设置 → 高级）。借鉴 Amphetamine 的「合盖模式」与开源实现 Sleepless / LidAwake：
 * 有会话在跑或开着自动操作时切 `pmset disablesleep 1`，活停了、电量到下限、低电量模式就还原。
 * 首次使用需安装一次授权（Mac 上弹管理员密码框），只放行切换这一个设置的两条命令。
 */
export default function LidSleepCard() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    fetch('/api/lid-sleep').then((r) => (r.ok ? r.json() : null)).then(setSt).catch(() => setSt(null));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const post = async (url, body, label) => {
    setBusy(label); setMsg('');
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
      const d = await r.json();
      if (d.error) setMsg(d.error);
      setSt(d.status || d);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy('');
    }
  };

  if (!st || !st.supported) return null;   // 非 macOS 或远程无权限时不显示
  const ready = st.installed && st.watchdogReady;
  const win = st.platform === 'win32';
  const setFloor = (v) => post('/api/lid-sleep', { batteryFloor: Number(v) }, 'floor');

  return (
    <div className="lid-sleep-card">
      <div className="td-head">
        合盖不睡眠
        <span className={`ls-badge ${st.active ? 'on' : ''}`}>{st.active ? '生效中' : '未生效'}</span>
        {st.experimental && <span className="ls-badge exp">实验性</span>}
      </div>
      {win ? (
        <div className="td-empty">
          有会话在跑或开着自动操作时，把「合上盖子时」临时改成「不采取任何操作」，并阻止系统挂起后台；
          活干完或电量到下限就改回原来的设置。Windows 读不到温度，靠电脑自带的过热保护。请别放进包里闷着。
          <br />⚠ 尚未在 Windows 笔记本上实测。试用时合盖几分钟再打开，看下方「停顿记录」有没有新增。
        </div>
      ) : (
        <div className="td-empty">
          有会话在跑或开着自动操作时，合上盖子 Mac 也不睡，任务继续跑，可以用手机远程看。
          活干完、电量到下限、进入低电量模式或合盖温度过高时，自动恢复正常睡眠。合盖后会关掉内屏；请别放进包里闷着。
        </div>
      )}

      {!ready && (
        <div className="ls-row">
          <button type="button" className="td-revoke" disabled={!!busy}
            onClick={() => post('/api/lid-sleep/install', {}, 'install')}>
            {busy === 'install' ? '等待授权…' : '授权安装（需管理员密码）'}
          </button>
          <span className="td-hint">密码框弹在这台 Mac 的屏幕上，只需一次</span>
        </div>
      )}
      {!ready && st.manual?.length > 0 && (
        <details className="ls-manual">
          <summary>不在 Mac 前？在终端里执行这两条命令</summary>
          {st.manual.map((c) => <code key={c}>{c}</code>)}
        </details>
      )}

      {ready && (
        <>
          <label className="ls-row">
            <input type="checkbox" checked={st.enabled} disabled={!!busy}
              onChange={(e) => post('/api/lid-sleep', { enabled: e.target.checked }, 'toggle')} />
            <span>开启合盖不睡眠</span>
          </label>
          <label className="ls-row">
            <span>电池低于</span>
            <select value={st.batteryFloor} disabled={!!busy} onChange={(e) => setFloor(e.target.value)}>
              {[10, 15, 20, 30, 40, 50].map((v) => <option key={v} value={v}>{v}%</option>)}
            </select>
            <span>时恢复睡眠</span>
          </label>
          {!win && <label className="ls-row">
            <span>电池温度达到</span>
            <select value={st.tempLimit} disabled={!!busy}
              onChange={(e) => post('/api/lid-sleep', { tempLimit: Number(e.target.value) }, 'temp')}>
              {[40, 42, 45, 48, 50].map((v) => <option key={v} value={v}>{v}°C</option>)}
            </select>
            <span>或系统判定「过热」时恢复睡眠（仅合盖时）</span>
          </label>}
        </>
      )}

      <div className="td-meta">
        {st.reason}{st.onAC ? ' · 已接电源' : ` · 电池 ${st.percent ?? '?'}%`}
        {st.batteryTempC != null && ` · 电池 ${st.batteryTempC.toFixed(1)}°C`}
        {st.thermalState != null && ` · 热状态 ${THERMAL_NAMES[st.thermalState] || st.thermalState}`}
        {st.keepAwake > 0 && ` · 运行中 ${st.busy} / 自动操作 ${st.auto}`}
        {win && st.modernStandby != null && ` · ${st.modernStandby ? '现代待机机型' : '传统睡眠机型'}`}
      </div>
      {st.suspendEvents?.length > 0 && (
        <div className="td-meta">
          停顿记录（进程被挂起过）：{st.suspendEvents.map((e) =>
            `${new Date(e.at).toLocaleString()} 停了 ${e.gapSec} 秒${e.overrideWasOn ? '（合盖不睡开着）' : ''}`).join('；')}
        </div>
      )}
      {(msg || st.lastError) && <div className="ls-error">{msg || st.lastError}</div>}
      {ready && (
        <button type="button" className="ls-uninstall" disabled={!!busy}
          onClick={() => post('/api/lid-sleep/uninstall', {}, 'uninstall')}>{win ? '移除（还原设置并删除自启项）' : '移除授权'}</button>
      )}
    </div>
  );
}
