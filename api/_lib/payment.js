const crypto = require('node:crypto');

const PRODUCT_ID = 'crawl-4-weeks-v1';
const PRICE_MINOR = 249000;
const PRICE_VALUE = '2490.00';
const CURRENCY = 'RUB';
const PRODUCT_TITLE = 'Техника кроля за 4 недели';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
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
  requiredEnv, amountMatches, fetchPayment, signDownloadToken, verifyDownloadToken,
  productPaymentMatches, fetchPrivatePdf,
};
