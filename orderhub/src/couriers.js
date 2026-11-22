'use strict';
// 택배사 통합 목록과 마켓별 코드
// naver: 커머스API deliveryCompanyCode / coupang: deliveryCompanyCode / elevenst: dlvEtprsCd
// 코드가 null 인 마켓은 해당 택배사를 지원하지 않거나 확인되지 않은 것 → '직접 코드 입력' 사용

const COURIERS = [
  { key: 'CJ', name: 'CJ대한통운', naver: 'CJGLS', coupang: 'CJGLS', elevenst: '00034' },
  { key: 'LOTTE', name: '롯데택배', naver: 'HYUNDAI', coupang: 'HYUNDAI', elevenst: '00012' },
  { key: 'HANJIN', name: '한진택배', naver: 'HANJIN', coupang: 'HANJIN', elevenst: '00011' },
  { key: 'EPOST', name: '우체국택배', naver: 'EPOST', coupang: 'EPOST', elevenst: '00007' },
  { key: 'LOGEN', name: '로젠택배', naver: 'KGB', coupang: 'KGB', elevenst: '00002' },
  { key: 'KDEXP', name: '경동택배', naver: 'KDEXP', coupang: 'KDEXP', elevenst: '00026' },
  { key: 'DAESIN', name: '대신택배', naver: 'DAESIN', coupang: 'DAESIN', elevenst: '00021' },
  { key: 'ILYANG', name: '일양로지스', naver: 'ILYANG', coupang: 'ILYANG', elevenst: '00022' },
  { key: 'CHUNIL', name: '천일택배', naver: 'CHUNIL', coupang: 'CHUNIL', elevenst: null },
  { key: 'HDEXP', name: '합동택배', naver: 'HDEXP', coupang: 'HDEXP', elevenst: null },
  { key: 'KUNYOUNG', name: '건영택배', naver: 'KUNYOUNG', coupang: 'KUNYOUNG', elevenst: null },
  { key: 'CVSNET', name: 'GS Postbox 택배', naver: 'CVSNET', coupang: 'CVSNET', elevenst: null },
  { key: 'CUPARCEL', name: 'CU 편의점택배', naver: 'CUPARCEL', coupang: null, elevenst: '00061' },
  { key: 'REGISTPOST', name: '우편등기', naver: 'REGISTPOST', coupang: 'REGISTPOST', elevenst: '00008' },
  { key: 'EMS', name: 'EMS', naver: 'EMS', coupang: 'EMS', elevenst: '00058' },
  { key: 'KOREXG', name: 'CJ대한통운 국제특송', naver: 'KOREXG', coupang: 'KOREXG', elevenst: '00045' },
  { key: 'DHL', name: 'DHL', naver: 'DHL', coupang: 'DHL', elevenst: null },
  { key: 'FEDEX', name: 'FedEx', naver: 'FEDEX', coupang: 'FEDEX', elevenst: null },
  { key: 'UPS', name: 'UPS', naver: 'UPS', coupang: 'UPS', elevenst: null },
];

const BY_KEY = Object.fromEntries(COURIERS.map((c) => [c.key, c]));

function courierName(key) {
  if (!key) return '';
  if (key.startsWith('CUSTOM:')) return `직접입력(${key.slice(7)})`;
  return BY_KEY[key]?.name || key;
}

// 마켓 유형에 맞는 택배사 코드. 'CUSTOM:XXX' 이면 XXX 를 그대로 사용.
function courierCode(key, market) {
  if (!key) return null;
  if (key.startsWith('CUSTOM:')) return key.slice(7).trim() || null;
  const c = BY_KEY[key];
  if (!c) return null;
  if (market === 'demo') return c.key;
  return c[market] || null;
}

// 엑셀/붙여넣기에서 들어온 택배사 이름을 키로 변환
function findCourier(text) {
  const t = String(text || '').replace(/\s/g, '').toLowerCase();
  if (!t) return null;
  const aliases = {
    cj: 'CJ', 대한통운: 'CJ', cj대한통운: 'CJ', 씨제이: 'CJ', cjgls: 'CJ',
    롯데: 'LOTTE', 롯데택배: 'LOTTE', 현대택배: 'LOTTE', hyundai: 'LOTTE', lotte: 'LOTTE',
    한진: 'HANJIN', 한진택배: 'HANJIN', hanjin: 'HANJIN',
    우체국: 'EPOST', 우체국택배: 'EPOST', epost: 'EPOST',
    로젠: 'LOGEN', 로젠택배: 'LOGEN', kgb: 'LOGEN', logen: 'LOGEN',
    경동: 'KDEXP', 경동택배: 'KDEXP',
    대신: 'DAESIN', 대신택배: 'DAESIN',
    일양: 'ILYANG', 일양로지스: 'ILYANG',
    천일: 'CHUNIL', 천일택배: 'CHUNIL',
    합동: 'HDEXP', 합동택배: 'HDEXP',
    건영: 'KUNYOUNG', 건영택배: 'KUNYOUNG',
    gs편의점: 'CVSNET', gspostbox: 'CVSNET', 편의점택배: 'CVSNET',
    cu: 'CUPARCEL', cu편의점: 'CUPARCEL', cu편의점택배: 'CUPARCEL',
    등기: 'REGISTPOST', 우편등기: 'REGISTPOST',
    ems: 'EMS', dhl: 'DHL', fedex: 'FEDEX', ups: 'UPS',
  };
  if (aliases[t]) return aliases[t];
  const exact = COURIERS.find((c) => c.name.replace(/\s/g, '').toLowerCase() === t || c.key.toLowerCase() === t);
  if (exact) return exact.key;
  const partial = COURIERS.find((c) => c.name.replace(/\s/g, '').toLowerCase().includes(t));
  return partial ? partial.key : null;
}

// 배송조회 링크 (네이버 검색의 택배 조회 기능 사용)
function trackingUrl(key, trackingNo) {
  if (!trackingNo) return '';
  const q = `${courierName(key)} ${trackingNo}`;
  return `https://search.naver.com/search.naver?query=${encodeURIComponent(q)}`;
}

module.exports = { COURIERS, courierName, courierCode, findCourier, trackingUrl };
