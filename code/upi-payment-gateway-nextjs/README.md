# UPI Payment Gateway

A zero-fee UPI checkout for Indian merchants. Customers pay the merchant's own
UPI ID directly, bank to bank. **We never take custody of funds.**

---

## ⚠️ Rename this folder before deploying

`next build` fails when the project path contains a space. Dev mode works, so
this only bites at deploy time.

```bash
mv "$HOME/Desktop/UPI Payment Gateway" "$HOME/Desktop/upi-payment-gateway"
```

---

## The constraint everything else follows from

RBI's single test for Payment Aggregator licensing is **fund custody**. Holding
or settling customer money triggers ₹25 crore net worth, escrow, PCI-DSS, and
4–6 months of licensing. Routing only payment *data* keeps this a technology
service provider, outside PA scope — and is what makes "free" possible, since
there is no float and no per-transaction cost to recover.

**These features would break the legal shape. Do not build them:**

- Using our own VPA as a fallback — not even once, not even for testing
- Escrow, "hold until delivery", or buyer protection
- Refunds routed through us (track only; refunds stay merchant-initiated)
- Split payments or marketplace collection
- Any wallet, balance, or payout
- Taking a fee out of the transaction (bill subscriptions separately)

The accepted cost: **nothing tells us when a payment succeeds.** Closing that
gap is the actual product.

---

## Getting started

```bash
npm install
cp .env.example .env
npm run db:push
npm run db:seed    # prints a test API key — shown once
npm run dev
```

Then create a payment and open the checkout URL it returns:

```bash
curl -s localhost:3000/api/v1/payment-intents \
  -H "Authorization: Bearer <key from db:seed>" \
  -H "Content-Type: application/json" \
  -d '{"reference":"ORD-1001","amountPaise":49900,"description":"Test order"}'
```

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on :3000 |
| `npm test` | Unit tests (30, no database needed) |
| `npm run test:integration` | Lifecycle + webhook delivery against the dev database |
| `npm run payments` | List recent payments; flags any needing review |
| `npm run payments confirm <id>` | Mark a payment received (what the dashboard will do) |
| `npm run payments reject <id>` | Record that the money never arrived |
| `npm run db:push` | Apply schema |
| `npm run db:seed` | Create the demo merchant and **rotate** its API key |
| `npm run db:studio` | Browse data |

> Do not run `npm run build` while `npm run dev` is running — the build rewrites
> `.next` underneath the dev server and wedges it. If that happens:
> `rm -rf .next` and restart.

### Checking it end to end

1. `npm run dev`, then `npm run db:seed` and copy the API key it prints.
2. Create a payment with the curl above and open the `checkoutUrl` it returns.
3. The page shows a QR on desktop, UPI app buttons on mobile. Resize the window
   past 640px to see it swap.
4. Enter any 12 digits under "Already paid?" and submit. Status becomes
   *waiting for the seller to confirm*.
5. `npm run payments` — the payment is flagged for review. Confirm it:
   `npm run payments confirm <id>`
6. The customer's page flips to **Payment confirmed** on its own within a few
   seconds. No refresh — it polls.

---

## How it works

1. Merchant's store calls `POST /api/v1/payment-intents` with an order
   reference and an amount **in paise**.
2. We reserve a **unique charge amount** and return a checkout URL.
3. Customer opens checkout. Desktop gets a QR; mobile gets UPI app hand-off
   buttons — you cannot scan the screen you are holding.
4. Customer pays. Money goes straight to the merchant's bank.
5. Payment is confirmed (see below), and we POST a **signed webhook** to the
   store.

### Unique-paise allocation

The hard problem: a ₹499 credit in the merchant's bank does not say which order
it belongs to, and two customers paying ₹499 are indistinguishable.

So every live intent gets a distinct payable amount — ₹499.00 becomes ₹499.37 —
which turns reconciliation from fuzzy matching into an exact lookup.

- The offset is **always added, never subtracted**. Undercharging a merchant to
  simplify our bookkeeping would be taking their money.
- Max offset is 99 paise, giving 100 concurrent slots per price point.
- The exact amount is tried first, so the common case is charged precisely.
- Offsets are **shuffled, not sequential** — sequential allocation would let any
  customer infer the store's order volume from their own offset.
