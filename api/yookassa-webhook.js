const {
  PRODUCT_ID, PRODUCT_TITLE, requiredEnv,
  fetchPayment, amountMatches, productPaymentMatches, signDownloadToken, fetchPrivatePdf,
} = require('./_lib/payment');

module.exports = async function yookassaWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const eventBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const event = eventBody?.event;
    const paymentId = eventBody?.object?.id;
    if (event !== 'payment.succeeded' || !paymentId) return res.status(200).json({ received: true });

    // Webhook payloads are not trusted: retrieve the payment from YooKassa over authenticated API.
    const payment = await fetchPayment(paymentId);
    if (payment.id !== paymentId || payment.status !== 'succeeded' || !amountMatches(payment.amount) ||
        payment.metadata?.product_id !== PRODUCT_ID || !payment.metadata?.email) {
      console.warn('Ignored unverified YooKassa notification', paymentId);
      return res.status(200).json({ received: true });
    }

    const email = String(payment.metadata.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      console.error('Verified payment has invalid recipient', paymentId);
      return res.status(200).json({ received: true });
    }

    const pdf = await fetchPrivatePdf();
    const createdAt = Date.parse(payment.created_at);
    if (!Number.isFinite(createdAt)) throw new Error('YooKassa payment is missing a valid creation time');
    const expiresAt = createdAt + 30 * 24 * 60 * 60 * 1000;
    const token = signDownloadToken(payment.id, email, expiresAt);
    const siteOrigin = new URL(requiredEnv('PAYMENT_SITE_ORIGIN')).origin;
    if (!siteOrigin.startsWith('https://')) throw new Error('PAYMENT_SITE_ORIGIN must use HTTPS');
    const downloadUrl = `${siteOrigin}/api/download?token=${encodeURIComponent(token)}`;
    const mailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${requiredEnv('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `yookassa-${payment.id}`,
      },
      body: JSON.stringify({
        from: requiredEnv('RESEND_FROM'),
        to: [email],
        subject: `Оплата прошла — ${PRODUCT_TITLE}`,
        html: `<p>Спасибо за покупку!</p><p>PDF-программа «${PRODUCT_TITLE}» приложена к письму.</p><p>Защищённая ссылка для скачивания (действует 30 дней): <a href="${downloadUrl}">скачать программу</a>.</p>`,
        attachments: [{ filename: 'LAVRIK_SWIM_Tekhnika_krolya_4_nedeli.pdf', content: pdf.toString('base64') }],
      }),
    });
    if (!mailResponse.ok) {
      const detail = await mailResponse.text();
      console.error('Resend delivery failed', mailResponse.status, detail.slice(0, 500));
      return res.status(500).json({ error: 'Email delivery failed; YooKassa may retry this notification.' });
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('YooKassa webhook failed:', error.message);
    return res.status(500).json({ error: 'Webhook processing failed; YooKassa may retry this notification.' });
  }
};
