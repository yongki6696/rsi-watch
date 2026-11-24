'use strict';
// 11번가 - 셀러 Open API (https://openapi.11st.co.kr)
// 인증: 요청 헤더 openapikey / 응답: XML (EUC-KR)
// 주문 수집: 결제완료(발주확인할 내역) / 배송준비중(발송처리할 내역) / 취소요청 목록
//   + 30분마다 배송중·배송완료 목록, 지난 주문 불러오기는 구매확정까지 (조회기간은 최대 7일씩)
const net = require('node:net');
const tls = require('node:tls');
const nodeHttp = require('node:http');
const { request, decodeText, openTunnel, parseProxy } = require('./http');
const { kstCompact, toIso, toInt, str, sleep } = require('../util');
const { courierCode } = require('../couriers');

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

// 평평한 XML 요소(<a>값</a>)들을 객체로
function parseFlat(xml) {
  const obj = {};
  const re = /<(?:[A-Za-z0-9_]+:)?([A-Za-z0-9_]+)(?:\s[^>]*)?>([^<]*(?:<!\[CDATA\[[\s\S]*?\]\]>[^<]*)*)<\/(?:[A-Za-z0-9_]+:)?\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (!(m[1] in obj)) obj[m[1]] = decodeEntities(m[2]).trim();
  }
  return obj;
}

// 반복 요소(<ns2:order>…</ns2:order>) 추출
function parseList(xml, tag) {
  const out = [];
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(parseFlat(m[1]));
  return out;
}

function resultOf(xml) {
  const code = (xml.match(/<(?:[A-Za-z0-9_]+:)?result_code>\s*([^<]*?)\s*</) || [])[1];
  const text =
    (xml.match(/<(?:[A-Za-z0-9_]+:)?result_text>([\s\S]*?)</) || [])[1] ||
    (xml.match(/<(?:[A-Za-z0-9_]+:)?result_message>([\s\S]*?)</) || [])[1] ||
    '';
  return { code: code === undefined ? null : code, text: decodeEntities(text || '').trim() };
}

const ERROR_CODES = new Set(['-1', '2', '1000', '-1000']);

async function api(ctx, path, attempt = 0) {
  const key = ctx.creds.apiKey;
  if (!key) throw new Error('11번가 Open API Key를 입력해주세요');
  const proxy = str(ctx.creds.proxy) || undefined;
  let res;
  try {
    res = await request(ctx.config.elevenstApiBase + path, {
      method: 'GET',
      headers: { openapikey: key, Accept: 'application/xml, text/xml' },
      proxy,
    });
  } catch (e) {
    if (e.proxy) throw e; // 중계 서버 자체 문제는 그 안내 그대로
    // 11번가는 등록되지 않은 IP(또는 해외 IP)의 접속을 연결 단계에서 끊어버림 (HTTP 오류가 아니라 연결 끊김으로 나타남)
    if (e.network && /ECONNRESET|UND_ERR_SOCKET|ETIMEDOUT|CONNECT_TIMEOUT|ECONNREFUSED|EPIPE|TimeoutError/i.test(e.message)) {
      const relay = proxy ? parseProxy(proxy).host : null;
      const err = new Error(
        relay
          ? `11번가가 국내 중계 서버(${relay})의 접속을 막았습니다. 11번가 OPEN API CENTER → API 관리 → 'IP 직접 입력'의 개발서버 IP·개발자 PC·상용서버 IP 세 칸 모두에 중계 서버 IP ${relay} 를 세미콜론(;)으로 이어 적고 [수정하기]를 눌러주세요. 반영까지 시간이 걸릴 수 있습니다. (${e.message})`
          : `11번가가 이 서버의 접속을 막았습니다. 11번가 OPEN API CENTER → API 관리 → 'IP 직접 입력'의 세 칸(개발서버 IP·개발자 PC·상용서버 IP)에 [스토어] 화면 맨 위의 서버 IP를 띄어쓰기 없이 세미콜론(;)으로 이어 적고 [수정하기]를 눌러주세요. 오더허브 서버가 해외(예: 오라클 일본)에 있으면 11번가가 해외 IP를 막기 때문에 '국내 중계 서버'가 필요합니다 (안내서 참고). (${e.message})`
      );
      err.network = true;
      throw err;
    }
    throw e;
  }
  const xml = decodeText(res.buffer, res.headers, 'euc-kr');
  if (res.status === 429 && attempt < 3) {
    await sleep(1500 * (attempt + 1));
    return api(ctx, path, attempt + 1);
  }
  if (!res.ok) {
    const r = resultOf(xml);
    const hint = res.status === 401 || res.status === 403 ? ' (API Key 또는 등록된 서버 IP를 확인해주세요)' : '';
    throw new Error(`11번가 API 오류 (HTTP ${res.status})${hint}: ${r.text || xml.slice(0, 200)}`);
  }
  const r = resultOf(xml);
  if (r.code !== null && ERROR_CODES.has(r.code)) {
    throw new Error(`11번가 API 오류 (${r.code}): ${r.text || '알 수 없는 오류'}`);
  }
  return xml;
}

