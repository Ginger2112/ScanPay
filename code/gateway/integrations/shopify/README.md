# ScanPay ↔ Shopify (Jazz94) — connect kit

Wires ScanPay UPI into a Shopify store without being an approved payments
partner. Native cart + checkout stay Shopify's; ScanPay collects over UPI on
the order-status page and **auto-marks the Shopify order paid** when confirmed.

## Flow
```
Buyer checks out on Shopify → picks "UPI (ScanPay)" (a manual method)
  → order created, financial_status = pending
  → order-status page embed creates a linked ScanPay order (carries the Shopify order GID)
  → buyer sees the UPI QR, pays, enters the UTR
  → you Approve in the ScanPay CRM
  → ScanPay confirms → calls Shopify Admin API orderMarkAsPaid → order shows PAID
```

## One-time setup (when the Jazz94 store is live)

**1. Shopify custom app + token**
- Shopify admin → Settings → Apps and sales channels → **Develop apps** → Create an app.
- Configuration → Admin API scopes → enable **`write_orders`** and **`read_orders`** → Save.
- Install app → reveal the **Admin API access token** (`shpat_…`).

**2. Manual payment method** (so UPI shows at checkout)
- Settings → Payments → **Manual payment methods** → Create custom payment method.
- Name it exactly **`UPI (ScanPay)`**. Add instructions like: "Pay via UPI on the
  next page; your order confirms once payment is verified."

**3. Make ScanPay reachable**
- Expose the ScanPay server publicly (tunnel e.g. `cloudflared tunnel --url http://localhost:6100`,
  or deploy it). Note the `https://…` URL = `SCANTOPAY_URL`.

**4. Start ScanPay with the Shopify env**
```bash
cp integrations/shopify/.env.example integrations/shopify/.env   # fill in store + token
node --env-file=integrations/shopify/.env server.js
```

**5. Paste the embed**
- Open `integrations/shopify/order-status-embed.html`, set `SCANTOPAY_URL`.
- Shopify admin → Settings → Checkout → **Order status page** additional scripts → paste it.
  (Or add it as a theme app-embed on the Thank-you / Order-status page.)

## Test
1. Place a test order on Shopify, choose **UPI (ScanPay)**.
2. On the order-status page the UPI QR appears → pay (or a ₹1 test) → enter the UTR.
3. Approve in the ScanPay CRM → the Shopify order flips to **Paid** automatically.

## How it's wired (code)
- `lib/shopify.js` — Admin API client (`orderMarkAsPaid`).
- `server.js onPaid()` — on confirm, if `config.shopify.enabled` and the order has a
  `gid://shopify/Order/…` ref, calls `markOrderPaid` (logged, non-fatal on error).
- Orders carry `ref` / `ref_name` (the Shopify order GID + name).
- API sends CORS headers so the embed can call it cross-origin.

## Notes
- The embed only renders for the manual UPI method and only while unpaid.
- Detection is still manual-UTR (you approve). Add the SMS/Gmail observer later to
  auto-confirm; both paths run through the same confirm → mark-as-paid hook.
