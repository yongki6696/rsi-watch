'use strict';
// 엑셀에서 바로 열리는 CSV (UTF-8 BOM)
const { courierName } = require('./couriers');
const { STATUS, CLAIM } = require('./orders');

function cell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // 긴 숫자(주문번호/송장번호)는 엑셀에서 지수표기로 깨지지 않도록 ="123..." 형태로
  if (/^\d{12,}$/.test(s)) return '"=""' + s + '"""';
  // 엑셀 수식 주입 방지
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function kst(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 9 * 3600000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

const LABELS = { naver: '스마트스토어', coupang: '쿠팡', elevenst: '11번가', demo: '데모' };

function ordersToCsv(orders) {
  const header = [
    '마켓', '스토어', '주문번호', '상품주문번호', '결제일시', '상태', '클레임', '상품명', '옵션', '수량', '결제금액',
    '주문자', '주문자연락처', '수취인', '수취인연락처', '수취인연락처2', '우편번호', '주소', '상세주소', '배송메모',
    '개인통관고유부호', '공급처', '공급처주문번호', '매입가', '택배사', '송장번호', '메모',
  ];
  const lines = [header.map(cell).join(',')];
  for (const o of orders) {
    for (const i of o.items || []) {
      lines.push(
        [
          LABELS[o.store_type] || o.store_type, o.store_name, i.order_no || o.order_no, i.item_key, kst(o.paid_at),
          STATUS[o.status] || o.status, o.claim ? CLAIM[o.claim] : '', i.product_name, i.option_name, i.quantity, i.amount,
          o.orderer_name, o.orderer_phone, o.receiver_name, o.receiver_phone, o.receiver_phone2, o.zipcode, o.address1, o.address2,
          o.delivery_memo, o.customs_code, o.supplier, o.supplier_order_no, o.cost, courierName(o.courier_key), o.tracking_no, o.memo,
        ]
          .map(cell)
          .join(',')
      );
    }
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

module.exports = { ordersToCsv };
