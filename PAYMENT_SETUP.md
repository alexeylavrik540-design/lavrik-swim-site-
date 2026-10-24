# YooKassa PDF delivery setup

The project is a static Vercel site with Node.js Functions in `api/`. The PDF is intentionally kept out of the public repository and must be stored in a **private** Vercel Blob store.

## Vercel setup

1. In the Vercel project for `www.lavrik-swim.ru`, open **Storage → Create Database → Blob** and choose **Private**. Connect it to this project.
2. Upload the approved PDF as `products/crawl-4-weeks-v1.pdf` to that private store. Copy its private Blob URL; it must end in `.private.blob.vercel-storage.com/...`.
3. Add these Production and Preview environment variables in **Settings → Environment Variables**:

   - `YOOKASSA_SHOP_ID` — shop ID from YooKassa.
   - `YOOKASSA_SECRET_KEY` — test secret key first, then replace with the live key after a successful test.
   - `RESEND_API_KEY` — API key from Resend.
   - `RESEND_FROM` — verified sender, for example `LAVRIK SWIM <program@lavrik-swim.ru>`.
   - `DELIVERY_TOKEN_SECRET` — random secret of at least 32 bytes.
   - `PAYMENT_SITE_ORIGIN` — exact HTTPS origin serving the page, without a trailing slash. Production: `https://www.lavrik-swim.ru`; Preview: the exact Vercel Preview deployment origin.
   - `PRODUCT_PDF_BLOB_URL` — private URL of the uploaded PDF.
   - `BLOB_READ_WRITE_TOKEN` — added by Vercel when the Blob store is connected.

4. Redeploy after configuring the environment variables. In YooKassa, add the webhook URL for the deployment being tested (Production: `https://www.lavrik-swim.ru/api/yookassa-webhook`; Preview: `<preview-origin>/api/yookassa-webhook`) for the `payment.succeeded` event.
5. Set the Preview YooKassa key to test mode and use a test card from YooKassa's test payment page. The page sends the fixed amount 2,490 RUB to the server; the server ignores any client-provided amount. After confirming the test email and PDF, set the Production key to the live secret and redeploy.

The payment function is `POST /api/create-payment` with JSON `{ "email": "buyer@example.com" }`. The webhook independently retrieves the payment from YooKassa and checks its final status, amount, currency, product marker, and recipient before emailing the PDF. The protected download route checks the signed, expiring token and rechecks the payment status with YooKassa.

Do not commit API keys, the PDF, or `.env` files to GitHub. No credentials are needed in chat.
