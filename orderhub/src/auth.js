'use strict';
// 관리자 로그인 / 세션 (단일 사용자)
const { hashPassword, verifyPassword, randomToken, sha256 } = require('./secrets');
const { nowIso, HttpError } = require('./util');

const SESSION_DAYS = 30;
const COOKIE = 'oh_session';

class Auth {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.attempts = new Map(); // ip -> { count, resetAt }
    if (!this.hasPassword() && config.adminPassword) {
      this.db.setSetting('admin_password', hashPassword(config.adminPassword));
    }
  }

  hasPassword() {
    return !!this.db.getSetting('admin_password');
  }

  setPassword(password) {
    if (!password || String(password).length < 8) throw new HttpError(400, '비밀번호는 8자 이상으로 정해주세요');
    this.db.setSetting('admin_password', hashPassword(password));
  }

  checkRateLimit(ip) {
    const now = Date.now();
    const a = this.attempts.get(ip);
    if (a && a.resetAt > now && a.count >= 10) {
      const min = Math.ceil((a.resetAt - now) / 60000);
      throw new HttpError(429, `로그인 시도가 너무 많습니다. ${min}분 후 다시 시도해주세요`);
    }
  }

  recordFailure(ip) {
    const now = Date.now();
    const a = this.attempts.get(ip);
    if (!a || a.resetAt <= now) this.attempts.set(ip, { count: 1, resetAt: now + 15 * 60000 });
    else a.count += 1;
  }

  login(password, { ip, userAgent }) {
    this.checkRateLimit(ip);
    const stored = this.db.getSetting('admin_password');
    if (!verifyPassword(password, stored)) {
      this.recordFailure(ip);
      throw new HttpError(401, '비밀번호가 올바르지 않습니다');
    }
    this.attempts.delete(ip);
    return this.createSession({ ip, userAgent });
  }

  createSession({ ip, userAgent }) {
    const token = randomToken();
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    this.db.run(
      'INSERT INTO sessions(token_hash, created_at, expires_at, user_agent, ip) VALUES(?, ?, ?, ?, ?)',
      sha256(token),
      nowIso(),
      expires,
      String(userAgent || '').slice(0, 300),
      ip || ''
    );
    this.db.run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
    return token;
  }

  validate(token) {
    if (!token) return false;
    const row = this.db.get('SELECT expires_at FROM sessions WHERE token_hash = ?', sha256(token));
    if (!row) return false;
    if (row.expires_at < nowIso()) {
      this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
      return false;
    }
    return true;
  }

  logout(token) {
    if (token) this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  }

  logoutAll() {
    this.db.run('DELETE FROM sessions');
  }

  cookie(token, secure) {
    const parts = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  clearCookie(secure) {
    const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }
}

module.exports = { Auth, COOKIE };
