'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const createPayment = require('../api/create-payment');
const {
  PRODUCT_ID, PRICE_VALUE, CURRENCY, buildReceipt, receiptMatchesPaymentAmount,
} = require('../api/_lib/payment');

const originalFetch = global.fetch;
const envKeys = [
  'VERCEL_ENV', 'YOOKASSA_MODE', 'YOOKASSA_SHOP_ID', 'YOOKASSA_SECRET_KEY',
  'YOOKASSA_VAT_CODE', 'YOOKASSA_PAYMENT_SUBJECT', 'YOOKASSA_PAYMENT_MODE', 'PAYMENT_SITE_ORIGIN',
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function configurePreview() {
  process.env.VERCEL_ENV = 'preview';
  process.env.YOOKASSA_MODE = 'test';
  process.env.YOOKASSA_SHOP_ID = 'test-shop-id';
  process.env.YOOKASSA_SECRET_KEY = 'test-secret-key';
  process.env.YOOKASSA_VAT_CODE = '1';
  process.env.YOOKASSA_PAYMENT_SUBJECT = 'service';
  process.env.YOOKASSA_PAYMENT_MODE = 'full_payment';
  delete process.env.PAYMENT_SITE_ORIGIN;
}

function request({
  method = 'POST',
  origin = 'https://lavrik-preview.vercel.app',
  host = 'lavrik-preview.vercel.app',
  email = 'buyer@example.com',
  idempotenceKey = crypto.randomUUID(),
  body = { email },
  contentType = 'application/json',
} = {}) {
  return {
    method,
    headers: {
      origin,
      host,
      'content-type': contentType,
      'idempotence-key': idempotenceKey,
    },
    body,
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
}

function yookassaSuccess(url = 'https://yookassa.ru/checkout/confirmation') {
  return { ok: true, status: 200, json: async () => ({ id: 'payment_test_123', test: true, confirmation: { confirmation_url: url } }) };
}

test.beforeEach(() => configurePreview());

test.afterEach(() => {
  global.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test('allows only POST and marks responses non-cacheable', async () => {
  let called = false;
  global.fetch = async () => { called = true; return yookassaSuccess(); };
  const res = responseRecorder();
  await createPayment(request({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'POST');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(called, false);
});

test('blocks production before contacting YooKassa', async () => {
  process.env.VERCEL_ENV = 'production';
  let called = false;
  global.fetch = async () => { called = true; return yookassaSuccess(); };
  const res = responseRecorder();
  await createPayment(request({ origin: 'https://www.lavrik-swim.ru', host: 'www.lavrik-swim.ru' }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(called, false);
});

test('requires explicit test mode on Vercel Preview', async () => {
  delete process.env.YOOKASSA_MODE;
  let called = false;
  global.fetch = async () => { called = true; return yookassaSuccess(); };
  const res = responseRecorder();
  await createPayment(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(called, false);
});

test('refuses local checkout unless test mode is explicitly selected', async () => {
  process.env.VERCEL_ENV = 'development';
  process.env.YOOKASSA_MODE = 'live';
  let called = false;
  global.fetch = async () => { called = true; return yookassaSuccess(); };
  const res = responseRecorder();
  await createPayment(request({ origin: 'http://localhost:3000', host: 'localhost:3000' }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(called, false);
});

test('rejects mismatched Origin and Host', async () => {
  let called = false;
  global.fetch = async () => { called = true; return yookassaSuccess(); };
  const res = responseRecorder();
  await createPayment(request({ origin: 'https://attacker.example', host: 'lavrik-preview.vercel.app' }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(called, false);
});

test('rejects malformed JSON content type, email, and idempotency key', async (t) => {
  global.fetch = async () => yookassaSuccess();
  await t.test('malformed JSON body', async () => {
    const res = responseRecorder();
    await createPayment(request({ body: '{not-json' }), res);
    assert.equal(res.statusCode, 400);
  });
  await t.test('content type', async () => {
    const res = responseRecorder();
    await createPayment(request({ contentType: 'text/plain' }), res);
    assert.equal(res.statusCode, 415);
  });
  await t.test('email', async () => {
    const res = responseRecorder();
    await createPayment(request({ email: 'not-an-email' }), res);
    assert.equal(res.statusCode, 400);
  });
  await t.test('idempotency key', async () => {
    const res = responseRecorder();
    await createPayment(request({ idempotenceKey: 'new-random-key-every-request' }), res);
    assert.equal(res.statusCode, 400);
  });
});

test('uses fixed server price and ignores a client-supplied price', async () => {
  let outgoing;
  global.fetch = async (_url, options) => {
    outgoing = { options, body: JSON.parse(options.body) };
    return yookassaSuccess();
  };
  const key = crypto.randomUUID();
  const res = responseRecorder();
  await createPayment(request({ body: { email: ' Buyer@Example.com ', amount: { value: '0.01', currency: 'RUB' } }, idempotenceKey: key }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(outgoing.body.amount.value, PRICE_VALUE);
  assert.equal(outgoing.body.amount.currency, CURRENCY);
  assert.equal(outgoing.body.metadata.product_id, PRODUCT_ID);
  assert.equal(outgoing.body.metadata.email, 'buyer@example.com');
  assert.deepEqual(outgoing.body.receipt, {
    customer: { email: 'buyer@example.com' },
    items: [{
      description: 'Техника кроля за 4 недели', quantity: 1,
      amount: { value: '2490.00', currency: 'RUB' },
      vat_code: 1, payment_subject: 'service', payment_mode: 'full_payment',
    }],
    internet: 'true',
  });
  assert.equal(receiptMatchesPaymentAmount(outgoing.body.amount, outgoing.body.receipt), true);
  assert.equal(outgoing.options.headers['Idempotence-Key'], key);
  assert.match(outgoing.options.headers.Authorization, /^Basic /);
  assert.equal(outgoing.body.confirmation.return_url, 'https://lavrik-preview.vercel.app/technique.html?payment=return');
  assert.equal(res.body.confirmationUrl, 'https://yookassa.ru/checkout/confirmation');
});

test('receipt configuration is required and validated before the YooKassa request', async (t) => {
  for (const name of ['YOOKASSA_VAT_CODE', 'YOOKASSA_PAYMENT_SUBJECT', 'YOOKASSA_PAYMENT_MODE']) {
    await t.test(`missing ${name}`, async () => {
      delete process.env[name];
      let called = false;
      global.fetch = async () => { called = true; return yookassaSuccess(); };
      const res = responseRecorder();
      await createPayment(request(), res);
      assert.equal(res.statusCode, 503);
      assert.match(res.body.error, new RegExp(name));
      assert.equal(called, false);
    });
  }

  for (const [name, value] of [
    ['YOOKASSA_VAT_CODE', '13'],
    ['YOOKASSA_PAYMENT_SUBJECT', 'made-up-subject'],
    ['YOOKASSA_PAYMENT_MODE', 'advance'],
  ]) {
    await t.test(`invalid ${name}`, async () => {
      process.env[name] = value;
      let called = false;
      global.fetch = async () => { called = true; return yookassaSuccess(); };
      const res = responseRecorder();
      await createPayment(request(), res);
      assert.equal(res.statusCode, 503);
      assert.match(res.body.error, new RegExp(name));
      assert.equal(called, false);
    });
  }
});

test('builds receipt only from configured values and rejects missing or invalid settings', async (t) => {
  assert.deepEqual(buildReceipt('buyer@example.com'), {
    customer: { email: 'buyer@example.com' },
    items: [{
      description: 'Техника кроля за 4 недели', quantity: 1,
      amount: { value: PRICE_VALUE, currency: CURRENCY },
      vat_code: 1, payment_subject: 'service', payment_mode: 'full_payment',
    }],
    internet: 'true',
  });
  await t.test('missing value', () => {
    delete process.env.YOOKASSA_VAT_CODE;
    assert.throws(() => buildReceipt('buyer@example.com'), { code: 'MISSING_RECEIPT_SETTING', parameter: 'YOOKASSA_VAT_CODE' });
  });
  await t.test('invalid enum value', () => {
    process.env.YOOKASSA_VAT_CODE = '1';
    process.env.YOOKASSA_PAYMENT_SUBJECT = 'invented';
    assert.throws(() => buildReceipt('buyer@example.com'), { code: 'INVALID_RECEIPT_SETTING', parameter: 'YOOKASSA_PAYMENT_SUBJECT' });
  });
});

test('receipt total must match payment total and currency', () => {
  const receipt = buildReceipt('buyer@example.com');
  assert.equal(receiptMatchesPaymentAmount({ value: '2490.00', currency: 'RUB' }, receipt), true);
  assert.equal(receiptMatchesPaymentAmount({ value: '2490.01', currency: 'RUB' }, receipt), false);
  assert.equal(receiptMatchesPaymentAmount({ value: '2490.00', currency: 'USD' }, receipt), false);
  const invalidItemAmount = structuredClone(receipt);
  invalidItemAmount.items[0].amount.value = '2489.99';
  assert.equal(receiptMatchesPaymentAmount({ value: '2490.00', currency: 'RUB' }, invalidItemAmount), false);
});

test('same retry key and payload create only one payment in the YooKassa idempotency model', async () => {
  const key = crypto.randomUUID();
  const requestsByKey = new Map();
  let createdPayments = 0;
  const received = [];
  global.fetch = async (_url, options) => {
    const requestBody = JSON.parse(options.body);
    const requestKey = options.headers['Idempotence-Key'];
    received.push({ requestKey, requestBody });
    if (!requestsByKey.has(requestKey)) {
      createdPayments += 1;
      requestsByKey.set(requestKey, yookassaSuccess('https://yookassa.ru/checkout/same-payment'));
    }
    return requestsByKey.get(requestKey);
  };

  const first = responseRecorder();
  const retry = responseRecorder();
  await createPayment(request({ idempotenceKey: key }), first);
  await createPayment(request({ idempotenceKey: key }), retry);

  assert.equal(first.statusCode, 200);
  assert.equal(retry.statusCode, 200);
  assert.equal(createdPayments, 1);
  assert.equal(received[0].requestKey, received[1].requestKey);
  assert.deepEqual(received[0].requestBody, received[1].requestBody);
  assert.equal(first.body.confirmationUrl, retry.body.confirmationUrl);
});

test('rejects non-HTTPS or non-YooKassa confirmation links', async (t) => {
  for (const badUrl of ['http://yookassa.ru/pay', 'https://evil.example/pay']) {
    await t.test(badUrl, async () => {
      global.fetch = async () => yookassaSuccess(badUrl);
      const res = responseRecorder();
      await createPayment(request(), res);
      assert.equal(res.statusCode, 502);
      assert.equal(res.body.confirmationUrl, undefined);
    });
  }
});

test('does not return a checkout URL unless YooKassa confirms the payment is test-only', async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    id: 'payment_live_123', test: false,
    confirmation: { confirmation_url: 'https://yookassa.ru/checkout/confirmation' },
  }) });
  const res = responseRecorder();
  await createPayment(request(), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.confirmationUrl, undefined);
});

test('handles YooKassa errors and network timeouts without exposing secrets', async (t) => {
  await t.test('upstream rejection', async () => {
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({
      code: 'invalid_request', description: 'Invalid setting. Secret=must-not-leak',
      parameter: 'confirmation.return_url', id: 'error-test-123', secret: 'must-not-leak',
    }) });
    const originalConsoleError = console.error;
    let diagnostic;
    console.error = (...args) => { diagnostic = args; };
    const res = responseRecorder();
    try { await createPayment(request(), res); } finally { console.error = originalConsoleError; }
    assert.equal(res.statusCode, 502);
    assert.doesNotMatch(JSON.stringify(res.body), /secret|invalid_request/);
    assert.match(JSON.stringify(diagnostic), /confirmation\.return_url/);
    assert.match(JSON.stringify(diagnostic), /redacted/);
    assert.doesNotMatch(JSON.stringify(diagnostic), /must-not-leak/);
  });
  await t.test('timeout', async () => {
    global.fetch = async () => { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; };
    const res = responseRecorder();
    await createPayment(request(), res);
    assert.equal(res.statusCode, 504);
  });
});

test('fails closed when required credentials are absent', async () => {
  delete process.env.YOOKASSA_SECRET_KEY;
  let called = false;
  global.fetch = async () => { called = true; return yookassaSuccess(); };
  const res = responseRecorder();
  await createPayment(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(called, false);
});
