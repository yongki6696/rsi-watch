import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from '../scripts/inline-assets.mjs';
import { makeAssetsFetcher } from '../src/static-assets.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const assets = makeAssetsFetcher(collect(PUBLIC));
const get = (p, headers = {}) => assets.fetch(new Request(`https://radar.example${p}`, { headers }));

test('묶어 넣은 화면 파일을 알맞은 종류로 내보낸다', async () => {
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(await home.text(), /최저가 레이더/);
  const sw = await get('/sw.js');
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
  const icon = await get('/icons/icon-192.png');
  assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await icon.arrayBuffer()), fs.readFileSync(path.join(PUBLIC, 'icons', 'icon-192.png')));
  assert.match((await get('/manifest.webmanifest')).headers.get('content-type'), /manifest\+json/);
});

test('앱 화면 주소는 첫 화면으로, 없는 파일은 404, 같은 파일은 304', async () => {
  const share = await get('/share?text=abc');
  assert.equal(share.status, 200);
  assert.match(await share.text(), /<title>최저가 레이더<\/title>/);
  assert.equal((await get('/nope.js')).status, 404);
  const first = await get('/app.js');
  const again = await get('/app.js', { 'If-None-Match': first.headers.get('etag') });
  assert.equal(again.status, 304);
});