// 연결이 끊길 때 어느 단계에서 막히는지 확인 (키는 보내지 않음)
function probeTcp(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 8000 });
    s.on('connect', () => (s.destroy(), resolve('연결됨')));
    s.on('timeout', () => (s.destroy(), resolve('시간 초과')));
    s.on('error', (e) => resolve(`실패 (${e.code || e.message})`));
  });
}
function probeTls(host, port) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port, servername: host, timeout: 8000 }, () => {
      const r = `성공 (${s.getProtocol()}, ${s.getCipher()?.name || '?'})`;
      s.destroy();
      resolve(r);
    });
    s.on('timeout', () => (s.destroy(), resolve('시간 초과')));
    s.on('error', (e) => resolve(`실패 (${e.code || e.message})`));
  });
}
function probeHttp(host, port, path) {
  return new Promise((resolve) => {
    const req = nodeHttp.request({ host, port, path, method: 'GET', timeout: 8000 }, (r) => {
      r.resume();
      resolve(`응답 있음 (HTTP ${r.statusCode})`);
    });
    req.on('timeout', () => (req.destroy(), resolve('시간 초과')));
    req.on('error', (e) => resolve(`실패 (${e.code || e.message})`));
    req.end();
  });
}
async function connectionReport(baseUrl, proxy) {
  const u = new URL(baseUrl);
  const host = u.hostname;
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  if (proxy) {
    const p = parseProxy(proxy);
    const lines = [`대상: ${host} (국내 중계 서버 ${p.label} 경유)`];
    const relayTcp = await probeTcp(p.host, p.port);
    lines.push(`① 중계 서버 연결(TCP ${p.port}): ${relayTcp}`);
    if (relayTcp !== '연결됨') {
      lines.push('→ 중계 서버에 연결이 안 됩니다. 중계 서버 IP와 방화벽(포트), 서버가 켜져 있는지 확인해주세요.');
      return lines.join('\n');
    }
    let socket;
    try {
      socket = await openTunnel(p, host, port, 10000);
      lines.push('② 중계 서버 → 11번가 연결: 성공');
    } catch (e) {
      lines.push(`② 중계 서버 → 11번가 연결: 실패 (${e.proxyStatus ? `HTTP ${e.proxyStatus}` : e.code || e.message})`);
      lines.push(e.proxyStatus === 403 ? '→ 중계 서버가 이 오더허브 서버를 허용하지 않았습니다. 중계 서버 설치 때 넣은 오더허브 IP를 확인해주세요.' : '→ 중계 서버에서 11번가로 연결하지 못했습니다.');
      return lines.join('\n');
    }
    if (u.protocol === 'https:') {
      const tlsr = await new Promise((resolve) => {
        const s = tls.connect({ socket, servername: host, timeout: 8000 }, () => {
          const r = `성공 (${s.getProtocol()})`;
          s.destroy();
          resolve(r);
        });
        s.on('timeout', () => (s.destroy(), resolve('시간 초과')));
        s.on('error', (e) => resolve(`실패 (${e.code || e.message})`));
      });
      lines.push(`③ 보안 연결(TLS): ${tlsr}`);
      lines.push(tlsr.startsWith('성공') ? '→ 연결은 되는데 API 요청이 거부됩니다. 11번가 IP 칸에 중계 서버 IP가 등록·반영됐는지 확인해주세요.' : '→ 11번가가 중계 서버 IP를 막고 있습니다. 11번가 IP 칸에 중계 서버 IP를 등록하고 반영될 때까지 기다려주세요.');
    } else socket.destroy();
    return lines.join('\n');
  }
  const lines = [`대상: ${host}`];
  if (u.protocol === 'https:') {
    const port = Number(u.port) || 443;
    const tcp = await probeTcp(host, port);
    lines.push(`① 서버 연결(TCP ${port}): ${tcp}`);
    const tlsr = tcp === '연결됨' ? await probeTls(host, port) : '건너뜀';
    lines.push(`② 보안 연결(TLS): ${tlsr}`);
    lines.push(`③ HTTP 80 (키 없이): ${await probeHttp(host, 80, '/rest/')}`);
    if (tcp !== '연결됨') lines.push('→ 11번가 서버까지 연결 자체가 안 됩니다. IP 차단 또는 네트워크 문제입니다.');
    else if (!tlsr.startsWith('성공')) lines.push('→ 보안 연결 단계에서 끊깁니다. 11번가 방화벽이 이 서버 IP를 막고 있을 가능성이 큽니다.');
    else lines.push('→ 연결은 되지만 API 요청을 보내면 끊깁니다. 11번가가 IP를 확인하고 막은 것입니다 (IP 등록이 아직 반영되지 않음).');
  } else {
    lines.push(`서버 연결(TCP ${Number(u.port) || 80}): ${await probeTcp(host, Number(u.port) || 80)}`);
  }
  return lines.join('\n');
}