- Uniqueness is enforced by a database index, not application logic, so
  concurrent requests cannot both win.
- Slots are released on payment or expiry. Intents **must** expire or the pool
  leaks.

### Confirming payments

Because we are outside the money flow, there is no callback from NPCI or the
bank. Current status:

| Method | Status | Notes |
| --- | --- | --- |
| Customer submits UTR + merchant approves | **Built** | A UTR is self-reported and cannot be checked against the banking network. It moves the intent to `awaiting_confirmation` only — it never marks anything paid. |
| Bank credit-alert email parsing | **Planned** | Server-side, no app needed. The recommended path. |
| Companion Android app reading bank SMS | **Rejected as default** | Google Play restricts `READ_SMS` to default SMS handlers, forcing sideloaded APKs, and it makes confirmation depend on the merchant's phone staying alive. |

Fraud controls in place: UTR format validation, replay detection across orders,
and an append-only audit trail that retains rejected claims.

---

## API

All money is **integer paise**. `49900` is ₹499.00. Sending rupees is rejected.

### `POST /api/v1/payment-intents`

Auth: `Authorization: Bearer <api key>`. Optional `Idempotency-Key` header.

```json
{
  "reference": "ORD-1001",
  "amountPaise": 49900,
  "description": "Test order",
  "expiresInSeconds": 1800
}
```

Returns `201` with `id`, `chargeAmountPaise`, and `checkoutUrl`.

| Error | Meaning |
| --- | --- |
| `401 unauthorized` | Missing or invalid API key |
| `409 duplicate_reference` | Reference already used and not live |
| `422 invalid_request` | Bad field — e.g. rupees instead of paise, or above the ₹5,00,000 NPCI ceiling |
| `503 amount_slots_exhausted` | All 100 offsets at this price are held. Retryable. |

### `GET /api/v1/payment-intents/:id`

Auth required. Returns the same shape. Responds `404` for another merchant's
intent so the endpoint cannot be used to probe for valid ids.

### `POST /api/v1/payment-intents/:id/claim`

Unauthenticated — the payer is an anonymous shopper. Records a UTR claim and
nothing more. It cannot mark anything paid, which is what keeps an open
endpoint from being a route to free goods.

> **Before production:** rate limit this by IP and intent id.

### `POST /api/internal/dispatch-webhooks`

Queue runner. Flushes due webhooks and releases expired amount slots. Guard with
`CRON_SECRET` and call roughly every minute.

---

## Webhooks

```
X-Upi-Signature: t=1754531400,v1=<hex hmac-sha256>
```

The signed message is `${timestamp}.${rawBody}`. Verify against the **raw bytes**
— re-serialising parsed JSON reorders keys and breaks verification. The
timestamp is inside the MAC to stop replay; reject anything outside ±5 minutes.

`verifySignature()` in [`src/lib/webhook.ts`](src/lib/webhook.ts) is the
reference implementation — one copy, so docs cannot drift from the server.

Retries back off over roughly a day (8 attempts). A paid order that never
reaches the store is the worst failure this system has.

---

## Project layout

```
src/lib/
  money.ts      Integer-paise arithmetic. The only place rupees exist.
  amount.ts     Unique-paise allocation.
  upi.ts        upi://pay deep links, VPA and UTR validation.
  intents.ts    Lifecycle: create, claim, confirm, expire.
  webhook.ts    HMAC signing + verification + retry schedule.
  dispatch.ts   Durable webhook delivery.
  apikey.ts     Key generation and peppered hashing.
src/app/
  api/v1/       Merchant API.
  api/public/   Unauthenticated checkout status poll.
  pay/[id]/     Hosted checkout.
```

---

## Status

**Built and verified:** core engine, REST API, hosted checkout, webhook delivery
with retry. 30 unit tests plus two integration suites pass.

**Next:** Shopify app (phase 1). It will be a **manual payment method** with app
blocks on the Thank You and Order Status pages — not a checkout-native payment
method. That route requires Shopify Payments Partner approval, which mandates
API-triggered refunds we cannot perform without fund custody.

**Then:** coded-website drop-in (phase 2), WordPress/WooCommerce (phase 3).
