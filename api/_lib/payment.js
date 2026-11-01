const crypto = require('node:crypto');

const PRODUCT_ID = 'crawl-4-weeks-v1';
const PRICE_MINOR = 249000;
const PRICE_VALUE = '2490.00';
const CURRENCY = 'RUB';
const PRODUCT_TITLE = 'Техника кроля за 4 недели';
const PAYMENT_SUBJECTS = new Set([
  'commodity', 'excise', 'job', 'service', 'payment', 'casino', 'gambling_bet',
  'gambling_prize', 'lottery', 'lottery_prize', 'intellectual_activity',
  'agent_commission', 'property_right', 'non_operating_gain', 'sales_tax',
  'resort_fee', 'marked', 'non_marked', 'marked_excise', 'non_marked_excise',
  'fine', 'tax', 'lien', 'cost', 'agent_withdrawals',
  'pension_insurance_without_payouts', 'pension_insurance_with_payouts',
  'health_insurance_without_payouts', 'health_insurance_with_payouts',
  'health_insurance', 'another',
]);
const PAYMENT_MODES = new Set(['full_prepayment', 'full_payment']);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function requiredReceiptEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    const error = new Error(`Missing required receipt setting: ${name}`);
    error.code = 'MISSING_RECEIPT_SETTING';
    error.parameter = name;
    throw error;
  }
  return value.trim();
}

function buildReceipt(email) {
  const vatCode = requiredReceiptEnv('YOOKASSA_VAT_CODE');
  if (!/^(?:[1-9]|1[0-2])$/.test(vatCode)) {
    const error = new Error('Invalid YOOKASSA_VAT_CODE');
    error.code = 'INVALID_RECEIPT_SETTING';
    error.parameter = 'YOOKASSA_VAT_CODE';
    throw error;
  }

  const paymentSubject = requiredReceiptEnv('YOOKASSA_PAYMENT_SUBJECT');
  if (!PAYMENT_SUBJECTS.has(paymentSubject)) {
    const error = new Error('Invalid YOOKASSA_PAYMENT_SUBJECT');
    error.code = 'INVALID_RECEIPT_SETTING';
    error.parameter = 'YOOKASSA_PAYMENT_SUBJECT';
    throw error;
  }

  const paymentMode = requiredReceiptEnv('YOOKASSA_PAYMENT_MODE');
  if (!PAYMENT_MODES.has(paymentMode)) {
    const error = new Error('Invalid YOOKASSA_PAYMENT_MODE');
    error.code = 'INVALID_RECEIPT_SETTING';
    error.parameter = 'YOOKASSA_PAYMENT_MODE';
    throw error;
  }

  return {
    customer: { email },
    items: [{
      description: PRODUCT_TITLE,
      quantity: 1,
      amount: { value: PRICE_VALUE, currency: CURRENCY },
      vat_code: Number(vatCode),
      payment_subject: paymentSubject,
      payment_mode: paymentMode,
    }],
    internet: 'true',
  };
}

function receiptMatchesPaymentAmount(paymentAmount, receipt) {
  const toMinorUnits = (value) => {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(value)) return null;
    const [whole, fraction] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction);
  };

  const expected = toMinorUnits(paymentAmount?.value);
  if (expected === null || paymentAmount?.currency !== CURRENCY || !Array.isArray(receipt?.items) || receipt.items.length === 0) return false;

  let totalThousandthsOfMinor = 0n;
  for (const item of receipt.items) {
    const itemMinor = toMinorUnits(item?.amount?.value);
    const quantity = item?.quantity;
    if (itemMinor === null || item?.amount?.currency !== CURRENCY ||
        typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 ||
        !Number.isSafeInteger(quantity * 1000)) return false;
    totalThousandthsOfMinor += itemMinor * BigInt(quantity * 1000);
  }

  return totalThousandthsOfMinor === expected * 1000n;
}

function paymentAuth() {
  const shopId = requiredEnv('YOOKASSA_SHOP_ID');
  const secret = requiredEnv('YOOKASSA_SECRET_KEY');
  return `Basic ${Buffer.from(`${shopId}:${secret}`).toString('base64')}`;
}

function amountMatches(amount) {
  return amount && amount.currency === CURRENCY && Math.round(Number(amount.value) * 100) === PRICE_MINOR;
}

async function fetchPayment(paymentId) {
  if (typeof paymentId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(paymentId)) {
    throw new Error('Invalid payment id');
  }
  const response = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: paymentAuth(), Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`YooKassa payment lookup failed (${response.status})`);
  return response.json();
}

function signDownloadToken(paymentId, email, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ paymentId, email, expiresAt })).toString('base64url');
  const signature = crypto.createHmac('sha256', requiredEnv('DELIVERY_TOKEN_SECRET')).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyDownloadToken(token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const expected = crypto.createHmac('sha256', requiredEnv('DELIVERY_TOKEN_SECRET')).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.paymentId || !data.email || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= Date.now()) return null;
    return data;
  } catch { return null; }
}

function productPaymentMatches(payment, email) {
  return payment && payment.status === 'succeeded' && amountMatches(payment.amount) &&
    payment.metadata && payment.metadata.product_id === PRODUCT_ID &&
    typeof payment.metadata.email === 'string' && payment.metadata.email.toLowerCase() === email.toLowerCase();
}

async function fetchPrivatePdf() {
  const url = requiredEnv('PRODUCT_PDF_BLOB_URL');
  const token = requiredEnv('BLOB_READ_WRITE_TOKEN');
  const blobUrl = new URL(url);
  if (blobUrl.protocol !== 'https:' || !blobUrl.hostname.endsWith('.private.blob.vercel-storage.com')) {
    throw new Error('PRODUCT_PDF_BLOB_URL must be a private Vercel Blob URL');
  }
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Private PDF fetch failed (${response.status})`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/pdf')) throw new Error('Configured product file is not a PDF');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Configured product file is not a valid PDF');
  if (bytes.length > 15 * 1024 * 1024) throw new Error('Product PDF exceeds the email attachment limit');
  return bytes;
}

module.exports = {
  PRODUCT_ID, PRICE_MINOR, PRICE_VALUE, CURRENCY, PRODUCT_TITLE,
  requiredEnv, buildReceipt, receiptMatchesPaymentAmount, amountMatches, fetchPayment, signDownloadToken, verifyDownloadToken,
  productPaymentMatches, fetchPrivatePdf,
};
