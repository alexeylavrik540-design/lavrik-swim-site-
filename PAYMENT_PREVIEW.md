# YooKassa test checkout in Vercel Preview

`POST /api/create-payment` is enabled only on Vercel Preview (or local development) with `YOOKASSA_MODE=test`. Production is intentionally closed with HTTP 503. The server always uses the fixed product price of 2,490 RUB and forwards a client UUID as YooKassa's `Idempotence-Key`; the browser stores the pending key and reuses it for retries.

For Preview, set these Vercel environment variables to the **Preview** environment only:

- `YOOKASSA_MODE=test`
- `YOOKASSA_SHOP_ID` — YooKassa test shop ID
- `YOOKASSA_SECRET_KEY` — YooKassa test secret

The site origin is derived from the request and checked against `Origin` and `Host`; Preview requests must come from `*.vercel.app`. The endpoint validates email, UUID idempotency key, JSON content type, fixed server price, and returned HTTPS checkout host. It does not deliver the PDF. Existing webhook and download handlers remain in place for the later delivery stage.

`.vercelignore` excludes `output/pdf/`, so the local PDF is not uploaded as a public static file. Verify the expected 404 on an actual Preview deployment before enabling checkout there. No credentials, real charges, or Production deployment were used for this preparation.
