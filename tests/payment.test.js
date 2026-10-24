const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PRODUCT_ID, PRICE_MINOR, amountMatches, productPaymentMatches,
  signDownloadToken, verifyDownloadToken,
} = require('../api/_lib/payment');

const originalFetch = global.fetch;
const savedEnv = { ...process.env };
function setEnv(values) { Object.assign(process.env, values); }
function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
}

test.afterEach(() => {
  global.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

test('amount and payment identity checks require the exact configured product', () => {
  assert.equal(PRICE_MINOR, 249000);
  assert.equal(amountMatches({ value: '2490.00', currency: 'RUB' }), true);
  assert.equal(amountMatches({ value: '1.00', currency: 'RUB' }), false);
  assert.equal(amountMatches({ value: '2490.00', currency: 'USD' }), false);
  assert.equal(productPaymentMatches({
    status: 'succeeded', amount: { value: '2490.00', currency: 'RUB' },
    metadata: { product_id: PRODUCT_ID, email: 'buyer@example.com' },
  }, 'BUYER@example.com'), true);
  assert.equal(productPaymentMatches({
    status: 'pending', amount: { value: '2490.00', currency: 'RUB' },
    metadata: { product_id: PRODUCT_ID, email: 'buyer@example.com' },
  }, 'buyer@example.com'), false);
});

test('download tokens are signed and expire', () => {
  setEnv({ DELIVERY_TOKEN_SECRET: 'unit-test-secret-that-is-long-enough' });
  const expiry = Date.now() + 60_000;
  const token = signDownloadToken('payment_123', 'buyer@example.com', expiry);
  assert.deepEqual(verifyDownloadToken(token), {
    paymentId: 'payment_123', email: 'buyer@example.com', expiresAt: expiry,
  });
  assert.equal(verifyDownloadToken(`${token}x`), null);
  assert.equal(verifyDownloadToken(signDownloadToken('payment_123', 'buyer@example.com', Date.now() - 1)), null);
});

test('payment endpoint ignores client amount and uses server configured price', async () => {
  setEnv({ YOOKASSA_SHOP_ID: 'shop-test', YOOKASSA_SECRET_KEY: 'secret-test', PAYMENT_SITE_ORIGIN: 'https://www.lavrik-swim.ru' });
  let sentBody;
  global.fetch = async (_url, options) => {
    sentBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ confirmation: { confirmation_url: 'https://yookassa.ru/checkout' } }) };
  };
  const createPayment = require('../api/create-payment');
  const res = responseRecorder();
  await createPayment({ method: 'POST', headers: { origin: 'https://www.lavrik-swim.ru' }, body: { email: 'buyer@example.com', amount: 1 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(sentBody.amount.value, '2490.00');
  assert.equal(sentBody.metadata.email, 'buyer@example.com');
});

test('webhook does not email for a payment that the YooKassa API says is pending', async () => {
  setEnv({ YOOKASSA_SHOP_ID: 'shop-test', YOOKASSA_SECRET_KEY: 'secret-test', PAYMENT_SITE_ORIGIN: 'https://www.lavrik-swim.ru' });
  let emailAttempted = false;
  global.fetch = async (url) => {
    if (String(url).includes('/v3/payments/')) return { ok: true, json: async () => ({
      id: 'payment_123', status: 'pending', amount: { value: '2490.00', currency: 'RUB' },
      metadata: { product_id: PRODUCT_ID, email: 'buyer@example.com' },
    }) };
    emailAttempted = true;
    throw new Error('Email must not be attempted');
  };
  const webhook = require('../api/yookassa-webhook');
  const res = responseRecorder();
  await webhook({ method: 'POST', body: { event: 'payment.succeeded', object: { id: 'payment_123' } } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(emailAttempted, false);
});

test('webhook attaches the private PDF only after YooKassa confirms success', async () => {
  setEnv({
    YOOKASSA_SHOP_ID: 'shop-test', YOOKASSA_SECRET_KEY: 'secret-test',
    RESEND_API_KEY: 're_test', RESEND_FROM: 'LAVRIK SWIM <program@example.com>',
    PAYMENT_SITE_ORIGIN: 'https://www.lavrik-swim.ru',
    DELIVERY_TOKEN_SECRET: 'unit-test-secret-that-is-long-enough',
    PRODUCT_PDF_BLOB_URL: 'https://store.private.blob.vercel-storage.com/products/program.pdf',
    BLOB_READ_WRITE_TOKEN: 'blob-test',
  });
  let emailPayload;
  global.fetch = async (url, options) => {
    if (String(url).includes('/v3/payments/')) return { ok: true, json: async () => ({
      id: 'payment_123', status: 'succeeded', created_at: '2026-10-25T00:00:00Z',
      amount: { value: '2490.00', currency: 'RUB' },
      metadata: { product_id: PRODUCT_ID, email: 'buyer@example.com' },
    }) };
    if (String(url) === 'https://store.private.blob.vercel-storage.com/products/program.pdf') {
      const bytes = Buffer.from('%PDF-1.4 fake-pdf');
      return { ok: true, headers: { get: () => 'application/pdf' }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    }
    if (String(url) === 'https://api.resend.com/emails') {
      emailPayload = JSON.parse(options.body);
      return { ok: true, text: async () => '' };
    }
    throw new Error(`Unexpected request to ${url}`);
  };
  const webhook = require('../api/yookassa-webhook');
  const res = responseRecorder();
  await webhook({ method: 'POST', body: { event: 'payment.succeeded', object: { id: 'payment_123' } } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(emailPayload.to[0], 'buyer@example.com');
  assert.equal(emailPayload.attachments[0].filename, 'LAVRIK_SWIM_Tekhnika_krolya_4_nedeli.pdf');
  assert.ok(emailPayload.attachments[0].content.length > 0);
  assert.match(emailPayload.html, /api\/download\?token=/);
});
