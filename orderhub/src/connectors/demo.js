'use strict';
// 데모 스토어 - API 키 없이 화면과 흐름을 체험하기 위한 가짜 주문 생성기
const crypto = require('node:crypto');

const NAMES = ['김민준', '이서연', '박지호', '최수아', '정예준', '강하은', '조도윤', '윤지우', '장서준', '임하린', '한지민', '오세훈'];
const ADDRS = [
  ['06236', '서울특별시 강남구 테헤란로 152', '강남파이낸스센터 21층'],
  ['04524', '서울특별시 중구 세종대로 110', '3층 민원실'],
  ['13529', '경기도 성남시 분당구 판교역로 166', '카카오 판교아지트 A동'],
  ['48058', '부산광역시 해운대구 센텀중앙로 79', '센텀사이언스파크 1203호'],
  ['35209', '대전광역시 서구 둔산로 100', '둔산빌딩 7층'],
  ['61945', '광주광역시 서구 내방로 111', '102동 1004호'],
  ['22004', '인천광역시 연수구 컨벤시아대로 165', '포스코타워 15층'],
];
const PRODUCTS = [
  ['무선 블루투스 이어폰 노이즈캔슬링', ['화이트', '블랙', '네이비'], 39900],
  ['스테인리스 진공 텀블러 600ml', ['실버', '로즈골드', '매트블랙'], 18900],
  ['초경량 접이식 캠핑의자', ['카키', '베이지'], 45000],
  ['국내산 햇 고춧가루 1kg', ['보통맛', '매운맛'], 32000],
  ['프리미엄 극세사 차렵이불 Q', ['그레이', '아이보리', '핑크'], 59000],
  ['USB-C 고속충전 케이블 2m 2개입', ['C to C', 'C to 8핀'], 12900],
  ['유아 실리콘 이유식 식기세트', ['민트', '옐로우'], 24800],
  ['해외직구 비타민D 5000IU 360정', ['1병', '2병'], 27500],
];
const MEMOS = ['문 앞에 놓아주세요', '부재 시 경비실에 맡겨주세요', '배송 전 연락 부탁드립니다', '', '', '빠른 배송 부탁드려요'];

