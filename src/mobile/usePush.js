import { useState, useEffect, useCallback } from 'react';

const SW_URL = '/m-sw.js';
const SW_SCOPE = '/m/';

/** VAPID 公钥（base64url）→ Uint8Array，pushManager.subscribe 只收这种 */
export function keyToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body) }).then((r) => r.json());

/**
 * 当前环境能不能开推送。iOS 上**只有从主屏幕图标打开**时才有推送（Safari 标签页里 PushManager 不存在），
 * 这一条必须明说，否则用户只看到"不支持"，不知道加到主屏幕就行。
 */
export function pushSupport(w = globalThis) {
  const nav = w.navigator || {};
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent || '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const standalone = nav.standalone === true || w.matchMedia?.('(display-mode: standalone)').matches;
  if ('serviceWorker' in nav && 'PushManager' in w && 'Notification' in w) return 'ok';
  if (ios && !standalone) return 'needs-homescreen';
  return 'unsupported';
}

/**
 * 手机推送开关。status: unsupported | needs-homescreen | denied | off | on
 * ⚠ 开启时必须先 requestPermission 再做别的：iOS 只认用户点击同步触发的权限请求。
 */
export function usePush() {
  const support = pushSupport();
  const [status, setStatus] = useState(support === 'ok' ? 'off' : support);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const currentSub = async () => {
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    return { reg, sub: reg ? await reg.pushManager.getSubscription() : null };
  };

  // 进来就注册 SW（点通知跳转要靠它），并以服务端为准核对订阅：服务端清掉的失效订阅不能还显示"已开启"
  useEffect(() => {
    if (support !== 'ok') return;
    navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }).catch(() => {});
    if (Notification.permission === 'denied') { setStatus('denied'); return; }
    currentSub().then(async ({ sub }) => {
      if (!sub) return;
      const r = await post('/api/push/status', { endpoint: sub.endpoint }).catch(() => null);
      setStatus(r?.subscribed ? 'on' : 'off');
    }).catch(() => {});
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const enable = useCallback(async () => {
    setBusy(true); setMsg('');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setStatus(perm === 'denied' ? 'denied' : 'off'); return; }
      const reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
      await navigator.serviceWorker.ready;
      const k = await fetch('/api/push/key').then((r) => r.json());
      if (!k?.ok) throw new Error(k?.error || '取不到推送公钥');
      const opts = { userVisibleOnly: true, applicationServerKey: keyToBytes(k.publicKey) };
      let sub;
      try { sub = await reg.pushManager.subscribe(opts); }
      catch {
        // 旧订阅用的是另一把公钥（电脑上的密钥重新生成过）：退掉旧的再订
        await (await reg.pushManager.getSubscription())?.unsubscribe();
        sub = await reg.pushManager.subscribe(opts);
      }
      const r = await post('/api/push/subscribe', { subscription: sub.toJSON() });
      if (!r?.ok) throw new Error(r?.error || '服务端没收下订阅');
      setStatus('on'); setMsg('已开启。点「发一条测试」确认这台手机能收到');
    } catch (e) { setMsg(`开启失败：${e.message || e}`); }
    finally { setBusy(false); }
  }, []);

  const disable = useCallback(async () => {
    setBusy(true); setMsg('');
    try {
      const { sub } = await currentSub();
      if (sub) { await post('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      setStatus('off'); setMsg('已关闭提醒');
    } catch (e) { setMsg(`关闭失败：${e.message || e}`); }
    finally { setBusy(false); }
  }, []);

  const test = useCallback(async () => {
    setBusy(true); setMsg('');
    try {
      const { sub } = await currentSub();
      const r = sub ? await post('/api/push/test', { endpoint: sub.endpoint }) : { error: '这台设备还没开启提醒' };
      setMsg(r?.ok ? '已发出，几秒内应弹出通知' : `没发出去：${r?.error || '未知原因'}`);
      if (!r?.ok && r?.removed) setStatus('off');
    } catch (e) { setMsg(`发送失败：${e.message || e}`); }
    finally { setBusy(false); }
  }, []);

  return { status, busy, msg, enable, disable, test };
}
