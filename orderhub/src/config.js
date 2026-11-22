'use strict';
// 환경변수 설정. .env 파일이 있으면 읽는다(의존성 없이 간단 파서).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

const env = process.env;

const config = {
  root: ROOT,
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  secretKey: env.SECRET_KEY || '',
  adminPassword: env.ADMIN_PASSWORD || '',
  // 리버스 프록시(Caddy 등) 뒤에서 실행할 때만 true (docker-compose 에서 설정)
  // 직접 노출된 서버에서 켜면 IP 위조로 로그인 시도 제한을 우회할 수 있음
  trustProxy: env.TRUST_PROXY === 'true',
  // 테스트용으로 마켓 API 주소를 바꿀 수 있다
  naverApiBase: env.NAVER_API_BASE || 'https://api.commerce.naver.com/external',
  coupangApiBase: env.COUPANG_API_BASE || 'https://api-gateway.coupang.com',
  elevenstApiBase: env.ELEVENST_API_BASE || 'https://api.11st.co.kr/rest',
  telegramApiBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org',
  disableScheduler: env.DISABLE_SCHEDULER === 'true',
  logLevel: env.LOG_LEVEL || 'info',
};

module.exports = config;
