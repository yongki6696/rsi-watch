'use strict';
// 취소·반품·교환 사유 → 누구 책임인지(반품배송비를 누가 내는지)
const { str, toInt } = require('./util');

// 스마트스토어 사유 코드 (네이버는 사유로 귀책을 정하고, 귀책에 따라 클레임 배송비 부담자가 정해짐)
const NAVER_REASONS = {
  INTENT_CHANGED: ['구매 의사 취소', 'BUYER'],
  SIMPLE_INTENT_CHANGED: ['단순 변심', 'BUYER'],
  MISTAKE_ORDER: ['주문 실수', 'BUYER'],
  COLOR_AND_SIZE: ['색상·사이즈 변경', 'BUYER'],
  COLOR_SIZE_CHANGE: ['색상·사이즈 변경', 'BUYER'],
  WRONG_ORDER: ['다른 상품 잘못 주문', 'BUYER'],
  DELAYED_DELIVERY_BY_PURCHASER: ['구매자 사정 (배송 지연)', 'BUYER'],
  GIFT_INTENT_CHANGED: ['선물 의사 취소', 'BUYER'],
  GIFT_REFUSAL: ['선물 거절', 'BUYER'],
  PRODUCT_UNSATISFIED: ['서비스·상품 불만족', 'SELLER'],
  DELAYED_DELIVERY: ['배송 지연', 'SELLER'],
  SOLD_OUT: ['상품 품절', 'SELLER'],
  DROPPED_DELIVERY: ['배송 누락', 'SELLER'],
  BROKEN: ['상품 파손', 'SELLER'],
  BROKEN_AND_BAD: ['상품 파손·불량', 'SELLER'],
  INCORRECT_INFO: ['상품 정보와 다름', 'SELLER'],
  WRONG_DELIVERY: ['오배송', 'SELLER'],
  WRONG_OPTION: ['다른 옵션(색상 등)으로 배송', 'SELLER'],
  ETC: ['기타', 'UNKNOWN'],
};

// 쿠팡 귀책 타입
const COUPANG_FAULT = { CUSTOMER: 'BUYER', BUYER: 'BUYER', VENDOR: 'SELLER', SELLER: 'SELLER', COUPANG: 'MARKET', WMS: 'MARKET' };

// 사유 글자로 귀책 추정 (11번가·롯데ON 등 사유가 글자로만 오는 마켓)
function faultFromText(text) {
  const t = str(text);
  if (!t) return 'UNKNOWN';
  if (/불량|파손|하자|훼손|오염|변질|오배송|잘못\s*(배송|발송|보냄|왔)|다른\s*상품.*(배송|도착|왔)|상이|다름|누락|지연|품절|구성품|가품|판매자\s*(사유|귀책|책임)/.test(t)) return 'SELLER';
  if (/변심|필요\s*없|실수|잘못\s*주문|주문\s*(실수|착오)|사이즈|색상|컬러|옵션\s*변경|마음|다른\s*곳|저렴|더\s*싼|구매\s*의사|고객\s*(사유|귀책|요청)|구매자\s*(사유|귀책|책임)/.test(t)) return 'BUYER';
  return 'UNKNOWN';
}

function naverReason(code) {
  const c = str(code).toUpperCase();
  const hit = NAVER_REASONS[c];
  return hit ? { reason: hit[0], fault: hit[1] } : { reason: c ? c : '', fault: 'UNKNOWN' };
}

// 쿠팡 금액 필드: 숫자 또는 { units, nanos }
function money(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') return v.units !== undefined ? toInt(v.units, 0) : null;
  const n = toInt(v, null);
  return Number.isFinite(n) ? n : null;
}

const won = (n) => `${Number(n).toLocaleString('ko-KR')}원`;
const MARKET_NAME = { coupang: '쿠팡', naver: '스마트스토어', elevenst: '11번가', lotteon: '롯데ON', gmarket: 'G마켓', auction: '옥션' };

// 화면·알림에 보여줄 한 줄: 사유 + 반품배송비 부담
//   info: { market, type, reason, detail, fault, feeAmount, feeNote }, shipped: 이미 발송했는지
function claimSummary(info, { shipped = true } = {}) {
  if (!info || !info.type) return null;
  const detail = str(info.detail);
  const reason = [str(info.reason), detail && detail !== str(info.reason) ? `"${detail.slice(0, 80)}"` : ''].filter(Boolean).join(' ') || '사유 정보 없음';
  let payer = info.fault || 'UNKNOWN';
  // 스마트스토어는 반품배송비 청구액이 있으면 구매자가 낸다
  if (info.market === 'naver' && info.feeAmount > 0) payer = 'BUYER';
  const fee = info.feeAmount > 0 ? `${won(info.feeAmount)}${info.feeNote ? ` · ${info.feeNote}` : ''}` : '';
  let payerText;
  if (info.type === 'CANCEL' && !shipped) payerText = '배송 전 취소라 반품배송비 없음';
  else if (payer === 'BUYER') {
    payerText =
      info.market === 'naver' && info.feeAmount === 0
        ? '반품배송비 구매자 책임 사유 (청구액 0원 - 무료반품·반품안심케어 등)'
        : `반품배송비 구매자 부담${fee ? ` (${fee})` : ''}`;
  } else if (payer === 'SELLER') payerText = `반품배송비 판매자 부담 (판매자 책임 사유${fee ? `, 예상 ${fee}` : ''})`;
  else if (payer === 'MARKET') payerText = `반품배송비 ${MARKET_NAME[info.market] || '마켓'} 부담`;
  else payerText = '반품배송비 부담: 사유를 보고 확인해주세요';
  return { reason, payer, payerText, text: `사유: ${reason} → ${payerText}` };
}

module.exports = { NAVER_REASONS, naverReason, faultFromText, COUPANG_FAULT, money, claimSummary };
