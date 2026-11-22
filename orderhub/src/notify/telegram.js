'use strict';
// 텔레그램 봇 알림
async function call(config, token, method, body) {
  const res = await fetch(`${config.telegramApiBase}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`텔레그램 오류: ${json.description || res.status}`);
  return json.result;
}

async function sendTelegram(config, { botToken, chatId }, msg) {
  if (!botToken || !chatId) throw new Error('텔레그램 봇 토큰과 채팅 ID를 입력해주세요');
  const text = `${msg.title}\n${msg.body || ''}`.trim();
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  const link = msg.absoluteUrl;
  if (link && /^https:\/\//.test(link)) {
    body.reply_markup = { inline_keyboard: [[{ text: '주문 보기', url: link }]] };
  }
  await call(config, botToken, 'sendMessage', body);
  return { sent: 1 };
}

// 봇에게 메시지를 보낸 채팅 목록에서 chat id 찾기
async function detectChats(config, botToken) {
  if (!botToken) throw new Error('봇 토큰을 먼저 입력해주세요');
  const updates = await call(config, botToken, 'getUpdates', { limit: 50 });
  const chats = new Map();
  for (const u of updates || []) {
    const chat = u.message?.chat || u.channel_post?.chat || u.my_chat_member?.chat;
    if (chat) chats.set(String(chat.id), { id: String(chat.id), name: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '' });
  }
  return [...chats.values()];
}

module.exports = { sendTelegram, detectChats };
