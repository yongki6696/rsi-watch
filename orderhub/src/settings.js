'use strict';
// 앱 설정 (수집 주기 등)
const { HttpError } = require('./util');

const DEFAULTS = {
  pollIntervalMin: 5, // 자동 수집 주기(분)
  autoConfirm: false, // 신규주문 수집 즉시 마켓 발주확인
  confirmOnPurchase: true, // [발주완료] 처리 시 마켓 발주확인도 함께
  defaultCourier: 'CJ', // 기본 택배사
  initialDays: 7, // 스토어 첫 연결 시 불러올 기간(일) - 처리 대기 주문을 빠짐없이
  collectInquiries: true, // 고객 문의 수집·알림
};

function getAppSettings(db) {
  return { ...DEFAULTS, ...(db.getSetting('app', {}) || {}) };
}

function updateAppSettings(db, input = {}) {
  const s = getAppSettings(db);
  if ('pollIntervalMin' in input) {
    const n = Number(input.pollIntervalMin);
    if (!Number.isFinite(n) || n < 1 || n > 120) throw new HttpError(400, '수집 주기는 1~120분 사이로 정해주세요');
    s.pollIntervalMin = Math.round(n);
  }
  if ('autoConfirm' in input) s.autoConfirm = !!input.autoConfirm;
  if ('confirmOnPurchase' in input) s.confirmOnPurchase = !!input.confirmOnPurchase;
  if ('collectInquiries' in input) s.collectInquiries = !!input.collectInquiries;
  if ('defaultCourier' in input) s.defaultCourier = String(input.defaultCourier || 'CJ');
  if ('initialDays' in input) {
    const n = Number(input.initialDays);
    if (!Number.isFinite(n) || n < 1 || n > 7) throw new HttpError(400, '처음 불러올 기간은 1~7일로 정해주세요');
    s.initialDays = Math.round(n);
  }
  db.setSetting('app', s);
  return s;
}

module.exports = { getAppSettings, updateAppSettings, DEFAULTS };
