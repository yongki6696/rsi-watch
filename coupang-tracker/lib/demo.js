// 데모 모드: 쿠팡에 접속하지 않고 가상의 상품과 가격 변동을 만들어 화면을 체험해 본다.
const DAY = 24 * 60 * 60 * 1000;

const SAMPLES = [
  { name: '[데모] 무선 블루투스 이어폰 노이즈캔슬링', base: 89000, vol: 0.06, emoji: '🎧' },
  { name: '[데모] 원두 커피 1kg 미디엄 로스트', base: 23900, vol: 0.05, emoji: '☕' },
  { name: '[데모] 대용량 바디워시 1000ml x 2개', base: 15800, vol: 0.08, emoji: '🧴' },
  { name: '[데모] 탄산수 500ml x 20병', base: 11900, vol: 0.07, emoji: '🥤' },
  { name: '[데모] 러닝화 쿠셔닝 경량 운동화', base: 64900, vol: 0.09, emoji: '👟' },
  { name: '[데모] 무선 마우스 저소음', base: 19900, vol: 0.05, emoji: '🖱️' },
  { name: '[데모] 즉석밥 210g x 24개', base: 21900, vol: 0.04, emoji: '🍚' },
];

const round10 = (n) => Math.max(100, Math.round(n / 10) * 10);
const niceEnding = (n) => {
  // 9,900원 / 12,800원 같은 가격대로 다듬는다
  const step = n >= 50000 ? 1000 : n >= 10000 ? 100 : 10;
  const v = Math.round(n / step) * step;
  return Math.random() < 0.4 ? v - step / 10 : v;
};

function nextPrice(cur, base, vol) {
  const pull = (base - cur) / base * 0.4;            // 원래 가격으로 돌아가려는 힘
  const shock = (Math.random() * 2 - 1) * vol;
  let next = cur * (1 + pull + shock);
  if (Math.random() < 0.07) next = base * (0.72 + Math.random() * 0.1); // 가끔 특가
  return round10(niceEnding(Math.min(base * 1.35, Math.max(base * 0.6, next))));
}

export function createDemo({ store, now = Date.now(), days = 60, intervalMs = 20000 }) {
  SAMPLES.forEach((s, i) => {
    const productId = String(9000000001 + i);
    const { product } = store.upsertProduct(
      { productId, itemId: null, vendorItemId: null, name: s.name, inCart: i < 5 },
      { addedFrom: i < 5 ? 'cart' : 'url', now: now - days * DAY },
    );
    product.emoji = s.emoji;
    product.addedAt = now - days * DAY;
    if (i === 1) product.targetPrice = round10(s.base * 0.85);
    let t = now - days * DAY;
    let price = round10(niceEnding(s.base));
    store.recordPrice(product.id, price, 'demo', t);
    while (true) {
      t += (2 + Math.random() * 60) * 60 * 60 * 1000; // 2~62시간마다 변동
      if (t > now - 60 * 1000) break;
      price = nextPrice(price, s.base, s.vol);
      store.recordPrice(product.id, price, 'demo', t);
    }
    store.updateProduct(product.id, { lastCheckedAt: now });
    product.demoBase = s.base;
    product.demoVol = s.vol;
  });
  store.flush();

  return {
    intervalMs,
    /** 한 번 확인할 때마다 1~2개 상품의 가격이 바뀐다. */
    pickForTick(st) {
      const list = st.products.slice();
      const n = Math.min(list.length, 1 + Math.floor(Math.random() * 2));
      const picked = [];
      while (picked.length < n && list.length) picked.push(list.splice(Math.floor(Math.random() * list.length), 1)[0]);
      return picked;
    },
    priceFor(p, st) {
      const s = st.summary(p);
      const base = p.demoBase || s.firstPrice || s.price || 10000;
      const cur = s.price || base;
      let next = nextPrice(cur, base, p.demoVol || 0.06);
      if (next === cur) next = round10(cur * (Math.random() < 0.5 ? 0.97 : 1.03));
      return { price: next };
    },
  };
}