let rng = Math.random;
function pick(arr) {
  return arr[Math.floor(rng() * arr.length)];
}
function randomInt(min, max) {
  return rng === Math.random ? crypto.randomInt(min, max) : min + Math.floor(rng() * (max - min));
}
// 같은 날짜·번호면 항상 같은 주문이 나오도록(지난 주문을 여러 번 불러와도 중복/변동 없음)
function seeded(text) {
  let a = 0;
  for (const ch of text) a = (Math.imul(a ^ ch.charCodeAt(0), 2654435761) + 1) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeOrder(seq, minutesAgo = 0, fixedNo = null) {
  const now = Date.now() - minutesAgo * 60000;
  const orderNo = fixedNo || `DEMO${new Date(now).toISOString().slice(2, 10).replace(/-/g, '')}${String(seq).padStart(4, '0')}${randomInt(10, 99)}`;
  const name = pick(NAMES);
  const receiver = rng() < 0.8 ? name : pick(NAMES);
  const [zip, a1, a2] = pick(ADDRS);
  const itemCount = rng() < 0.2 ? 2 : 1;
  const items = [];
  let total = 0;
  for (let i = 0; i < itemCount; i++) {
    const [pname, opts, price] = pick(PRODUCTS);
    const qty = rng() < 0.75 ? 1 : 2;
    total += price * qty;
    items.push({
      itemKey: `${orderNo}-${i + 1}`,
      orderNo,
      productName: pname,
      optionName: pick(opts),
      quantity: qty,
      unitPrice: price,
      amount: price * qty,
      productCode: `SKU-${randomInt(1000, 9999)}`,
      productId: String(randomInt(100000, 999999)),
      marketState: 'NEW',
      marketStatus: '결제완료',
      claim: null,
      extra: { demo: true },
      raw: { demo: true },
    });
  }
  const phone = `010-${randomInt(1000, 9999)}-${randomInt(1000, 9999)}`;
  const overseas = items.some((i) => i.productName.startsWith('해외직구'));
  return {
    groupKey: orderNo,
    orderNo,
    orderedAt: new Date(now - 60000).toISOString(),
    paidAt: new Date(now).toISOString(),
    shipDue: new Date(now + 2 * 86400000).toISOString(),
    ordererName: name,
    ordererPhone: phone,
    receiverName: receiver,
    receiverPhone: receiver === name ? phone : `010-${randomInt(1000, 9999)}-${randomInt(1000, 9999)}`,
    receiverPhone2: '',
    zipcode: zip,
    address1: a1,
    address2: a2,
    deliveryMemo: pick(MEMOS),
    customsCode: overseas ? `P${randomInt(100000, 999999)}${randomInt(100000, 999999)}` : '',
    shippingFee: total >= 30000 ? 0 : 3000,
    items,
  };
}

// 지난 주문(매출 체험용): 하루 1~5건, 대부분 배송완료 + 가끔 취소
function pastOrders(days) {
  const out = [];
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  for (let back = days; back >= 1; back--) {
    const date = new Date(Date.parse(`${today}T00:00:00Z`) - back * 86400000).toISOString().slice(0, 10);
    rng = seeded(date);
    const count = 1 + Math.floor(rng() * 5);
    for (let n = 1; n <= count; n++) {
      rng = seeded(`${date}-${n}`);
      const paidAt = Date.parse(`${date}T09:00:00+09:00`) + Math.floor(rng() * 12 * 3600000);
      const minutesAgo = (Date.now() - paidAt) / 60000;
      const g = makeOrder(n, minutesAgo, `DEMOP${date.replace(/-/g, '')}${n}`);
      const r = rng();
      const [state, label] = r < 0.08 ? ['CANCELED', '취소'] : back <= 2 ? ['SHIPPED', '배송중'] : ['DELIVERED', '배송완료'];
      for (const it of g.items) {
        it.marketState = state;
        it.marketStatus = label;
      }
      out.push(g);
    }
  }
  rng = Math.random;
  return out;
}

module.exports = {
  type: 'demo',
  label: '데모 스토어',
  short: 'D',
  color: '#7c5cff',
  beta: false,
  inquiries: true,
  answerable: true,
  backfill: true,
  fields: [],
  guide: [
    'API 키 없이 화면과 처리 흐름을 체험할 수 있는 가상 스토어입니다.',
    '처음 연결하면 예시 주문이 생기고, [지금 수집]을 누를 때마다 새 주문이 1건씩 들어옵니다.',
    '발주확인·발송처리는 실제 마켓으로 전송되지 않습니다. 체험 후 삭제하세요.',
  ],

  async test() {
    return { ok: true, message: '데모 스토어는 항상 연결되어 있습니다' };
  },

  async fetch(ctx) {
    const state = { ...(ctx.state || {}) };
    if (ctx.backfillDays) return { groups: pastOrders(ctx.backfillDays), state };
    const groups = [];
    let seq = state.seq || 0;
    if (!state.initialized) {
      for (let i = 0; i < 5; i++) groups.push(makeOrder(++seq, (5 - i) * 37));
      state.initialized = true;
    } else if (ctx.manual) {
      groups.push(makeOrder(++seq, 0));
    }
    state.seq = seq;
    return { groups, state };
  },

  async confirm(ctx, order, items) {
    return { ok: items.map((i) => i.itemKey), failed: [] };
  },

  async fetchInquiries(ctx) {
    const samples = [
      ['배송', '배송 문의', '오늘 주문하면 언제 받을 수 있을까요? 주말 전에 받고 싶어요.'],
      ['상품', '', '화이트 색상 재입고 예정 있나요?'],
      ['교환', '사이즈 교환', '받아보니 생각보다 작네요. 한 사이즈 큰 걸로 교환 가능할까요?'],
    ];
    const make = (i) => {
      const [category, title, content] = samples[i % samples.length];
      return {
        key: `demo-q-${Date.now()}-${i}`,
        kind: category === '상품' ? 'product' : 'customer',
        category,
        title,
        content,
        productName: pick(PRODUCTS)[0],
        orderNo: '',
        writer: pick(NAMES),
        askedAt: new Date().toISOString(),
        answered: false,
        answer: '',
        extra: { demo: true },
      };
    };
    if (ctx.firstSync) return [make(0), make(1)];
    if (ctx.manual && Math.random() < 0.5) return [make(randomInt(0, 3))];
    return [];
  },

  async answerInquiry() {
    return { ok: true };
  },

  async dispatch(ctx, order, items, { trackingNo }) {
    if (!/^\d{8,14}$/.test(String(trackingNo).replace(/-/g, ''))) {
      return { ok: [], failed: items.map((i) => ({ itemKey: i.itemKey, message: '데모: 송장번호는 숫자 8~14자리로 입력해주세요' })) };
    }
    return { ok: items.map((i) => i.itemKey), failed: [] };
  },

  _internal: { makeOrder, pastOrders },
};
