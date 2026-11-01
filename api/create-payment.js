'use strict';

const { PRODUCT_ID, PRICE_VALUE, CURRENCY, PRODUCT_TITLE, requiredEnv } = require('./_lib/payment');

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validKey(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validConfirmationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === 'yookassa.ru' || url.hostname.endsWith('.yookassa.ru') ||
       url.hostname === 'yoomoney.ru' || url.hostname.endsWith('.yoomoney.ru'));
  } catch { return false; }
}

function safeYooKassaText(value, maxLength = 180) {
  if (typeof value !== 'string') return undefined;
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(secret|authorization|password|token)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, maxLength);
}

function requestOrigin(req) {
  const rawOrigin = req.headers?.origin;
  const host = req.headers?.host;
  if (typeof rawOrigin !== 'string' || typeof host !== 'string') return null;
  try {
    const origin = new URL(rawOrigin);
    if (origin.origin !== rawOrigin || origin.host.toLowerCase() !== host.toLowerCase()) return null;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:')) return null;
    if (process.env.VERCEL_ENV === 'preview' && !origin.hostname.endsWith('.vercel.app')) return null;
    return origin.origin;
  } catch { return null; }
}

module.exports = async function createPayment(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Метод не поддерживается.' });
  }
  if (process.env.VERCEL_ENV === 'production') return res.status(503).json({ error: 'Приём платежей пока не включён.' });
  if (!['preview', 'development', 'test', undefined].includes(process.env.VERCEL_ENV) || process.env.YOOKASSA_MODE !== 'test') {
    return res.status(503).json({ error: 'Для checkout требуется тестовый режим ЮKassa.' });
  }
  if (String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    return res.status(415).json({ error: 'Ожидается JSON-запрос.' });
  }
  const siteOrigin = requestOrigin(req);
  if (!siteOrigin) return res.status(403).json({ error: 'Запрос с этого адреса запрещён.' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Некорректный формат запроса.' }); }
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!validEmail(email)) return res.status(400).json({ error: 'Укажите корректный email.' });
  const idempotenceKey = req.headers?.['idempotence-key'];
  if (!validKey(idempotenceKey)) return res.status(400).json({ error: 'Некорректный ключ повтора оплаты.' });

  let auth;
  try {
    if (requiredEnv('YOOKASSA_MODE') !== 'test') throw new Error('Test mode required');
    auth = `Basic ${Buffer.from(`${requiredEnv('YOOKASSA_SHOP_ID')}:${requiredEnv('YOOKASSA_SECRET_KEY')}`).toString('base64')}`;
  } catch (error) {
    console.error('Payment configuration is incomplete:', error.message);
    return res.status(503).json({ error: 'Сервис оплаты временно недоступен.' });
  }
  try {
    const response = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: { Authorization: auth, 'Idempotence-Key': idempotenceKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        amount: { value: PRICE_VALUE, currency: CURRENCY }, capture: true,
        confirmation: { type: 'redirect', return_url: `${siteOrigin}/technique.html?payment=return` },
        description: PRODUCT_TITLE, metadata: { product_id: PRODUCT_ID, email },
      }),
      signal: AbortSignal.timeout(12000),
    });
    let payment;
    try { payment = await response.json(); } catch { payment = null; }
    if (!response.ok || !validConfirmationUrl(payment?.confirmation?.confirmation_url) || payment?.test !== true) {
      console.error('YooKassa rejected payment creation:', {
        status: response.status,
        code: safeYooKassaText(payment?.code, 64) || 'invalid_response',
        parameter: safeYooKassaText(payment?.parameter, 80),
        description: safeYooKassaText(payment?.description),
        errorId: safeYooKassaText(payment?.id, 64),
        testPayment: payment?.test === true,
      });
      return res.status(response.status === 429 ? 503 : 502).json({ error: 'Не удалось создать платёж. Попробуйте позже.' });
    }
    return res.status(200).json({ confirmationUrl: payment.confirmation.confirmation_url });
  } catch (error) {
    console.error('YooKassa request failed:', error.name || 'unknown_error');
    return res.status(error.name === 'TimeoutError' ? 504 : 502).json({ error: 'Не удалось связаться с платёжным сервисом. Попробуйте позже.' });
  }
};
