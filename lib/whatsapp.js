// WhatsApp Cloud API: used only to send the post-payment confirmation, then
// hand the chat back to the Meta Business Agent (Thread Control "release").

const SEND_TIMEOUT_MS = 8000;

function configured() {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

async function post(url, body, version) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
      ...(version ? { 'X-API-Version': version } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${raw.slice(0, 200)}`);
  return raw;
}

async function sendText(to, text) {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return post(`https://graph.facebook.com/v21.0/${id}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}

async function releaseThread(to) {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return post(
    `https://api.facebook.com/business/whatsapp/phone_numbers/${id}/thread_control`,
    { messaging_product: 'whatsapp', action: 'release', to },
    '1.0.0',
  );
}

module.exports = { configured, sendText, releaseThread };
