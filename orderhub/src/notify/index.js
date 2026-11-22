'use strict';
// 알림 통합 관리: 웹푸시 / 텔레그램 / ntfy 를 동시에 사용할 수 있다
const { WebPushChannel } = require('./webpush');
const { sendTelegram, detectChats } = require('./telegram');
const { sendNtfy } = require('./ntfy');
const { mask, HttpError } = require('../util');

const DEFAULTS = {
  events: { newOrder: true, claim: true, error: true },
  webpush: { enabled: true },
  telegram: { enabled: false, chatId: '' },
  ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '' },
};

class Notifier {
  constructor({ db, secrets, config }) {
    this.db = db;
    this.secrets = secrets;
    this.config = config;
    this.webpush = new WebPushChannel(db, secrets, config);
  }

  getConfig() {
    const c = this.db.getSetting('notify', {});
    return {
      events: { ...DEFAULTS.events, ...(c.events || {}) },
      webpush: { ...DEFAULTS.webpush, ...(c.webpush || {}) },
      telegram: { ...DEFAULTS.telegram, ...(c.telegram || {}) },
      ntfy: { ...DEFAULTS.ntfy, ...(c.ntfy || {}) },
    };
  }

  getSecrets() {
    const enc = this.db.getSetting('notify_secrets');
    if (!enc) return {};
    try {
      return this.secrets.decrypt(enc);
    } catch {
      return {};
    }
  }

  // 화면에 보여줄 설정 (비밀값은 마스킹)
  publicConfig() {
    const c = this.getConfig();
    const s = this.getSecrets();
    return {
      ...c,
      telegram: { ...c.telegram, botTokenMasked: mask(s.telegramToken), hasBotToken: !!s.telegramToken },
      ntfy: { ...c.ntfy, tokenMasked: mask(s.ntfyToken), hasToken: !!s.ntfyToken },
      webpush: { ...c.webpush, publicKey: this.webpush.publicKey, subscriptions: this.webpush.count() },
    };
  }

  updateConfig(input = {}) {
    const c = this.getConfig();
    const s = this.getSecrets();
    if (input.events) for (const k of Object.keys(DEFAULTS.events)) if (k in input.events) c.events[k] = !!input.events[k];
    if (input.webpush && 'enabled' in input.webpush) c.webpush.enabled = !!input.webpush.enabled;
    if (input.telegram) {
      if ('enabled' in input.telegram) c.telegram.enabled = !!input.telegram.enabled;
      if ('chatId' in input.telegram) c.telegram.chatId = String(input.telegram.chatId || '').trim();
      if (input.telegram.botToken) s.telegramToken = String(input.telegram.botToken).trim();
      if (input.telegram.clearToken) delete s.telegramToken;
    }
    if (input.ntfy) {
      if ('enabled' in input.ntfy) c.ntfy.enabled = !!input.ntfy.enabled;
      if ('server' in input.ntfy) c.ntfy.server = String(input.ntfy.server || 'https://ntfy.sh').trim();
      if ('topic' in input.ntfy) {
        const t = String(input.ntfy.topic || '').trim();
        if (t && !/^[A-Za-z0-9_-]{1,64}$/.test(t)) throw new HttpError(400, 'ntfy 토픽은 영문/숫자/-/_ 만 사용할 수 있습니다');
        c.ntfy.topic = t;
      }
      if (input.ntfy.token) s.ntfyToken = String(input.ntfy.token).trim();
      if (input.ntfy.clearToken) delete s.ntfyToken;
    }
    this.db.setSetting('notify', c);
    this.db.setSetting('notify_secrets', this.secrets.encrypt(s));
    return this.publicConfig();
  }

  absoluteUrl(path) {
    if (!path) return this.config.publicUrl || '';
    if (/^https?:\/\//.test(path)) return path;
    return this.config.publicUrl ? this.config.publicUrl + path : '';
  }

  // msg: { type: newOrder|claim|error|test, title, body, url, tag, priority }
  async send(msg, { only } = {}) {
    const c = this.getConfig();
    if (msg.type && msg.type !== 'test' && c.events[msg.type] === false) return { skipped: 'event-disabled' };
    const s = this.getSecrets();
    const full = { ...msg, absoluteUrl: this.absoluteUrl(msg.url) };
    const results = {};
    const tasks = [];
    const want = (ch) => (only ? only === ch : c[ch]?.enabled);
    if (want('webpush')) {
      tasks.push(
        this.webpush
          .send(full)
          .then((r) => (results.webpush = r))
          .catch((e) => (results.webpush = { error: e.message }))
      );
    }
    if (want('telegram')) {
      tasks.push(
        sendTelegram(this.config, { botToken: s.telegramToken, chatId: c.telegram.chatId }, full)
          .then((r) => (results.telegram = r))
          .catch((e) => (results.telegram = { error: e.message }))
      );
    }
    if (want('ntfy')) {
      tasks.push(
        sendNtfy({ server: c.ntfy.server, topic: c.ntfy.topic, token: s.ntfyToken }, full)
          .then((r) => (results.ntfy = r))
          .catch((e) => (results.ntfy = { error: e.message }))
      );
    }
    await Promise.all(tasks);
    const errors = Object.entries(results).filter(([, r]) => r?.error);
    if (errors.length) {
      for (const [ch, r] of errors) this.db.addEvent({ level: 'warn', type: 'notify', message: `${ch} 알림 실패: ${r.error}` });
    }
    return results;
  }

  async test(channel) {
    const titles = { webpush: '웹앱 푸시', telegram: '텔레그램', ntfy: 'ntfy' };
    const r = await this.send(
      { type: 'test', title: '🔔 오더허브 테스트 알림', body: `${titles[channel] || channel} 알림이 정상적으로 도착했습니다.`, url: '/', tag: 'test' },
      { only: channel }
    );
    const res = r[channel];
    if (!res) throw new HttpError(400, '알림 채널 설정을 확인해주세요');
    if (res.error) throw new HttpError(400, res.error);
    if (res.skipped) throw new HttpError(400, '이 채널에 등록된 기기가 없습니다. 먼저 [이 기기에서 알림 받기]를 눌러주세요.');
    return res;
  }

  async detectTelegramChats(botToken) {
    const token = botToken || this.getSecrets().telegramToken;
    return detectChats(this.config, token);
  }
}

module.exports = { Notifier };
