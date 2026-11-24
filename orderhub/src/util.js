'use strict';
// 공통 유틸리티: 시간(KST) 포맷, 안전한 JSON, 숫자/문자 정리 등

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

// Date -> KST 기준 각 필드
function kstParts(d = new Date()) {
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  return {
    y: k.getUTCFullYear(),
    m: pad(k.getUTCMonth() + 1),
    d: pad(k.getUTCDate()),
    hh: pad(k.getUTCHours()),
    mm: pad(k.getUTCMinutes()),
    ss: pad(k.getUTCSeconds()),
    ms: pad(k.getUTCMilliseconds(), 3),
  };
}

// 2026-11-22T14:03:00.000+09:00 (네이버 형식)
function kstIso(d = new Date()) {
  const p = kstParts(d);
  return `${p.y}-${p.m}-${p.d}T${p.hh}:${p.mm}:${p.ss}.${p.ms}+09:00`;
}

// 2026-11-22 (쿠팡 일단위 조회)
function kstDate(d = new Date()) {
  const p = kstParts(d);
  return `${p.y}-${p.m}-${p.d}`;
}

// 오늘(KST)부터 days일 전까지를 size일씩 나눈 날짜 구간 (오래된 구간부터) - 지난 주문 불러오기용
// 예) days 31, size 7 → [{from:'2026-10-22', to:'2026-10-28'}, … , {from:'2026-11-19', to:'2026-11-22'}]
function kstDateWindows(days, size, now = new Date()) {
  const today = Date.parse(`${kstDate(now)}T00:00:00Z`);
  const out = [];
  for (let start = today - days * 86400000; start <= today; start += size * 86400000) {
    const end = Math.min(start + (size - 1) * 86400000, today);
    out.push({ from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) });
  }
  return out;
}

// 202611221403 (11번가 YYYYMMDDhhmm)
function kstCompact(d = new Date()) {
  const p = kstParts(d);
  return `${p.y}${p.m}${p.d}${p.hh}${p.mm}`;
}

// 마켓에서 받은 다양한 날짜 문자열을 UTC ISO 문자열로 통일.
// 시간대 표기가 없으면 KST로 간주한다.
function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return isNaN(value) ? null : value.toISOString();
  let s = String(value).trim();
  if (!s) return null;
  if (/^\d{14}$/.test(s)) {
    // YYYYMMDDhhmmss
    s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
  } else if (/^\d{12}$/.test(s)) {
    s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00`;
  } else if (/^\d{8}$/.test(s)) {
    s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00`;
  }
  // 2026.07.16 12:34 / 2026/07/16 → 2026-07-16 12:34
  s = s.replace(/^(\d{4})[./](\d{1,2})[./](\d{1,2})\.?/, (_, y, m, d) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
  s = s.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00';
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(s);
  if (!hasZone) s += '+09:00';
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

function safeJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toInt(v, fallback = null) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object' && v !== null && 'units' in v) {
    // 쿠팡 money 객체 {currencyCode, units, nanos}
    return Math.round(Number(v.units || 0) + Number(v.nanos || 0) / 1e9);
  }
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 전화번호 하이픈 정리 (01012345678 -> 010-1234-5678)
function formatPhone(v) {
  const s = str(v);
  const digits = s.replace(/\D/g, '');
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) {
    if (digits.startsWith('02')) return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 12 && digits.startsWith('050')) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8)}`;
  }
  return s;
}

function won(n) {
  if (n === null || n === undefined || n === '') return '';
  return `${Number(n).toLocaleString('ko-KR')}원`;
}

// 비밀값 마스킹: 앞 4글자만 보여준다
function mask(v) {
  const s = str(v);
  if (!s) return '';
  if (s.length <= 6) return '•'.repeat(s.length);
  return s.slice(0, 4) + '•'.repeat(Math.min(12, s.length - 4));
}

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

module.exports = {
  KST_OFFSET_MS,
  kstIso,
  kstDate,
  kstDateWindows,
  kstCompact,
  kstParts,
  toIso,
  nowIso,
  safeJson,
  toInt,
  str,
  chunk,
  sleep,
  formatPhone,
  won,
  mask,
  HttpError,
};