const pick = (o, ...keys) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== '' && o[k] !== 'null') return o[k];
  return '';
};

function findCustoms(o) {
  const direct = pick(o, 'psnCscUniqNo', 'prsnCstmsClrnNo', 'cstmsClrnNo', 'customsCode', 'psnCstmsUniqNo');
  if (direct) return direct;
  for (const v of Object.values(o)) if (/^P\d{12}$/.test(String(v))) return String(v);
  return '';
}

function normalizeOrder(o, state, label) {
  const ordNo = pick(o, 'ordNo');
  const seq = pick(o, 'ordPrdSeq');
  const realDlvNo = pick(o, 'dlvNo');
  const dlvNo = realDlvNo || `${ordNo}`;
  const qty = toInt(pick(o, 'ordQty', 'ordCnt'), 1);
  return {
    groupKey: String(dlvNo),
    orderNo: String(ordNo),
    orderedAt: toIso(pick(o, 'ordDt', 'ordStlDt')),
    paidAt: toIso(pick(o, 'ordStlEndDt', 'ordDt')),
    shipDue: toIso(pick(o, 'dlvSndDue', 'delaySendDt')),
    ordererName: pick(o, 'ordNm', 'memNm'),
    ordererPhone: pick(o, 'ordPrtblTel', 'ordTlphnNo'),
    receiverName: pick(o, 'rcvrNm'),
    receiverPhone: pick(o, 'rcvrPrtblNo', 'rcvrTlphn'),
    receiverPhone2: pick(o, 'rcvrPrtblNo') ? pick(o, 'rcvrTlphn') : '',
    zipcode: pick(o, 'rcvrMailNo'),
    address1: pick(o, 'rcvrBaseAddr'),
    address2: pick(o, 'rcvrDtlsAddr'),
    deliveryMemo: pick(o, 'ordDlvReqCont', 'dlvReqCont'),
    customsCode: findCustoms(o),
    shippingFee: toInt(pick(o, 'dlvCst'), 0),
    items: [
      {
        itemKey: `${ordNo}-${seq}`,
        orderNo: String(ordNo),
        productName: pick(o, 'prdNm'),
        optionName: pick(o, 'slctPrdOptNm', 'optNm'),
        quantity: qty,
        unitPrice: toInt(pick(o, 'selPrc')),
        amount: toInt(pick(o, 'ordPayAmt', 'ordAmt')),
        productCode: pick(o, 'sellerPrdCd', 'sellerStockCd'),
        productId: pick(o, 'prdNo'),
        marketState: state,
        marketStatus: label,
        claim: null,
        extra: {
          ordNo: String(ordNo),
          ordPrdSeq: String(seq),
          addPrdYn: pick(o, 'addPrdYn') || 'N',
          addPrdNo: pick(o, 'addPrdNo') || 'null',
          dlvNo: String(dlvNo),
          hasDlvNo: !!realDlvNo,
        },
        raw: o,
      },
    ],
  };
}

