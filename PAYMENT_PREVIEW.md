# YooKassa test checkout in Vercel Preview

`POST /api/create-payment` is enabled only on Vercel Preview (or local development) with `YOOKASSA_MODE=test`. Production is intentionally closed with HTTP 503. The server always uses the fixed product price of 2,490 RUB and forwards a client UUID as YooKassa's `Idempotence-Key`; the browser stores the pending key and reuses it for retries.

For Preview, set these Vercel environment variables to the **Preview** environment only:

- `YOOKASSA_MODE=test`
- `YOOKASSA_SHOP_ID` — YooKassa test shop ID
- `YOOKASSA_SECRET_KEY` — YooKassa test secret
- `YOOKASSA_VAT_CODE` — VAT code confirmed for the merchant's tax regime and this sale (integer 1–12)
- `YOOKASSA_PAYMENT_SUBJECT` — receipt item subject code confirmed for the digital product
- `YOOKASSA_PAYMENT_MODE` — `full_prepayment` or `full_payment`, confirmed for the actual payment and delivery flow

The site origin is derived from the request and checked against `Origin` and `Host`; Preview requests must come from `*.vercel.app`. The endpoint validates email, UUID idempotency key, JSON content type, fixed server price, required receipt fields, receipt-to-payment total, and returned HTTPS checkout host. If receipt settings are missing or invalid, it returns HTTP 503 before calling YooKassa. It does not deliver the PDF. Existing webhook and download handlers remain in place for the later delivery stage.

Do not guess receipt settings. Confirm the merchant's tax regime and applicable VAT code, the receipt subject for the downloadable product, and the settlement mode with the merchant's YooKassa receipt setup/accountant. The server does not set fiscal defaults.

`.vercelignore` excludes `output/pdf/`, so the local PDF is not uploaded as a public static file. Verify the expected 404 on an actual Preview deployment before enabling checkout there. No credentials, real charges, or Production deployment were used for this preparation.
