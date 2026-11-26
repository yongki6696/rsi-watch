// public/ 폴더의 화면 파일을 Worker 코드 안에 묶어 넣는다 (wrangler.cli.jsonc 로 직접 배포할 때 사용)
//   npm run build:inline  →  src/assets.gen.js 생성 (자동 생성 파일이라 git 에는 올리지 않음)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const TEXT = new Set(['.html', '.js', '.css', '.svg', '.webmanifest', '.json', '.txt']);

export function collect(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const rel = `/${path.relative(dir, p).split(path.sep).join('/')}`;
      const ext = path.extname(e.name).toLowerCase();
      const buf = fs.readFileSync(p);
      out[rel] = {
        type: TYPES[ext] || 'application/octet-stream',
        etag: `"${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)}"`,
        ...(TEXT.has(ext) ? { text: buf.toString('utf8') } : { b64: buf.toString('base64') }),
      };
    }
  };
  walk(dir);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = collect(path.join(ROOT, 'public'));
  fs.writeFileSync(path.join(ROOT, 'src', 'assets.gen.js'), `// 자동 생성 파일 (npm run build:inline) — 직접 고치지 마세요\nexport const FILES = ${JSON.stringify(files)};\n`);
  console.log(`화면 파일 ${Object.keys(files).length}개를 묶었어요.`);
}