function mergeGroups(list) {
  const map = new Map();
  const partials = [];
  for (const g of list) {
    if (g.partial) {
      partials.push(g);
      continue;
    }
    if (!map.has(g.groupKey)) map.set(g.groupKey, { ...g, items: [] });
    const target = map.get(g.groupKey);
    for (const it of g.items) {
      const idx = target.items.findIndex((x) => x.itemKey === it.itemKey);
      if (idx >= 0) target.items[idx] = it;
      else target.items.push(it);
    }
  }
  return [...map.values(), ...partials];
}

// 상태별 주문 목록 (경로 · 상태 · 표시 이름)
const LISTS = {
  complete: ['NEW', '결제완료'],
  packaging: ['CONFIRMED', '배송준비중'],
  shipping: ['SHIPPED', '배송중'],
  dlvcompleted: ['DELIVERED', '배송완료'],
  completed: ['DELIVERED', '구매확정'],
};

// 최대 조회기간(7일) 이하 구간으로 나눔
function weekWindows(days, now = Date.now()) {
  const out = [];
  for (let back = days; back > 0; back -= 7) {
    const from = now - back * 86400000;
    const to = Math.min(now, from + 7 * 86400000 - 60000);
    out.push({ start: kstCompact(new Date(from)), end: kstCompact(new Date(to)) });
  }
  return out;
}

async function fetchStatusList(ctx, name, start, end) {
  const [state, label] = LISTS[name];
  const xml = await api(ctx, `/ordservices/${name}/${start}/${end}`);
  return parseList(xml, 'order').map((o) => {
    const g = normalizeOrder(o, state, label);
    // 배송중 목록처럼 상품·배송번호 없이 오는 목록은 이미 있는 주문의 상태만 갱신
    if (!pick(o, 'prdNm') || (name === 'shipping' && !pick(o, 'dlvNo'))) g.partial = true;
    return g;
  });
}

// 같은 상품이 여러 목록에 보이면 나중(더 진행된) 것으로, 묶음번호는 실제 배송번호를 우선
function collapse(list) {
  const latest = new Map();
  const realDlv = new Map();
  for (const g of list) {
    for (const it of g.items) {
      if (it.extra?.hasDlvNo) realDlv.set(it.itemKey, it.extra.dlvNo);
      latest.set(it.itemKey, { group: g, item: it });
    }
  }
  const out = new Map();
  const partials = [];
  for (const [key, { group, item }] of latest) {
    if (group.partial) {
      partials.push({ ...group, items: [item] });
      continue;
    }
    const gk = realDlv.get(key) || group.groupKey;
    if (!out.has(gk)) out.set(gk, { ...group, groupKey: gk, items: [] });
    out.get(gk).items.push({ ...item, extra: { ...item.extra, dlvNo: gk } });
  }
  return [...out.values(), ...partials];
}

// 지난 주문 불러오기: 결제완료~구매확정 목록을 7일씩 + 취소완료
async function backfill(ctx) {
  const state = { ...(ctx.state || {}) };
  const list = [];
  const warnings = [];
  const windows = weekWindows(ctx.backfillDays);
  for (const name of Object.keys(LISTS)) {
    try {
      for (const w of windows) list.push(...(await fetchStatusList(ctx, name, w.start, w.end)));
    } catch (e) {
      if (e.network || /HTTP 40[13]/.test(e.message)) throw e;
      warnings.push(`${LISTS[name][1]} 조회 실패: ${e.message}`);
    }
  }
  if (warnings.length === Object.keys(LISTS).length) throw new Error(warnings.join(' / '));
  try {
    for (const w of windows) {
      const xml = await api(ctx, `/claimservice/canceledorders/${w.start}/${w.end}`);
      for (const c of parseList(xml, 'order')) {
        const g = normalizeOrder(c, 'CANCELED', '취소완료');
        g.partial = true;
        list.push(g);
      }
    }
  } catch (e) {
    if (e.network) throw e;
    warnings.push(`취소완료 조회 실패: ${e.message}`);
  }
  return { groups: collapse(list), state, warnings };
}

