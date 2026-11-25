import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, normalizeKeyword, keywordFromName, cleanName, isShortLink } from '../src/parse.js';

test('쿠팡 앱 공유 문구에서 상품 번호와 이름을 뽑는다', () => {
  const r = parseInput('[쿠팡] 탐사 샘물 2L 12개 https://www.coupang.com/vp/products/7335597976?itemId=18741704367&vendorItemId=85873964906');
  assert.equal(r.productId, '7335597976');
  assert.equal(r.name, '탐사 샘물 2L 12개');
  assert.equal(r.url, 'https://www.coupang.com/vp/products/7335597976');
});

test('모바일 주소, 짧은 링크, 숫자만, 이름만', () => {
  assert.equal(parseInput('https://m.coupang.com/vm/products/123456?vendorItemId=9').productId, '123456');
  const s = parseInput('쿠팡을 추천합니다! 무선 이어폰 https://link.coupang.com/a/bXyZ12');
  assert.equal(s.productId, null);
  assert.equal(s.shortUrl, 'https://link.coupang.com/a/bXyZ12');
  assert.equal(s.name, '무선 이어폰');
  assert.equal(parseInput('7335597976').productId, '7335597976');
  const n = parseInput('  생수 2L  ');
  assert.equal(n.productId, null);
  assert.equal(n.name, '생수 2L');
});

test('쿠팡이 아닌 링크는 상품으로 보지 않는다', () => {
  const r = parseInput('https://example.com/vp/products/123 좋은 물건');
  assert.equal(r.productId, null);
  assert.equal(r.name, '좋은 물건');
  assert.equal(isShortLink('https://evil.example/a/x'), false);
  assert.equal(isShortLink('https://link.coupang.com/a/x'), true);
});

test('검색어 정규화와 상품명 줄이기', () => {
  assert.equal(normalizeKeyword('  Apple   AirPods  Pro '), 'apple airpods pro');
  assert.equal(keywordFromName('[로켓배송] 탐사 샘물, 2L, 12개 (무라벨)'), '탐사 샘물 2L 12개');
  assert.equal(keywordFromName('아주 긴 상품명 '.repeat(8)).length <= 40, true);
  assert.ok(keywordFromName('아주아주긴상품명'.repeat(10)).length <= 40);
  assert.equal(cleanName('쿠팡에서 확인해 보세요! '), null);
});
