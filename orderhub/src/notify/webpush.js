'use strict';
// 웹 푸시 (PWA 알림) - 앱 설치 없이 휴대폰 홈화면 웹앱으로 알림 수신
const webpush = require('web-push');
const { nowIso } = require('../util');

class WebPushChannel {
  constructor(db, secrets, config) {
    this.db = db;
    this.secrets = secrets;
    this.config = config;
    let vapid = db.getSetting('vapid');
    if (!vapid?.publicKey || !vapid?.privateKeyEnc) {
      const keys = webpush.generateVAPIDKeys();
      vapid = { publicKey: keys.publicKey, privateKeyEnc: secrets.encrypt({ k: keys.privateKey }) };
      db.setSetting('vapid', vapid);
    }
    this.publicKey = vapid.publicKey;
    this.privateKey = secrets.decrypt(vapid.privateKeyEnc).k;
  }

  subject() {
    if (process.env.VAPID_SUBJECT) return process.env.VAPID_SUBJECT;
    if (this.config.publicUrl.startsWith('https://')) return this.config.publicUrl;
    return 'mailto:orderhub@orderhub.app';
  }

  count() {
    return this.db.get('SELECT COUNT(*) AS n FROM push_subscriptions').n;
  }

  subscribe(sub, userAgent) {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('잘못된 구독 정보');
    if (!/^https:\/\//.test(sub.endpoint)) throw new Error('잘못된 푸시 주소');
    this.db.run(
      `INSERT INTO push_subscriptions(endpoint, p256dh, auth, user_agent, created_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, fail_count = 0`,
      sub.endpoint,
      sub.keys.p256dh,
      sub.keys.auth,
      String(userAgent || '').slice(0, 300),
      nowIso()
    );
  }

  unsubscribe(endpoint) {
    this.db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint);
  }

  async send(msg) {
    const subs = this.db.all('SELECT * FROM push_subscriptions');
    if (!subs.length) return { sent: 0, skipped: true };
    const payload = JSON.stringify({
      title: msg.title,
      body: msg.body,
      url: msg.url || '/',
      tag: msg.tag || undefined,
      badgeCount: typeof msg.badgeCount === 'number' ? msg.badgeCount : undefined,
      ts: Date.now(),
    });
    let sent = 0;
    const errors = [];
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
            vapidDetails: { subject: this.subject(), publicKey: this.publicKey, privateKey: this.privateKey },
            TTL: 24 * 3600,
            urgency: msg.priority === 'low' ? 'normal' : 'high',
            timeout: 15000,
          });
          sent++;
          this.db.run('UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE id = ?', nowIso(), s.id);
        } catch (e) {
          const code = e.statusCode;
          if (code === 404 || code === 410) {
            this.db.run('DELETE FROM push_subscriptions WHERE id = ?', s.id); // 만료된 구독
          } else {
            this.db.run('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?', s.id);
            errors.push(`${code || ''} ${e.body || e.message}`.trim());
          }
        }
      })
    );
    if (!sent && errors.length) throw new Error(`웹푸시 전송 실패: ${errors[0]}`);
    return { sent };
  }
}

module.exports = { WebPushChannel };
