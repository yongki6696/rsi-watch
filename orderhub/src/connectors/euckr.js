'use strict';
// 11번가로 보내는 XML 을 EUC-KR 바이트로 (EUC-KR 에 없는 글자·이모지는 XML 문자참조 &#코드; 로)
let TABLE = null;

function table() {
  if (TABLE) return TABLE;
  TABLE = new Map();
  const dec = new TextDecoder('euc-kr');
  // KS X 1001 영역만 (11번가 서버가 엄격한 EUC-KR 로 읽어도 깨지지 않게)
  for (let a = 0xa1; a <= 0xfe; a++) {
    for (let b = 0xa1; b <= 0xfe; b++) {
      const ch = dec.decode(Uint8Array.of(a, b));
      if (ch.length === 1 && ch !== '�' && !TABLE.has(ch)) TABLE.set(ch, [a, b]);
    }
  }
  return TABLE;
}

// XML 본문 문자열(이미 &,<,> 이스케이프된 것) → EUC-KR Buffer
function encodeXmlEucKr(xml) {
  const t = table();
  const out = [];
  for (const ch of String(xml)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (t.has(ch)) out.push(...t.get(ch));
    else for (const c of Buffer.from(`&#${cp};`, 'ascii')) out.push(c);
  }
  return Buffer.from(out);
}

// XML 텍스트 이스케이프 + XML 에 못 쓰는 제어문자 제거
function escapeXml(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { encodeXmlEucKr, escapeXml };
