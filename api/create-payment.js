const crypto = require('node:crypto');
const { PRODUCT_ID, PRICE_VALUE, CURRENCY, PRODUCT_TITLE, requiredEnv } = require('./_lib/payment');

module.exports = async function createPayment(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let siteOrigin;
  try {
    siteOrigin = new URL(requiredEnv('PAYMENT_SITE_ORIGIN')).origin;
    if (!siteOrigin.startsWith('https://')) throw new Error('HTTPS required');
  } catch (error) {
    console.error('Invalid PAYMENT_SITE_ORIGIN:', error.message);
    return res.status(500).json({ error: 'Сервис оплаты временно недоступен.' });
  }
  if (req.headers.origin !== siteOrigin) return res.status(403).json({ error: 'Forbidden origin' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Укажите корректный email.' });
    }

    const response = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${requiredEnv('YOOKASSA_SHOP_ID')}:${requiredEnv('YOOKASSA_SECRET_KEY')}`).toString('base64')}`,
        'Idempotence-Key': crypto.randomUUID(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        amount: { value: PRICE_VALUE, currency: CURRENCY },
        capture: true,
        confirmation: { type: 'redirect', return_url: `${siteOrigin}/technique.html?payment=return` },
        description: PRODUCT_TITLE,
        metadata: { product_id: PRODUCT_ID, email },
      }),
    });
    const payment = await response.json();
    if (!response.ok || !payment.confirmation?.confirmation_url) {
      console.error('YooKassa create payment error', response.status, payment.code || payment.type || 'unknown');
      return res.status(502).json({ error: 'Не удалось создать платёж. Попробуйте ещё раз позже.' });
    }
    return res.status(200).json({ confirmationUrl: payment.confirmation.confirmation_url });
  } catch (error) {
    console.error('Create payment failed:', error.message);
    return res.status(500).json({ error: 'Сервис оплаты временно недоступен.' });
  }
};
