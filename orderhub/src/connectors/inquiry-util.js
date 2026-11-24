'use strict';
// 문의 수집 공통 도구
const { kstDateWindows, str } = require('../util');

// "조회된 데이터가 없습니다" 처럼 0건을 오류로 돌려주는 마켓 응답 (권한·인증 오류는 해당 없음)
const NO_DATA = /(데이터|자료|내역|결과|정보|목록|문의|게시물)[가이는]?\s*(존재하지\s*않|없)|no\s*data/i;
function isNoData(e) {
  const msg = String(e?.message || '');
  return !e?.network && !e?.status && NO_DATA.test(msg) && !/HTTP [45]\d\d/.test(msg) && !/권한|인증/.test(msg);
}

// 최근 days일(오늘 포함)을 span일 이하 날짜 구간으로 ('YYYY-MM-DD')
function dateRanges(days, span = 7, now = new Date()) {
  return kstDateWindows(Math.max(1, days) - 1, span, now);
}

const compact = (ymd) => ymd.replace(/-/g, '');

// HTML 이 섞여 오는 문의 내용을 일반 텍스트로 (<문의> 같은 글자는 그대로 둠)
function plainText(v) {
  if (v && typeof v === 'object') return '';
  return str(v)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<\/?[a-z][a-z0-9]*(\s[^<>]*)?\/?>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { isNoData, dateRanges, compact, plainText };