const meta = {
  type: 'elevenst',
  label: '11번가',
  short: '11',
  color: '#ff0038',
  beta: true,
  inquiries: false,
  backfill: true,
  sellerCenter: 'https://soffice.11st.co.kr/',
  fields: [
    { key: 'apiKey', label: 'Open API Key', required: true, secret: true },
    { key: 'proxy', label: '국내 중계 서버 (오더허브 서버가 해외에 있을 때만)', placeholder: '중계 서버 IP (예: 3.35.123.45) - 국내 서버면 비워두세요' },
  ],
  guide: [
    '11번가 OPEN API CENTER(openapi.11st.co.kr) → API 관리에서 API KEY를 확인합니다. (샵모아 등에서 쓰는 키를 그대로 써도 됩니다)',
    "같은 화면 'IP 직접 입력'의 개발서버 IP·개발자 PC·상용서버 IP 세 칸 모두에 아래 표시된 이 서버의 IP를 추가하고 [수정하기]를 누릅니다. 이미 다른 IP가 있으면 띄어쓰기 없이 세미콜론(;)으로 이어 적습니다. 예) 1.2.3.4;5.6.7.8",
    '11번가는 IP가 등록되지 않으면 접속 자체를 끊습니다. 등록 후 반영까지 시간이 걸릴 수 있습니다.',
    '11번가는 해외 IP를 막습니다. 오더허브 서버가 해외(예: 오라클 일본)에 있으면 국내 중계 서버를 만들어 아래 \'국내 중계 서버\' 칸에 그 IP를 넣고, 11번가 IP 칸에도 중계 서버 IP를 등록하세요. (안내서의 \'11번가 국내 중계 서버\' 참고)',
    '발급받은 Open API Key를 아래에 입력하고 [연결 테스트]를 누릅니다.',
    '11번가 연동은 베타입니다. 처음 며칠은 셀러오피스 화면과 수집 결과를 함께 확인해주세요.',
  ],
};

