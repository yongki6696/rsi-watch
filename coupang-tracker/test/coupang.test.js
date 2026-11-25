import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoupangInput, extractFromHtml, looksBlocked, cleanTitle } from '../lib/coupang.js';
import { buildBookmarklet } from '../lib/extractor.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name, price = '12,000') => fs.readFileSync(path.join(dir, name), 'utf8').replaceAll('{{PRICE}}', price);

test('상품 링크에서 상품/옵션 번호를 뽑는다', () => {
  assert.deepEqual(
    parseCoupangInput('https://www.coupang.com/vp/products/7335597976?itemId=18741704367&vendorItemId=85873964906&q=abc'),
    { productId: '7335597976', itemId: '18741704367', vendorItemId: '85873964906' },
  );
  assert.deepEqual(parseCoupangInput('https://m.coupang.com/vm/products/123456?vendorItemId=9'), { productId: '123456', itemId: null, vendorItemId: '9' });
  assert.deepEqual(parseCoupangInput('coupang.com/vp/products/555555'), { productId: '555555', itemId: null, vendorItemId: null });
  assert.deepEqual(parseCoupangInput('7335597976'), { productId: '7335597976', itemId: null, vendorItemId: null });
});

test('앱 공유 문구 속 링크도 찾는다', () => {
  const shared = '[쿠팡] 무선 이어폰 블랙\nhttps://www.coupang.com/vp/products/99887766?itemId=1&vendorItemId=2 쿠팡에서 확인하세요';
  assert.equal(parseCoupangInput(shared).productId, '99887766');
  assert.deepEqual(parseCoupangInput('링크: https://link.coupang.com/a/bXyZ12'), { shortUrl: 'https://link.coupang.com/a/bXyZ12' });
});

test('쿠팡이 아닌 링크나 잘못된 입력은 거절한다', () => {
  assert.equal(parseCoupangInput('https://example.com/vp/products/123'), null);
  assert.equal(parseCoupangInput('https://www.coupang.com/np/search?q=물'), null);
  assert.equal(parseCoupangInput(''), null);
  assert.equal(parseCoupangInput('그냥 글자'), null);
});

test('예전 쿠팡 상세 페이지 구조에서 판매가를 읽는다', () => {
  const info = extractFromHtml(fixture('product-classic.html', '12,000'));
  assert.equal(info.price, 12000);
  assert.equal(info.name, '테스트 상품 A 대용량 500ml x 3개');
  assert.equal(info.image, 'https://thumbnail.example.test/a.jpg');
  assert.match(info.strategy, /prod-sale-price/);
  assert.equal(info.soldOut, false);
});

test('구조화 데이터(JSON-LD)가 있으면 그것을 우선한다', () => {
  const info = extractFromHtml(fixture('product-ldjson.html'));
  assert.equal(info.price, 8900);
  assert.equal(info.strategy, 'json-ld');
  assert.equal(info.name, '구조화 데이터 상품');
});

test('알 수 없는 구조에서는 가격을 지어내지 않는다 (브라우저 확인으로 넘김)', () => {
  const info = extractFromHtml(fixture('product-generic.html', '25,900'));
  assert.equal(info.price, null);
});

test('아카마이 차단 페이지를 알아본다', () => {
  assert.equal(looksBlocked(200, fixture('blocked.html')), true);
  assert.equal(looksBlocked(403, ''), true);
  assert.equal(looksBlocked(200, fixture('product-classic.html')), false);
});

test('상품명 뒤의 쿠팡 꼬리표를 지운다', () => {
  assert.equal(cleanTitle('상품 이름 - 생활용품 | 쿠팡'), '상품 이름');
  assert.equal(cleanTitle('상품 이름 | 쿠팡'), '상품 이름');
  assert.equal(cleanTitle('상품-이름 세트'), '상품-이름 세트');
});

test('북마클릿은 한 줄이고 휴대폰 주소창에서 깨지는 글자가 없다', () => {
  const code = buildBookmarklet('http://192.168.0.10:3000/');
  assert.ok(code.startsWith('javascript:(function(){'));
  assert.ok(!code.includes('\n'));
  assert.ok(!/[%#]/.test(code));
  assert.ok(code.includes('"http://192.168.0.10:3000"'));
  // 문법 검사 (실행은 하지 않음)
  assert.doesNotThrow(() => new Function(code.slice('javascript:'.length)));
});
