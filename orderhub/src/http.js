'use strict';
// 의존성 없는 작은 HTTP 라우터 + 정적 파일 서빙
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/\//g, '\\/').replace(/:([A-Za-z_]+)/g, (_, k) => {
          keys.push(k);
          return '([^\\/]+)';
        }) +
        '$'
    );
    this.routes.push({ method, re, keys, handler, opts });
  }

  get(p, h, o) {
    this.add('GET', p, h, o);
  }
  post(p, h, o) {
    this.add('POST', p, h, o);
  }
  put(p, h, o) {
    this.add('PUT', p, h, o);
  }
  delete(p, h, o) {
    this.add('DELETE', p, h, o);
  }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return { route: r, params };
      }
    }
    return null;
  }
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '요청이 너무 큽니다'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extraHeaders });
  res.end(text);
}

function serveStatic(publicDir, req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir)) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    ...SECURITY_HEADERS,
  };
  // HTML·서비스워커·매니페스트는 항상 최신으로, 나머지는 짧게 캐시
  if (ext === '.html' || rel === '/sw.js' || ext === '.webmanifest') headers['Cache-Control'] = 'no-cache';
  else headers['Cache-Control'] = 'public, max-age=300';
  if (rel === '/sw.js') headers['Service-Worker-Allowed'] = '/';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}

module.exports = { Router, readBody, parseCookies, sendJson, sendText, serveStatic, SECURITY_HEADERS };
