'use strict';
// 응답 필드 이름이 문서와 조금 달라도 찾아내기 위한 도우미
// pick(obj, ['정확한이름', ...], [/정규식/, ...])

function isEmpty(v) {
  return v === undefined || v === null || v === '' || v === 'null';
}

function pick(obj, names = [], patterns = []) {
  if (!obj || typeof obj !== 'object') return '';
  for (const n of names) if (!isEmpty(obj[n])) return obj[n];
  // 대소문자 무시
  const lower = Object.fromEntries(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const k = lower[String(n).toLowerCase()];
    if (k && !isEmpty(obj[k])) return obj[k];
  }
  for (const re of patterns) {
    const k = Object.keys(obj).find((key) => re.test(key) && !isEmpty(obj[key]) && typeof obj[key] !== 'object');
    if (k) return obj[k];
  }
  return '';
}

// 응답에서 첫 번째 "객체 배열" 찾기 (data, data.list, data.content ...)
function findArray(root, preferred = []) {
  if (Array.isArray(root)) return root;
  if (!root || typeof root !== 'object') return [];
  for (const k of preferred) if (Array.isArray(root[k])) return root[k];
  for (const v of Object.values(root)) {
    if (Array.isArray(v) && (v.length === 0 || typeof v[0] === 'object')) return v;
  }
  for (const v of Object.values(root)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = findArray(v, preferred);
      if (inner.length) return inner;
    }
  }
  return [];
}

// 개인통관고유부호(P + 숫자 12자리) 값 찾기
function findCustomsCode(obj) {
  const direct = pick(obj, [], [/custom|pccc|clearance|psnCsc|prsnCstms/i]);
  if (direct) return String(direct);
  for (const v of Object.values(obj || {})) if (/^P\d{12}$/.test(String(v))) return String(v);
  return '';
}

// 진단용: 응답 구조 요약 (연결 테스트 결과에 표시)
function shape(obj, depth = 0) {
  // 배열은 깊이를 늘리지 않음 → 주문 목록 안의 필드 이름까지 보이도록
  if (Array.isArray(obj)) return obj.length ? `[${shape(obj[0], depth)}] (${obj.length}건)` : '[] (0건)';
  if (!obj || typeof obj !== 'object') return typeof obj;
  if (depth > 3) return '{…}';
  return `{${Object.keys(obj)
    .slice(0, 40)
    .map((k) => (obj[k] && typeof obj[k] === 'object' ? `${k}:${shape(obj[k], depth + 1)}` : k))
    .join(', ')}}`;
}

module.exports = { pick, findArray, findCustomsCode, shape, isEmpty };
