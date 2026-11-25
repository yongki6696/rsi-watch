// 서비스 워커: 푸시 알림을 받아 보여주고, 누르면 앱의 해당 화면을 연다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: '가격 알림', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '가격 알림', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: Boolean(d.tag),
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // 알림을 누르면 쿠팡이 아니라 이 앱의 상세 화면으로 간다 (사용자가 직접 "쿠팡에서 보기"를 눌러야 이동)
  const target = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if (new URL(c.url).origin !== self.location.origin) continue;
      await c.focus();
      c.postMessage({ type: 'open', url: target.pathname + target.hash });
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
