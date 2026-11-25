import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-store-'));
  return new Store(path.join(dir, 'db.json')).load();
}

test('같은 가격은 다시 기록하지 않고, 바뀔 때만 기록한다', () => {
  const s = tmpStore();
  const { product: p } = s.upsertProduct({ productId: '1' });
  assert.equal(s.recordPrice(p.id, 10000, 'fetch', 1000).changed, false); // 첫 기록
  assert.equal(s.recordPrice(p.id, 10000, 'fetch', 2000).point, null);
  const r = s.recordPrice(p.id, 9000, 'fetch', 3000);
  assert.equal(r.changed, true);
  assert.equal(r.prev, 10000);
  assert.deepEqual(s.history(p.id).map((x) => x.p), [10000, 9000]);
  assert.equal(s.getProduct(p.id).lastCheckedAt, 3000);
});

test('요약: 직전 대비 변동, 최저/최고가, 목표가 도달', () => {
  const s = tmpStore();
  const { product: p } = s.upsertProduct({ productId: '2' });
  s.recordPrice(p.id, 12000, 'fetch', 1);
  s.recordPrice(p.id, 15000, 'fetch', 2);
  s.recordPrice(p.id, 11000, 'fetch', 3);
  s.updateProduct(p.id, { targetPrice: 11500 });
  const sum = s.summary(s.getProduct(p.id));
  assert.equal(sum.price, 11000);
  assert.equal(sum.change, -4000);
  assert.equal(Math.round(sum.changePct), -27);
  assert.equal(sum.minPrice, 11000);
  assert.equal(sum.maxPrice, 15000);
  assert.equal(sum.changes, 2);
  assert.equal(sum.atTarget, true);
});

test('옵션 번호 없는 상품에 옵션 정보가 들어오면 하나로 합친다', () => {
  const s = tmpStore();
  const { product: a } = s.upsertProduct({ productId: '3' });
  s.recordPrice(a.id, 5000, 'fetch', 1);
  const { product: b, created } = s.upsertProduct({ productId: '3', itemId: '10', vendorItemId: '20' });
  assert.equal(created, false);
  assert.equal(s.products.length, 1);
  assert.equal(b.id, '3-10-20');
  assert.equal(s.history('3-10-20').length, 1);
  assert.match(b.url, /itemId=10&vendorItemId=20/);
});

test('사용자가 바꾼 이름은 자동 확인이 덮어쓰지 않는다', () => {
  const s = tmpStore();
  const { product: p } = s.upsertProduct({ productId: '4', name: '원래 이름' });
  s.updateProduct(p.id, { name: '내가 붙인 이름' });
  s.upsertProduct({ productId: '4', name: '쿠팡 이름' });
  assert.equal(s.getProduct(p.id).name, '내가 붙인 이름');
});

test('파일에 저장했다가 다시 읽는다', () => {
  const s = tmpStore();
  const { product: p } = s.upsertProduct({ productId: '5', name: '저장 테스트' });
  s.recordPrice(p.id, 7000, 'cart', 10);
  s.updateSettings({ intervalMinutes: 60, cartSync: true });
  s.flush();
  const again = new Store(s.file).load();
  assert.equal(again.products[0].name, '저장 테스트');
  assert.equal(again.history(p.id)[0].p, 7000);
  assert.equal(again.settings.intervalMinutes, 60);
  assert.equal(again.settings.cartSync, true);
});

test('잘못된 설정 값은 거절한다', () => {
  const s = tmpStore();
  assert.throws(() => s.updateSettings({ intervalMinutes: 1 }));
  assert.throws(() => s.updateSettings({ fetchMode: 'magic' }));
  const { product: p } = s.upsertProduct({ productId: '6' });
  assert.throws(() => s.updateProduct(p.id, { targetPrice: -5 }));
});
