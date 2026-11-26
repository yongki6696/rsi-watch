// Worker 안에 묶어 넣은 화면 파일을 내보낸다 (Cloudflare 정적 파일 기능 대신 쓸 때)
export function makeAssetsFetcher(files) {
  const decoded = new Map();
  const body = (f, key) => {
    if (f.text !== undefined) return f.text;
    if (!decoded.has(key)) decoded.set(key, Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
    return decoded.get(key);
  };
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let p;
      try { p = decodeURIComponent(url.pathname); } catch { p = url.pathname; }
      if (p.endsWith('/')) p += 'index.html';
      let key = p;
      let f = files[key];
      if (!f && !/\.[a-z0-9]+$/i.test(p)) { key = '/index.html'; f = files[key]; } // 앱 화면 주소(/share 등)는 첫 화면으로
      if (!f) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      const longCache = key.startsWith('/vendor/') || key.startsWith('/icons/');
      const headers = {
        'Content-Type': f.type,
        ETag: f.etag,
        'Cache-Control': longCache ? 'public, max-age=86400' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      };
      if (request.headers.get('If-None-Match') === f.etag) return new Response(null, { status: 304, headers });
      return new Response(request.method === 'HEAD' ? null : body(f, key), { status: 200, headers });
    },
  };
}
