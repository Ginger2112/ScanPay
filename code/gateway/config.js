// Central demo config. In production these come from env / admin panel.
export const config = {
  port: Number(process.env.PORT || 6100),

  // Merchant receiving account (DEMO values — not a real VPA).
  merchant: {
    name: process.env.MERCHANT_NAME || 'Scantopay',
    // UPI VPA money is collected into (AU Bank account behind a GPay handle).
    vpa: process.env.MERCHANT_VPA || 'arunsamanta17-1@okaxis',
    // WhatsApp number that gets "payment needs attention" alerts (e.g. 919xxxxxxxxx).
    alertPhone: process.env.MERCHANT_ALERT_PHONE || '',
  },

  // How long a buyer has to pay before the QR window closes.
  paymentTimeoutSec: Number(process.env.PAY_TIMEOUT || 300),

  // Each order's QR carries a unique paise amount (e.g. ₹899.37) so a bank credit
  // matches exactly one order, even with many buyers paying at once.
  uniqueAmounts: process.env.UNIQUE_AMOUNTS !== 'off',
  // A payment that lands after the QR window still matches within this grace period.
  matchGraceMin: Number(process.env.MATCH_GRACE_MIN || 30),

  // Single-slot queue (one buyer per VPA at a time). Not needed with unique
  // amounts; kept for setups that turn uniqueAmounts off.
  get queueEnabled() { return !this.uniqueAmounts; },

  // Merchant webhook (store backend). Demo logs instead of posting if unset.
  webhook: {
    url: process.env.WEBHOOK_URL || '',
    secret: process.env.WEBHOOK_SECRET || 'demo-webhook-secret',
    // A failed delivery is re-sent this many ms later (10s, 1 min, 5 min, 15 min). Tests shorten it.
    retryDelaysMs: (process.env.WEBHOOK_RETRY_DELAYS || '10000,60000,300000,900000').split(',').map(Number).filter((n) => n > 0),
  },

  // Demo mode exposes /api/dev/* endpoints that simulate a bank credit.
  // The real build replaces this with the Gmail bank-alert observer.
  demoMode: process.env.DEMO_MODE !== 'off',

  // Observer ingestion: the Gmail/Android observers POST detected credits here,
  // authenticated with this shared token (x-observer-token header).
  // Live (DEMO_MODE=off) without OBSERVER_TOKEN: the shared legacy token is switched off.
  observer: {
    token: process.env.OBSERVER_TOKEN || (process.env.DEMO_MODE !== 'off' ? 'dev-observer-token' : ''),
  },

  // Platforms that onboard their own users in one click (Tably, Doctro ...):
  // "name:secret,name2:secret2". No built-in default: unset = partner API off.
  partnerKeys: process.env.PARTNER_KEYS || '',

  // Public address printed into pairing QRs (e.g. https://pay.arunsamanta.com).
  // Unset = taken from the request's Host header.
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),

  // Behind a reverse proxy on the same box (Caddy on live): TRUST_PROXY=1 reads the real client IP
  // from cf-connecting-ip / x-forwarded-for, but only on connections that come from localhost.
  // Off = the socket address is used and those headers are ignored (anyone could fake them).
  trustProxy: process.env.TRUST_PROXY === '1',

  // Merchant dashboard + admin API login. Unset = admin API locked for everyone.
  admin: {
    password: process.env.ADMIN_PASSWORD || '',
    sessionDays: Number(process.env.ADMIN_SESSION_DAYS || 7),
  },

  // Shopify connector (Jazz94). When store + token are set, a confirmed order
  // that carries a Shopify order ref is auto-marked paid via the Admin API.
  shopify: {
    store: process.env.SHOPIFY_STORE || '',            // e.g. jazz94.myshopify.com
    token: process.env.SHOPIFY_ADMIN_TOKEN || '',      // custom-app Admin API token (write_orders)
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-10',
    get enabled() { return !!(this.store && this.token); },
  },

  // OTP delivery channel for checkout verification.
  //   'console'  — demo: code returned to the UI / logged (default)
  //   'whatsapp' — real: sent over WhatsApp via Baileys (pair once by QR)
  otp: {
    channel: process.env.OTP_CHANNEL || 'console',
    brand: process.env.OTP_BRAND || 'Careatic',
  },
};
