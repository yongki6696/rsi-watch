/* 어디가지 — 서비스워커: 오프라인 캐시, 백그라운드 가격 확인, 알림 클릭 처리 */
importScripts('data.js', 'core.js', 'store.js');

var CACHE = 'eodigaji-v1';
var SHELL = ['./', 'index.html', 'app.js', 'core.js', 'data.js', 'store.js', 'manifest.json',
  'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('eodigaji-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// 앱 파일은 네트워크 우선(업데이트 바로 반영), 오프라인이면 캐시. 외부 API 요청은 건드리지 않습니다.
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(function (res) {
    if (res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (m) { return m || caches.match('index.html'); });
  }));
});

// 크롬에서 홈 화면에 설치한 경우, 브라우저가 적당한 때에 깨워줍니다 (최소 3시간 간격).
self.addEventListener('periodicsync', function (e) {
  if (e.tag === 'fav-check') e.waitUntil(backgroundCheck());
});

function backgroundCheck() {
  var Store = self.TravelStore, Core = self.TravelCore;
  return Promise.all([Store.get('settings'), Store.get('favorites')]).then(function (r) {
    var settings = r[0] || {}, favs = r[1] || [];
    if (!favs.length) return;
    return Core.checkFavorites(favs, Core.createProvider(settings), { minDrop: settings.minDrop || 1000 })
      .then(function (res) {
        // 확인하는 동안 앱에서 바뀐 내용을 덮어쓰지 않도록 다시 읽고 합칩니다.
        return Promise.all([Store.get('favorites'), Store.get('settings'), Store.get('alerts')]).then(function (cur) {
          var byId = {};
          res.favorites.forEach(function (f) { byId[f.id] = f; });
          var merged = (cur[0] || favs).map(function (f) {
            var u = byId[f.id];
            if (!u) return f;
            u.targetPrice = f.targetPrice;
            return u;
          });
          var s = cur[1] || settings;
          s.lastCheckAt = res.checkedAt;
          s.unseenAlerts = (s.unseenAlerts || 0) + res.alerts.length;
          return Promise.all([
            Store.set('favorites', merged),
            Store.set('settings', s),
            Store.set('alerts', res.alerts.concat(cur[2] || []).slice(0, 30))
          ]);
        }).then(function () {
          // 열려 있는 앱 화면에 먼저 알리고, 알림 권한이 없어 실패해도 나머지는 계속 진행
          var tellClients = self.clients.matchAll({ type: 'window' }).then(function (clients) {
            clients.forEach(function (c) { c.postMessage({ type: 'favorites-updated' }); });
          });
          var notifications = res.alerts.map(function (a) {
            return self.registration.showNotification(a.title, {
              body: a.body, tag: a.favId, icon: 'icon-192.png', data: { url: './#favorites' }
            }).catch(function () {});
          });
          return Promise.all([tellClients].concat(notifications));
        });
      });
  });
}

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var target = new URL((e.notification.data && e.notification.data.url) || './#favorites', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
    for (var i = 0; i < clients.length; i++) {
      if (clients[i].url.indexOf(self.registration.scope) === 0) {
        clients[i].postMessage({ type: 'open-favorites' });
        return clients[i].focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
