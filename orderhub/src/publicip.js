'use strict';
// 이 서버의 공인 IP (마켓 API 에 등록하는 IP) - 10분 캐시
let cache = { ip: null, at: 0 };
const SOURCES = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com', 'https://checkip.amazonaws.com'];

async function detectPublicIp() {
  if (cache.ip && Date.now() - cache.at < 10 * 60000) return cache.ip;
  if (process.env.ORDERHUB_NO_IP_LOOKUP) return cache.ip; // 테스트 등 외부 조회를 막을 때
  for (const url of SOURCES) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'curl/8' } });
      const t = (await r.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t) || /^[0-9a-f:]+$/i.test(t)) {
        cache = { ip: t, at: Date.now() };
        return t;
      }
    } catch {}
  }
  return cache.ip;
}

// 외부 조회 없이 마지막으로 확인한 IP (없으면 null)
function cachedPublicIp() {
  return cache.ip;
}

// 테스트용
function setCachedPublicIp(ip) {
  cache = { ip, at: ip ? Date.now() : 0 };
}

module.exports = { detectPublicIp, cachedPublicIp, setCachedPublicIp };
