'use strict';
// 웹푸시: VAPID 키 보관 + 실제 브라우저처럼 암호문을 복호화해서 내용 검증
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webpush = require('web-push');
const ece = require('http_ece');
const { Db } = require('../src/db');
const { Secrets } = require('../src/secrets');
const { WebPushChannel } = require('../src/notify/webpush');

test('웹푸시 암호화 왕복 + 만료 구독 정리', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orderhub-wp-'));
  const db = new Db(':memory:');
  const secrets = new Secrets({ dataDir: dir, secretKey: 'k' });
  const config = { publicUrl: 'https://shop.example.com' };
  const ch = new WebPushChannel(db, secrets, config);
  // 재시작해도 같은 VAPID 키
  assert.equal(new WebPushChannel(db, secrets, config).publicKey, ch.publicKey);

  // 브라우저 구독 흉내: 기기 키쌍 + auth secret
  const device = crypto.createECDH('prime256v1');
  device.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: device.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  ch.subscribe(sub, 'test-agent');
  ch.subscribe({ ...sub, endpoint: 'https://web.push.apple.com/gone' }, 'old');
  assert.equal(ch.count(), 2);
  assert.throws(() => ch.subscribe({ endpoint: 'http://insecure', keys: sub.keys }), /잘못된 푸시 주소/);

  const original = webpush.sendNotification;
  const received = [];
  webpush.sendNotification = async (s, payload, opts) => {
    if (s.endpoint.endsWith('/gone')) {
      const e = new Error('Gone');
      e.statusCode = 410;
      throw e;
    }
    const req = webpush.generateRequestDetails(s, payload, opts);
    assert.match(req.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(req.headers.Urgency, 'high');
    const plain = ece.decrypt(req.body, { version: 'aes128gcm', privateKey: device, authSecret: auth });
    received.push(JSON.parse(plain.toString('utf8')));
    return { statusCode: 201 };
  };
  t.after(() => {
    webpush.sendNotification = original;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const r = await ch.send({ title: '🛒 신규주문 · 내 스마트스토어', body: '홍길동 · 이어폰 ×1 · 39,900원', url: '/#/order/7', tag: 'order-7', badgeCount: 3 });
  assert.equal(r.sent, 1);
  assert.deepEqual({ ...received[0], ts: 0 }, { title: '🛒 신규주문 · 내 스마트스토어', body: '홍길동 · 이어폰 ×1 · 39,900원', url: '/#/order/7', tag: 'order-7', badgeCount: 3, ts: 0 });
  // 410 Gone 구독은 자동 삭제
  assert.equal(ch.count(), 1);
});
