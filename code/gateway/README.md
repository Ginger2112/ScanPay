# ScanPay (demo)

Self-hosted UPI + COD payment gateway with a payments CRM, rewritten clean as a
single Node process. Real QR + a working Gmail bank-alert observer; payment
detection can also be simulated for demos.

## OTP channel (checkout phone verification)
Pluggable. Default `console` (demo shows the code on screen). Real channel: WhatsApp.

```bash
# pair once: scan the QR printed in the terminal with a DEDICATED WhatsApp number
OTP_CHANNEL=whatsapp npm start
```
- `lib/otp.js` dispatches; `lib/whatsapp.js` is the Baileys client (auth saved in
  `data/wa-auth`, pair once). Status: `GET /api/otp/status`.
- Baileys is unofficial WhatsApp — use a dedicated number, keep OTP volume low.
- To add SMS: implement `sendSms()` and add a case in `lib/otp.js`.

## Gmail observer (Axis credit alerts)
Standalone backup detector — watches a Gmail inbox for Axis credit alerts, parses
amount + UTR, and posts them to the core, which matches the pending order and
auto-confirms. De-dups on UTR so it never double-confirms with another source.

```bash
cp observer/.env.example observer/.env      # fill in Gmail + app password
node --env-file=observer/.env observer/gmail-observer.js
```
- Works against ANY Gmail (point it at whichever inbox gets the alerts).
- Needs a Gmail **App Password** (Security → 2-Step Verification → App passwords).
- Parser: `lib/parse-axis.js` (add your real Axis wording at the top of the
  pattern lists). Test: `npm test`.
- Ingestion API: `POST /api/observer/credit {amount,utr,source}` with header
  `x-observer-token` = server's `OBSERVER_TOKEN`.


## Run
```bash
npm install
npm start
```
- Store:  http://localhost:6100/store
- Admin:  http://localhost:6100/admin
- Merchant VPA: `arunsamanta17-1@okaxis` (Axis) — edit in `config.js`

## Flow
1. Buy a product in the store → an order is created.
2. Checkout shows a **real** UPI QR (`upi://pay?pa=<your-vpa>&am=<amount>`) + 5-min timer.
3. Payment detection: in demo, the Admin **Simulate payment** button (or
   `POST /api/dev/credit {amount}`) stands in for the real observer.
4. On detection → order confirmed → **HMAC-SHA256 signed webhook** to the store.

## What's real vs stubbed
| Piece | State |
|---|---|
| UPI QR / deep-link | real, payable |
| Order state machine, queue, timer, SSE | real |
| Signed webhook | real (set `WEBHOOK_URL`/`WEBHOOK_SECRET`) |
| Payment detection | **stubbed** — next step is the Gmail Axis-alert observer |
| WhatsApp OTP, Android observer | not in demo |
| Shopify (Careatic) connect | not yet — manual UPI method + order-status embed + auto mark-as-paid |

## Files
- `config.js` — merchant VPA, timeout, webhook, demo toggle
- `server.js` — single-process server (store/checkout/admin/API/SSE)
- `lib/orders.js` — state machine, single-slot queue, credit matching
- `lib/qr.js` — UPI string + SVG QR
- `lib/webhook.js` — signed merchant webhook
- `lib/db.js` — node:sqlite (WAL)
