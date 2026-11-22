'use strict';
// G마켓 / 옥션 - ESM Trading API (https://etapi.gmarket.com)
// 인증: JWT(HS256) 헤더 kid=ESM+ 마스터ID, 페이로드 ssi="G:판매자ID" 또는 "A:판매자ID", aud=sa.esmplus.com
// 주문조회(RequestOrders)는 판매자 ID별 5초당 1회 제한 → 호출 간격을 자동으로 맞춘다
const crypto = require('node:crypto');
const { request, parseJsonBig, stringifyBig, BIG } = require('./http');
const { pick, findArray, findCustomsCode, shape } = require('./fields');
const { kstDate, toIso, toInt, str, sleep } = require('../util');
const { courierCode } = require('../couriers');

const SITES = {
  auction: { code: 'A', siteType: 1, label: '옥션', short: 'A', color: '#f05a28', idLabel: '옥션 판매자 ID' },
  gmarket: { code: 'G', siteType: 2, label: 'G마켓', short: 'G', color: '#0f9d58', idLabel: 'G마켓 판매자 ID' },
};

// orderStatus: 1 결제완료(주문확인 전), 2 배송준비중(주문확인 완료), 3 배송중, 4 배송완료, 5 구매결정완료
const STATUS = {
  1: { state: 'NEW', label: '결제완료' },
  2: { state: 'CONFIRMED', label: '배송준비중' },
  3: { state: 'SHIPPED', label: '배송중' },
  4: { state: 'DELIVERED', label: '배송완료' },
  5: { state: 'DELIVERED', label: '구매결정완료' },
};

const lastOrderCall = new Map(); // "G:sellerId" -> ms

function b64url(text) {
  return Buffer.from(text).toString('base64url');
}

function issuer(config) {
  try {
    if (config.publicUrl) return new URL(config.publicUrl).host;
  } catch {}
  return 'orderhub';
}