module.exports = {
  ...meta,

  async test(ctx) {
    const now = new Date();
    let xml;
    try {
      xml = await api(ctx, `/ordservices/complete/${kstCompact(new Date(now.getTime() - 86400000))}/${kstCompact(now)}`);
    } catch (e) {
      if (e.network) e.diagnostic = await connectionReport(ctx.config.elevenstApiBase, str(ctx.creds.proxy) || null).catch((x) => `진단 실패: ${x.message}`);
      throw e;
    }
    const orders = parseList(xml, 'order');
    return {
      ok: true,
      message: `11번가 연결 성공 · 최근 결제완료 주문 ${orders.length}건 확인`,
      diagnostic: orders.length ? `order 필드: ${Object.keys(orders[0]).join(', ')}` : `응답: ${xml.replace(/\s+/g, ' ').slice(0, 300)}`,
    };
  },

  async fetch(ctx) {
    if (ctx.backfillDays) return backfill(ctx);
    const state = { ...(ctx.state || {}) };
    const runCount = (state.runCount || 0) + 1;
    state.runCount = runCount;
    const now = new Date();
    const start = kstCompact(new Date(now.getTime() - 7 * 86400000 + 60000)); // 최대 7일
    const end = kstCompact(now);
    const list = [];
    list.push(...(await fetchStatusList(ctx, 'complete', start, end)));
    list.push(...(await fetchStatusList(ctx, 'packaging', start, end)));
    // 30분마다(6회에 1번) 배송중·배송완료 목록도 확인 → 셀러오피스·다른 프로그램에서 발송한 주문, 배송완료 반영
    if (runCount % 6 === 1) {
      const errors = [];
      for (const name of ['shipping', 'dlvcompleted']) {
        try {
          list.push(...(await fetchStatusList(ctx, name, start, end)));
        } catch (e) {
          if (e.network) throw e;
          errors.push(`${LISTS[name][1]}: ${e.message}`);
        }
      }
      const msg = errors.length ? `11번가 배송 단계 조회 실패 (주문 수집은 정상): ${errors.join(' / ')}` : null;
      if (msg && msg !== state.listError) ctx.log?.(msg);
      if (msg) state.listError = msg;
      else delete state.listError;
    }

    const groups = collapse(list);
    // 취소요청 목록 → 해당 상품에 취소요청 표시
    try {
      const cancelXml = await api(ctx, `/claimservice/cancelorders/${start}/${end}`);
      const reqs = parseList(cancelXml, 'order');
      for (const c of reqs) {
        const key = `${pick(c, 'ordNo')}-${pick(c, 'ordPrdSeq')}`;
        for (const g of groups) for (const it of g.items) if (it.itemKey === key) {
          it.claim = 'CANCEL';
          it.marketStatus += ' · 취소요청';
        }
      }
      // 목록에서 사라진 미처리 주문이 취소요청 목록에 있으면 표시용 그룹 생성
      const open = ctx.openGroups ? ctx.openGroups() : [];
      for (const c of reqs) {
        const key = `${pick(c, 'ordNo')}-${pick(c, 'ordPrdSeq')}`;
        const exists = groups.some((g) => g.items.some((it) => it.itemKey === key));
        if (!exists && open.some((g) => g.item_keys?.includes(key))) {
          const g = normalizeOrder(c, 'CONFIRMED', '취소요청');
          g.items[0].claim = 'CANCEL';
          g.partial = true;
          groups.push(g);
        }
      }
    } catch (e) {
      ctx.log?.(`11번가 취소요청 조회 실패: ${e.message}`);
    }
    // 취소완료 목록 → 취소 상태 반영
    try {
      const doneXml = await api(ctx, `/claimservice/canceledorders/${start}/${end}`);
      const open = ctx.openGroups ? ctx.openGroups() : [];
      for (const c of parseList(doneXml, 'order')) {
        const key = `${pick(c, 'ordNo')}-${pick(c, 'ordPrdSeq')}`;
        if (!open.some((g) => g.item_keys?.includes(key))) continue;
        const g = normalizeOrder(c, 'CANCELED', '취소완료');
        g.partial = true;
        groups.push(g);
      }
    } catch (e) {
      ctx.log?.(`11번가 취소완료 조회 실패: ${e.message}`);
    }
    return { groups: mergeGroups(groups), state };
  },

  // 발주확인 (결제완료 → 배송준비중)
  async confirm(ctx, order, items) {
    const ok = [];
    const failed = [];
    for (const it of items) {
      const e = it.extra || {};
      try {
        const xml = await api(
          ctx,
          `/ordservices/reqpackaging/${encodeURIComponent(e.ordNo)}/${encodeURIComponent(e.ordPrdSeq)}/${encodeURIComponent(
            e.addPrdYn || 'N'
          )}/${encodeURIComponent(e.addPrdNo || 'null')}/${encodeURIComponent(e.dlvNo)}`
        );
        const r = resultOf(xml);
        if (r.code === null || r.code === '0' || r.code === '1' || r.code === '100' || r.code === '200') ok.push(it.itemKey);
        else failed.push({ itemKey: it.itemKey, message: `${r.text} (${r.code})` });
      } catch (err) {
        failed.push({ itemKey: it.itemKey, message: err.message });
      }
    }
    return { ok, failed };
  },

  // 발송처리 (배송번호 단위)
  async dispatch(ctx, order, items, { courierKey, trackingNo }) {
    const code = courierCode(courierKey, 'elevenst');
    if (!code) throw new Error('이 택배사는 11번가 코드가 없습니다. 택배사를 다시 선택하거나 직접 코드를 입력해주세요.');
    const dlvNos = [...new Set(items.map((i) => i.extra?.dlvNo).filter(Boolean))];
    const okDlv = new Set();
    const failMsg = new Map();
    for (const dlvNo of dlvNos) {
      try {
        const xml = await api(
          ctx,
          `/ordservices/reqdelivery/${kstCompact(new Date())}/01/${encodeURIComponent(code)}/${encodeURIComponent(
            String(trackingNo).trim()
          )}/${encodeURIComponent(dlvNo)}`
        );
        const r = resultOf(xml);
        if (r.code === null || r.code === '0' || r.code === '1' || r.code === '100' || r.code === '200') okDlv.add(dlvNo);
        else failMsg.set(dlvNo, `${r.text} (${r.code})`);
      } catch (err) {
        failMsg.set(dlvNo, err.message);
      }
    }
    return {
      ok: items.filter((i) => okDlv.has(i.extra?.dlvNo)).map((i) => i.itemKey),
      failed: items.filter((i) => !okDlv.has(i.extra?.dlvNo)).map((i) => ({ itemKey: i.itemKey, message: failMsg.get(i.extra?.dlvNo) || '발송처리 실패' })),
    };
  },

  _internal: {
    weekWindows,
    collapse, parseList, parseFlat, resultOf, normalizeOrder },
};
