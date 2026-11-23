/* 오더허브 서비스워커: 푸시 알림 수신 + 앱 화면 캐시 */
const CACHE = 'orderhub-shell-v4';
const SHELL = ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/badge-96.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => null)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 화면 파일: 네트워크 우선, 오프라인이면 캐시. API 는 절대 캐시하지 않음(개인정보).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (req.mode === 'navigate' || SHELL.includes(url.pathname))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req.mode === 'navigate' ? '/' : req).then((r) => r || caches.match('/')))
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: '오더허브', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || '오더허브';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/' },
    vibrate: [200, 100, 200],
    timestamp: data.ts || Date.now(),
  };
  const tasks = [self.registration.showNotification(title, options)];
  if (typeof data.badgeCount === 'number' && self.navigator && self.navigator.setAppBadge) {
    tasks.push(data.badgeCount > 0 ? self.navigator.setAppBadge(data.badgeCount) : self.navigator.clearAppBadge());
  }
  event.waitUntil(Promise.all(tasks).catch(() => null));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.startsWith(self.location.origin)) {
          client.postMessage({ type: 'open', url: target });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