function makeToken({ masterId, secretKey, sellerId, siteCode, iss, now = Date.now() }) {
  const header = { alg: 'HS256', typ: 'JWT', kid: masterId };
  const payload = { iss, sub: 'sell', aud: 'sa.esmplus.com', ssi: `${siteCode}:${sellerId}`, iat: Math.floor(now / 1000) };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac('sha256', secretKey).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function friendlyError(status, json, text, site) {
  const msg = json?.Message || json?.message || text || '';
  if (status === 401 || status === 403) {
    return `${site.label} 인증 실패: 마스터 ID·판매자 ID·Secret Key와 ESM API 신청 시 등록한 서버 IP를 확인해주세요. (HTTP ${status} ${msg})`.trim();
  }
  if (/5초/.test(msg)) return `${site.label} 주문조회 호출 제한(5초당 1회)에 걸렸습니다. 다음 수집 때 자동으로 다시 시도합니다.`;
  return `${site.label} API 오류${status ? ` (HTTP ${status})` : ''}${json?.ResultCode !== undefined ? ` [${json.ResultCode}]` : ''}: ${msg}`;
}

function makeConnector(type) {
  const site = SITES[type];

  function creds(ctx) {
    const { masterId, sellerId, secretKey } = ctx.creds || {};
    if (!masterId || !sellerId || !secretKey) throw new Error(`ESM+ 마스터 ID, ${site.idLabel}, Secret Key를 모두 입력해주세요`);
    return { masterId: String(masterId).trim(), sellerId: String(sellerId).trim(), secretKey: String(secretKey).trim() };
  }

  async function api(ctx, method, path, body) {
    const c = creds(ctx);
    const token = makeToken({ ...c, siteCode: site.code, iss: issuer(ctx.config) });
    const res = await request(ctx.config.esmApiBase + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body !== undefined ? stringifyBig(body) : method === 'POST' ? '{}' : undefined,
    });
    const text = res.buffer.toString('utf8');
    let json = null;
    try {
      json = text ? parseJsonBig(text) : null;
    } catch {}
    if (!res.ok) throw Object.assign(new Error(friendlyError(res.status, json, text.slice(0, 200), site)), { status: res.status });
    const rc = json?.ResultCode ?? json?.resultCode;
    if (rc !== undefined && rc !== null && !['0', '0000', '200', 'SUCCESS'].includes(String(rc).toUpperCase())) {
      throw Object.assign(new Error(friendlyError(0, json, '', site)), { resultCode: json.ResultCode });
    }
    return json;
  }

  // 주문조회 (5초당 1회 제한 준수)
  async function requestOrders(ctx, orderStatus, days) {
    const c = creds(ctx);
    const key = `${site.code}:${c.sellerId}`;
    const gap = ctx.config.esmOrderIntervalMs ?? 5200;
    const wait = (lastOrderCall.get(key) || 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    const now = Date.now();
    const all = [];
    let lastJson = null;
    for (let page = 1; page <= 5; page++) {
      if (page > 1) await sleep(gap);
      lastOrderCall.set(key, Date.now());
      const json = await api(ctx, 'POST', '/shipping/v1/Order/RequestOrders', {
        siteType: site.siteType,
        orderStatus,
        requestDateType: 2, // 결제완료일 기준
        requestDateFrom: kstDate(new Date(now - days * 86400000)),
        requestDateTo: kstDate(new Date(now + 86400000)), // 오늘 주문 포함되도록 내일 날짜까지
        pageIndex: page,
        pageSize: 100,
      });
      lastJson = json;
      const data = json?.Data ?? json?.data ?? json;
      const list = findArray(data, ['RequestOrders', 'requestOrders', 'Orders']);
      all.push(...list);
      const total = Number(pick(data || {}, ['TotalCount', 'totalCount'])) || 0;
      if (!total || all.length >= total || list.length === 0) break;
    }
    return { list: all, json: lastJson };
  }

  function optionText(o) {
    for (const [k, v] of Object.entries(o)) {
      if (/option/i.test(k) && Array.isArray(v) && v.length) {
        return v
          .map((x) => (typeof x === 'object' ? [pick(x, ['OptionName', 'Name', 'ItemOptionName']), pick(x, ['OptionValue', 'Value', 'ItemOptionValue', 'Text'])].filter(Boolean).join(': ') : String(x)))
          .filter(Boolean)
          .join(' / ');
      }
    }
    return str(pick(o, ['ItemOptionSelect', 'SelectedOption', 'OptionName', 'ItemOption', 'OptionValue', 'Option'], [/option/i]));
  }

  function normalize(o, orderStatus) {
    const st = STATUS[orderStatus] || STATUS[1];
    const orderNo = str(pick(o, ['OrderNo', 'orderNo']));
    const qty = toInt(pick(o, ['ContrAmount', 'OrderQty', 'OrderQuantity', 'Quantity', 'Qty', 'ItemQty', 'BuyCount'], [/qty|quantity/i]), 1) || 1;
    const unit = toInt(pick(o, ['SalePrice', 'UnitPrice', 'ItemPrice', 'Price']));
    const amount = toInt(pick(o, ['OrderAmount', 'TotalAmount', 'PayAmount', 'SettlementPrice', 'OrderPrice', 'BuyerPayAmount'], [/(order|pay|total|settle).*(amount|price)/i]));
    let address1 = str(pick(o, ['DelFullAddress', 'FullAddress', 'ReceiverAddress', 'DelAddress', 'Address', 'ReceiverAddr', 'AddressRoadName'], [/addr/i]));
    let address2 = str(pick(o, ['DelAddressDetail', 'AddressDetail', 'DetailAddress', 'ReceiverAddressDetail', 'Address2', 'DelAddress2'], [/(detail|dtl)/i]));
    if (address2 && address1.includes(address2)) address2 = '';
    const memo = str(pick(o, ['DelMemo', 'DeliveryMemo', 'ShippingMemo', 'DelMessage', 'DeliveryMessage', 'ReceiverMemo'], [/memo|deliverymsg|delmsg/i]));
    const trackingNo = str(pick(o, ['InvoiceNo', 'InvoiceNumber']));
    return {
      groupKey: orderNo,
      orderNo,
      orderedAt: toIso(pick(o, ['OrderDate', 'OrderDt', 'OrderDateTime'])),
      paidAt: toIso(pick(o, ['PaymentDate', 'PayDate', 'PaidDate', 'PaymentDt', 'SettleDate'], [/pay.*(date|dt)/i])) || toIso(pick(o, ['OrderDate'])),
      shipDue: toIso(pick(o, ['TransDueDate', 'ShippingDueDate', 'DeliveryDueDate'])),
      ordererName: str(pick(o, ['BuyerName', 'OrdererName'], [/buyer.*name/i])),
      ordererPhone: str(pick(o, ['BuyerMobileTel', 'BuyerHpNo', 'BuyerCp', 'BuyerTel', 'BuyerPhone'], [/buyer.*(mobile|hp|cp|tel|phone)/i])),
      receiverName: str(pick(o, ['ReceiverName', 'RecvName', 'RcvName', 'ReceiveName', 'DelName'], [/(receiver|recv|rcv).*name/i])),
      receiverPhone: str(pick(o, ['ReceiverMobileTel', 'ReceiverHpNo', 'HpNo', 'ReceiverCp', 'ReceiverPhone', 'DelHpNo'], [/(receiver|recv|rcv|del).*(mobile|hp|cp)/i])),
      receiverPhone2: str(pick(o, ['ReceiverTel', 'ReceiverTelNo', 'TelNo', 'DelTelNo'], [/(receiver|recv|rcv|del).*tel/i])),
      zipcode: str(pick(o, ['ZipCode', 'DelZipCode', 'ReceiverZipCode', 'PostNo', 'Zipcode'], [/zip|postno|postcode/i])),
      address1,
      address2,
      deliveryMemo: memo,
      customsCode: findCustomsCode(o),
      shippingFee: toInt(pick(o, ['ShippingFee', 'DeliveryFee', 'ShippingCost']), 0),
      marketTrackingNo: trackingNo,
      marketCourierCode: str(pick(o, ['DeliveryCompanyCode', 'DeliveryCompCode'])),
      items: [
        {
          itemKey: orderNo,
          orderNo,
          productName: str(pick(o, ['GoodsName', 'ItemName', 'ProductName'], [/goodsname|itemname/i])),
          optionName: optionText(o),
          quantity: qty,
          unitPrice: unit ?? (amount && qty ? Math.round(amount / qty) : null),
          amount: amount ?? (unit ? unit * qty : null),
          productCode: str(pick(o, ['SellerManagementCode', 'SellerItemCode', 'OutGoodsNo', 'SellerCode', 'SellerGoodsCode'], [/seller.*(code|cd)/i])),
          productId: str(pick(o, ['SiteGoodsNo', 'GoodsNo', 'ItemNo'])),
          marketState: st.state,
          marketStatus: st.label,
          claim: null,
          extra: { orderNo, site: site.code },
          raw: o,
        },
      ],
    };
  }

  const meta = {
    type,
    label: site.label,
    short: site.short,
    color: site.color,
    beta: true,
    inquiries: false,
    sellerCenter: 'https://www.esmplus.com/',
    fields: [
      { key: 'masterId', label: 'ESM+ 마스터 ID', placeholder: 'ESM PLUS 로그인 마스터 ID', required: true },
      { key: 'sellerId', label: site.idLabel, placeholder: `${site.label} 판매자 아이디`, required: true },
      { key: 'secretKey', label: 'Secret Key', placeholder: 'ESM API 신청 후 받은 키', required: true, secret: true },
    ],
    guide: [
      'G마켓·옥션은 ESM Trading API를 씁니다. ESM API 센터(etapi.gmarket.com)의 [API 시작하기]에서 이용 신청을 합니다.',
      '신청 시 ESM+ 마스터 ID, 사용할 API(주문·배송), 호출 IP(아래 표시된 이 서버 IP)를 제출하면 검토 후 Secret Key를 받습니다.',
      `${site.label} 판매자 ID와 함께 아래에 입력하고 [연결 테스트]를 누릅니다. (G마켓·옥션을 모두 쓰면 스토어를 각각 연결하세요. 같은 Secret Key를 써도 됩니다)`,
      '주문조회는 마켓 정책상 5초에 1번만 가능해서, 수집할 때 자동으로 간격을 두고 조회합니다.',
      '베타 연동입니다. 처음 며칠은 ESM PLUS 화면과 수집 결과를 함께 확인해주세요.',
    ],
  };

  return {
    ...meta,

    async test(ctx) {
      const { list, json } = await requestOrders(ctx, 1, 2);
      return {
        ok: true,
        message: `${site.label} 연결 성공 · 최근 결제완료 주문 ${list.length}건 확인`,
        diagnostic: shape(json),
      };
    },

    async fetch(ctx) {
      const state = { ...(ctx.state || {}) };
      const runCount = (state.runCount || 0) + 1;
      state.runCount = runCount;
      const days = ctx.state?._syncedOnce ? 7 : Math.max(ctx.initialDays || 7, 3);
      const groups = new Map();
      const load = async (s) => {
        const { list } = await requestOrders(ctx, s, s === 3 ? 14 : days);
        for (const o of list) {
          const g = normalize(o, s);
          if (g.groupKey) groups.set(g.groupKey, g);
        }
      };
      await load(1);
      await load(2);
      const open = ctx.openGroups ? ctx.openGroups() : [];
      // 30분마다, 또는 목록에서 사라진 미처리 주문이 있으면(ESM PLUS 에서 직접 발송했을 수 있음) 배송중 목록도 확인
      if (runCount % 6 === 1 || open.some((g) => !groups.has(g.group_key))) await load(3);
      // 결제완료/배송준비중/배송중 어디에도 없는 미처리 주문 → 두 번 연속이면 취소 확인 필요로 표시
      const missing = { ...(state.missing || {}) };
      for (const g of open) {
        if (groups.has(g.group_key)) {
          delete missing[g.group_key];
          continue;
        }
        missing[g.group_key] = (missing[g.group_key] || 0) + 1;
        if (missing[g.group_key] >= 2) {
          groups.set(g.group_key, {
            groupKey: g.group_key,
            partial: true,
            items: (g.item_keys || []).map((k) => ({ itemKey: k, claim: 'CANCEL', marketStatus: '주문 목록에서 사라짐 · ESM에서 취소 여부 확인' })),
          });
        }
      }
      for (const k of Object.keys(missing)) if (!open.some((g) => g.group_key === k)) delete missing[k];
      state.missing = missing;
      return { groups: [...groups.values()], state };
    },

    // 주문확인 (결제완료 → 배송준비중)
    async confirm(ctx, order, items) {
      const ok = [];
      const failed = [];
      for (const it of items) {
        const no = it.extra?.orderNo || it.itemKey;
        try {
          await api(ctx, 'POST', `/shipping/v1/Order/OrderCheck/${encodeURIComponent(no)}`, {});
          ok.push(it.itemKey);
        } catch (e) {
          failed.push({ itemKey: it.itemKey, message: e.message });
        }
      }
      return { ok, failed };
    },

    // 발송처리
    async dispatch(ctx, order, items, { courierKey, trackingNo }) {
      const code = courierCode(courierKey, type);
      if (!code) throw new Error(`이 택배사는 ${site.label} 코드가 없습니다. 택배사를 다시 선택하거나 직접 코드(5자리)를 입력해주세요.`);
      const ok = [];
      const failed = [];
      for (const it of items) {
        const no = it.extra?.orderNo || it.itemKey;
        try {
          await api(ctx, 'POST', '/shipping/v1/Delivery/ShippingInfo', {
            OrderNo: BIG(no),
            ShippingDate: kstDate(new Date()),
            DeliveryCompanyCode: Number(code),
            InvoiceNo: String(trackingNo).trim(),
          });
          ok.push(it.itemKey);
        } catch (e) {
          failed.push({ itemKey: it.itemKey, message: e.message });
        }
      }
      return { ok, failed };
    },

    _internal: { makeToken, normalize, issuer },
  };
}

module.exports = { gmarket: makeConnector('gmarket'), auction: makeConnector('auction'), makeToken };
