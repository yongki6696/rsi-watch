'use strict';
// 커넥터 공용 HTTP 도우미
const nodeHttps = require('node:https');
const nodeHttp = require('node:http');
const nodeTls = require('node:tls');

// 16자리 이상 정수는 JS Number 로 정확히 표현되지 않으므로(쿠팡 shipmentBoxId 등)
// 문자열 바깥의 큰 정수를 따옴표로 감싸서 문자열로 파싱한다.
function parseJsonBig(text) {
  if (typeof text !== 'string' || !text) return text ? JSON.parse(text) : null;
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      // 문자열 통째로 복사 (이스케이프 처리)
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') j += 2;
        else if (text[j] === '"') break;
        else j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i + 1;
      while (j < n && /[0-9eE+\-.]/.test(text[j])) j++;
      const num = text.slice(i, j);
      if (/^-?\d{16,}$/.test(num)) out += `"${num}"`;
      else out += num;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return JSON.parse(out);
}

// JSON 직렬화 시 BIG('123...') 로 감싼 값은 따옴표 없는 숫자로 내보낸다.
const BIG_PREFIX = '\u0000BIG:';
function BIG(v) {
  const s = String(v);
  if (!/^\d+$/.test(s)) throw new Error(`숫자 ID 형식이 아닙니다: ${s}`);
  return BIG_PREFIX + s;
}
function stringifyBig(obj) {
  return JSON.stringify(obj).replace(/"\\u0000BIG:(\d+)"/g, '$1');
}

// 중계 서버(HTTP CONNECT 프록시) 주소: '1.2.3.4', '1.2.3.4:8888', 'http://user:pass@host:port' 모두 허용
function parseProxy(proxy) {
  const v = String(proxy || '').trim();
  if (!v) return null;
  const u = new URL(/^https?:\/\//i.test(v) ? v : `http://${v}`);
  return {
    host: u.hostname,
    port: Number(u.port) || 80,
    auth: u.username ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}` : null,
    label: `${u.hostname}${u.port ? `:${u.port}` : ''}`,
  };
}

function proxyError(message, extra = {}) {
  return Object.assign(new Error(message), { network: true, proxy: true }, extra);
}

// 중계 서버에 CONNECT 로 터널을 열어 소켓을 돌려줌
function openTunnel(proxy, host, port, timeoutMs = 15000) {
  const p = typeof proxy === 'string' ? parseProxy(proxy) : proxy;
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` };
    if (p.auth) headers['Proxy-Authorization'] = p.auth;
    const req = nodeHttp.request({ host: p.host, port: p.port, method: 'CONNECT', path: `${host}:${port}`, headers, timeout: timeoutMs });
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) return resolve(socket);
      socket.destroy();
      reject(proxyError(`국내 중계 서버가 연결을 거부했습니다 (HTTP ${res.statusCode}) - 중계 서버에 이 오더허브 서버 IP가 허용돼 있는지 확인해주세요`, { proxyStatus: res.statusCode }));
    });
    // 2xx 가 아닌 CONNECT 응답은 'connect' 가 아니라 'response' 로 옴 (거부·필터됨)
    req.on('response', (res) => {
      res.resume();
      reject(proxyError(`국내 중계 서버가 연결을 거부했습니다 (HTTP ${res.statusCode}) - 중계 서버에 이 오더허브 서버 IP가 허용돼 있는지 확인해주세요`, { proxyStatus: res.statusCode }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(proxyError(`국내 중계 서버(${p.label})에 연결하지 못했습니다 (${e.code || e.message})`, { code: e.code })));
    req.end();
  });
}

// 중계 서버를 거쳐 요청 (응답 형식은 request 와 같음)
async function requestViaProxy(url, { method = 'GET', headers = {}, body, timeoutMs = 30000, proxy }) {
  const target = new URL(url);
  const https = target.protocol === 'https:';
  const port = Number(target.port) || (https ? 443 : 80);
  const socket = await openTunnel(proxy, target.hostname, port, Math.min(timeoutMs, 15000));
  const data = body === undefined || body === null ? null : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = (https ? nodeHttps : nodeHttp).request(
      {
        host: target.hostname,
        port,
        path: target.pathname + target.search,
        method,
        headers: { ...headers, ...(data ? { 'Content-Length': data.length } : {}) },
        agent: false,
        timeout: timeoutMs,
        createConnection: () => (https ? nodeTls.connect({ socket, servername: target.hostname }) : socket),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const h = res.headers;
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: { get: (k) => (Array.isArray(h[String(k).toLowerCase()]) ? h[String(k).toLowerCase()].join(', ') : h[String(k).toLowerCase()] ?? null) },
            buffer: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => {
      socket.destroy();
      reject(Object.assign(new Error(`마켓 서버에 연결하지 못했습니다 (${e.code || e.message}) - 중계 서버 경유`), { network: true, viaProxy: true }));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 30000, proxy } = {}) {
  if (proxy) return requestViaProxy(url, { method, headers, body, timeoutMs, proxy });
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const reason = e?.cause?.code || e?.cause?.message || e?.name || e?.message;
    const err = new Error(`마켓 서버에 연결하지 못했습니다 (${reason})`);
    err.network = true;
    throw err;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ok: res.ok, headers: res.headers, buffer };
}

// fetch 대신 쓰는 기본 HTTP 요청: 브라우저용 Sec-Fetch 헤더 없이, User-Agent 를 직접 정해서 보냄
// (일부 마켓 방화벽은 Node 기본 요청 'User-Agent: node' 를 막는다)
function requestRaw(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? nodeHttp : nodeHttps;
    const data = body === undefined || body === null ? null : Buffer.from(body);
    const req = lib.request(u, { method, headers: { ...headers, ...(data ? { 'Content-Length': data.length } : {}) }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const h = res.headers;
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: {
            get: (k) => {
              const v = h[String(k).toLowerCase()];
              return Array.isArray(v) ? v.join(', ') : v ?? null;
            },
          },
          buffer: Buffer.concat(chunks),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => {
      const err = new Error(`마켓 서버에 연결하지 못했습니다 (${e.code || e.message})`);
      err.network = true;
      reject(err);
    });
    if (data) req.write(data);
    req.end();
  });
}

function decodeText(buffer, headers, fallbackCharset = 'utf-8') {
  const ct = headers?.get?.('content-type') || '';
  const m = ct.match(/charset=([^;]+)/i);
  let charset = (m ? m[1] : '').trim().toLowerCase();
  if (!charset) {
    // XML 선언에서 인코딩 확인
    const head = buffer.subarray(0, 200).toString('latin1');
    const x = head.match(/encoding=["']([^"']+)["']/i);
    charset = x ? x[1].toLowerCase() : fallbackCharset;
  }
  if (charset === 'ks_c_5601-1987' || charset === 'cp949' || charset === 'ms949') charset = 'euc-kr';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

module.exports = { request, requestRaw, openTunnel, parseProxy, parseJsonBig, stringifyBig, BIG, decodeText };
