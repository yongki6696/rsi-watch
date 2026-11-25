'use strict';
// ntfy 알림 (https://ntfy.sh) - JSON 발행 방식(한글 제목 지원)
async function sendNtfy({ server, topic, token }, msg) {
  if (!topic) throw new Error('ntfy 토픽 이름을 입력해주세요');
  const base = String(server || 'https://ntfy.sh').replace(/\/$/, '');
  const body = {
    topic,
    title: msg.title,
    message: msg.body || msg.title,
    priority: msg.priority === 'high' ? 5 : msg.priority === 'low' ? 2 : 4,
    tags: msg.tags || [],
  };
  if (msg.absoluteUrl && /^https?:\/\//.test(msg.absoluteUrl)) body.click = msg.absoluteUrl;
  // 판매 페이지·공급처 상품 버튼 (ntfy 버튼은 최대 3개)
  const actions = (msg.links || []).filter((l) => l && /^https?:\/\//.test(l.url)).slice(0, 3).map((l) => ({ action: 'view', label: l.label, url: l.url }));
  if (actions.length) body.actions = actions;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + '/', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`ntfy 전송 실패 (HTTP ${res.status}) ${t.slice(0, 150)}`);
  }
  return { sent: 1 };
}

module.exports = { sendNtfy };
