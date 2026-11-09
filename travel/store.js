/*
 * 어디가지 — 아주 작은 IndexedDB 키-값 저장소
 * 서비스워커도 즐겨찾기를 읽어야 해서 localStorage 대신 IndexedDB를 씁니다.
 * IndexedDB를 못 쓰는 환경(사생활 보호 모드 등)에서는 메모리로 대신합니다.
 */
(function (root) {
  'use strict';
  var DB_NAME = 'eodigaji';
  var STORE = 'kv';
  var memory = {};
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') return reject(new Error('no-indexeddb'));
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    }).catch(function (err) { dbPromise = null; throw err; });
    return dbPromise;
  }

  function run(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var req = fn(tx.objectStore(STORE));
        tx.oncomplete = function () { resolve(req && req.result); };
        tx.onerror = tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  root.TravelStore = {
    get: function (key) {
      return run('readonly', function (s) { return s.get(key); })
        .catch(function () { return clone(memory[key]); });
    },
    set: function (key, value) {
      memory[key] = clone(value);
      return run('readwrite', function (s) { return s.put(value, key); }).catch(function () {});
    },
    clear: function () {
      memory = {};
      return run('readwrite', function (s) { return s.clear(); }).catch(function () {});
    }
  };
})(typeof self !== 'undefined' ? self : this);
