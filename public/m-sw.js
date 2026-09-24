/**
 * 移动版 Service Worker：只做推送，**不做离线缓存**。
 *
 * 为什么不缓存：这是连着本机服务的实时监控页，缓存了就会在手机上长期跑旧版前端，
 * 升级后界面与服务端对不上，还查不出来。推送是唯一需要 SW 的理由。
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data?.text?.() || '' }; }
  // iOS 要求每条推送都必须弹出通知，否则多次后会被系统收回推送权限 —— 所以这里无条件 showNotification
  event.waitUntil(self.registration.showNotification(d.title || '网梯终端', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,          // 同 tag 的新通知替换旧的但仍要响一下（又在等你了）
    icon: '/favicon.png',
    badge: '/favicon.png',
    data: { url: d.url || '/m/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/m/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 已经开着移动版：切过去并让它自己打开对应会话，不另开一个页面
    const open = wins.find((w) => new URL(w.url).pathname.startsWith('/m'));
    if (open) {
      await open.focus();
      open.postMessage({ type: 'open-url', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
