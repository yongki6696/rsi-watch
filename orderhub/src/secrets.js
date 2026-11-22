'use strict';
// API 키 등 민감정보 암호화(AES-256-GCM)와 관리자 비밀번호 해시(scrypt)
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function loadKey(config) {
  if (config.secretKey) {
    return crypto.createHash('sha256').update(config.secretKey).digest();
  }
  const file = path.join(config.dataDir, 'secret.key');
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (fs.existsSync(file)) {
    const b = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (b.length === 32) return b;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
  return key;
}

class Secrets {
  constructor(config) {
    this.key = loadKey(config);
  }

  encrypt(obj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(obj ?? {}), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
  }

  decrypt(text) {
    if (!text) return {};
    const parts = String(text).split(':');
    if (parts[0] !== 'v1' || parts.length !== 4) throw new Error('알 수 없는 암호화 형식');
    const [, iv, tag, data] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
    return JSON.parse(out.toString('utf8'));
  }
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

module.exports = { Secrets, hashPassword, verifyPassword, randomToken, sha256 };
