// Service Worker for RSI Watch PWA
const CACHE_NAME = 'rsi-watch-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

// 네트워크 우선, 실패 시 캐시
self.addEventListener('fetch', e => {
  if (e.request.url.includes('finance.yahoo') || e.request.url.includes('allorigins') || e.request.url.includes('corsproxy')) {
    e.respondWith(fetch(e.request).catch(() => new Response('{}', {headers:{'Content-Type':'application/json'}})));
    return;
  }
  e.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      fetch(e.request).then(res => { cache.put(e.request, res.clone()); return res; })
        .catch(() => caches.match(e.request))
    )
  );
});
