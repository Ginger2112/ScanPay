// YouPI-PG (Careatic) — single-process demo server.
// Serves storefront, checkout, admin, the payment API, and a live SSE stream.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { config } from './config.js';
import {
  bus, createOrder, getOrder, listOrders, startPayment,
  markPaid, confirm, expireDue, stats, customers, funnel,
  setCustomer, issueOtp, verifyOtp, abandoned,
  submitUtr, approveUtr, rejectUtr, pendingApprovals,
  recordCredit, verifyUtrAgainstCredits, assignCredit, listCredits,
  needsAttention, markCreditAlerted, markOrderAlerted, cancelOrder,
  markPaidByHand, cancelOpenOrders,
} from './lib/orders.js';
import { upiQrSvg, upiString } from './lib/qr.js';
import QRCode from 'qrcode';
import * as M from './lib/merchants.js';
import { parseCredit } from './lib/parse-bank.js';
import { sendWebhook } from './lib/webhook.js';
import * as settings from './lib/settings.js';
import { initOtp, deliverOtp, waReady } from './lib/otp.js';
import * as shopify from './lib/shopify.js';
import { notifyMerchant } from './lib/alerts.js';
import { parseAxisCredit } from './lib/parse-axis.js';
import * as auth from './lib/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.apk': 'application/vnd.android.package-archive' };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-observer-token,authorization,x-partner-key',
};

// Public base URL for links printed into QRs (pairing, checkout).
const baseUrl = (req) => config.publicUrl
  || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
const bearer = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

async function pairingPayload(req, merchantId) {
  const p = M.newPairing(merchantId);
  const url = `${baseUrl(req)}/pair/${p.code}`;
  const qr_svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { code: p.code, url, qr_svg, expires_at: p.expires_at, apk_url: `${baseUrl(req)}/scantopay-observer.apk` };
}

// What an API caller gets back for a payment: everything needed to show its own pay screen.
function paymentView(req, order) {
  const m = M.getMerchant(order.merchant_id);
  const pay = order.pay_amount ?? order.amount;
  return {
    id: order.id, status: order.status, amount: order.amount, pay_amount: pay, currency: order.currency,
    vpa: order.vpa || m.vpa, payee_name: m.name, ref: order.ref, ref_name: order.ref_name, utr: order.utr || null,
    expires_at: order.expires_at, paid_at: order.paid_at, confirmed_at: order.confirmed_at,
    test_mode: !!m.test_mode, return_url: order.return_url || null,
    upi_url: upiString({ amount: pay, note: order.ref_name || order.id, vpa: order.vpa || m.vpa, name: m.name }),
    checkout_url: `${baseUrl(req)}/checkout?id=${order.id}`,
  };
}

// Which merchant is this phone? Unknown token -> 401 'bad observer token';
// an unlinked phone (or its merchant left) -> 401 'phone unlinked' so the app can say so.
function observerMerchant(req, res) {
  const token = req.headers['x-observer-token'];
  const m = M.merchantForObserver(token);
  if (m) return m;
  if (M.phoneUnlinked(token)) { json(res, 401, { error: 'phone unlinked' }); return null; }
  console.log(`[phone] REJECTED: wrong observer token from ${auth.clientIp(req)}`);
  json(res, 401, { error: 'bad observer token' });
  return null;
}
// Code-guessing routes (pairing, invites): 20 per IP per 10 min, then 429.
function limited(req, res, bucket) {
  if (auth.rateOk(bucket, auth.clientIp(req))) return false;
  json(res, 429, { error: 'Too many tries. Wait 10 minutes and try again.' });
  return true;
}
const json = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', ...CORS, ...headers });
  res.end(JSON.stringify(obj));
};

// v1 error body for a refused mark-paid / assign; a too-small credit also says both amounts.
const refusal = (r) => (r.code ? { error: r.reason, code: r.code, credit_amount: r.credit_amount, pay_amount: r.pay_amount } : { error: r.reason });

// Merchant-only API routes. Buyer checkout + observer routes stay public
// (observers are protected by their own token).
const ADMIN_ROUTES = new Set(['stats', 'funnel', 'customers', 'abandoned', 'pending',
  'credits', 'settings', 'otp', 'dev', 'merchants', 'invites']);
function needsAdmin(seg, method) {
  if (ADMIN_ROUTES.has(seg[1])) return true;
  if (seg[1] === 'orders' && seg.length === 2 && method === 'GET') return true; // order list
  if (seg[1] === 'orders' && ['approve', 'reject'].includes(seg[3])) return true;
  return false;
}
const readBody = (req) => new Promise((resolve) => {
  let d = ''; req.on('data', (c) => (d += c));
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
});

async function serveFile(res, file) {
  try {
    const buf = await readFile(join(PUBLIC, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'text/plain' });
    res.end(buf);
  } catch { json(res, 404, { error: 'not found' }); }
}

// When a payment is detected we confirm the order, fire the signed webhook,
// and (if this order came from Shopify) mark the Shopify order paid.
// wait: false (the phone's observer routes) answers at once and lets the webhook + Shopify call
// run in the background: the phone gives up after 5s, the webhook alone can take 10s.
// A failed webhook is still retried by lib/webhook.js; the order is confirmed either way.
async function onPaid(order, { wait = true } = {}) {
  const confirmed = confirm(order.id);
  const outside = tellOutside(confirmed);
  if (wait) await outside;
  return confirmed;
}
async function tellOutside(confirmed) {
  try { await sendWebhook('order.paid', confirmed); }
  catch (e) { console.log(`[webhook] order.paid ${confirmed.id} FAILED: ${e.message}`); }
  if (confirmed.merchant_id === M.DEFAULT_ID && config.shopify.enabled && confirmed.ref && String(confirmed.ref).startsWith('gid://shopify/Order/')) {
    try {
      const o = await shopify.markOrderPaid(confirmed.ref);
      console.log(`[shopify] ${confirmed.ref} -> ${o.displayFinancialStatus}`);
    } catch (e) {
      console.log(`[shopify] mark-as-paid FAILED for ${confirmed.ref}: ${e.message}`);
    }
  }
}

// One entry point for every detected bank credit (Android SMS/push, Gmail, dev).
// Matching (and de-dup of a replayed SMS) is synchronous, so a repost can never pay twice.
async function ingestCredit({ amount, utr, payer, source, raw, merchant_id = M.DEFAULT_ID }, { wait = true } = {}) {
  const r = recordCredit({ amount, utr, payer, source, raw, merchant_id });
  if (r.matched) {
    const confirmed = await onPaid(r.order, { wait });
    console.log(`[credit:${source || '?'}] ₹${amount} utr=${utr || 'n/a'} -> ${confirmed.id} (by ${r.how})`);
    return { matched: true, order_id: confirmed.id, how: r.how };
  }
  console.log(`[credit:${source || '?'}] ₹${amount} utr=${utr || 'n/a'} not matched (${r.reason})`);
  return { matched: false, reason: r.reason };
}

// Test-mode merchants only: pay an order with a made-up bank credit. It goes through the same
// matching + confirm + signed webhook as a real SMS, so the merchant's side is tested for real.
async function testPay(order) {
  const m = M.getMerchant(order.merchant_id);
  if (!m || !m.test_mode) return { status: 403, body: { error: 'test payments only work for a test-mode merchant' } };
  if (['paid', 'confirmed'].includes(order.status)) return { status: 200, body: { matched: true, order_id: order.id, already: true } };
  if (!['awaiting_payment', 'expired', 'utr_submitted'].includes(order.status)) return { status: 409, body: { error: `payment is ${order.status}` } };
  const utr = 'TEST' + String(Date.now()).slice(-8);
  const r = await ingestCredit({ amount: order.pay_amount ?? order.amount, utr, source: 'test-mode', raw: 'TEST MODE: no real money', merchant_id: m.id });
  return { status: r.matched ? 200 : 409, body: r };
}
// The merchant's own https page, to send the buyer back to after paying.
function cleanReturnUrl(u) {
  if (!u) return null;
  try { const x = new URL(String(u)); return x.protocol === 'https:' || (config.demoMode && x.protocol === 'http:') ? x.toString().slice(0, 500) : null; } catch { return null; }
}

// ===== Merchant API v1 =====
// Auth:  merchant calls  -> "Authorization: Bearer sk_live_…" (the merchant's own key)
//        partner calls   -> "x-partner-key: …" (a platform onboarding its users, e.g. Tably)
//        self-signup     -> an invite code from Arun (invite-only while we pilot)
// A merchant key only ever sees and changes that merchant's own payments.
async function v1(req, res, url, seg) {
  const method = req.method;

  // GET /api/v1/pair/:code -> what the pairing page shows (public; the code is the secret)
  if (seg[2] === 'pair' && seg[3] && method === 'GET') {
    if (limited(req, res, 'pair-info')) return;
    const p = M.pairingInfo(seg[3]);
    if (!p) return json(res, 404, { error: 'unknown pairing code' });
    if (!p.valid) return json(res, 200, { valid: false }); // a used/expired code never reveals the business
    return json(res, 200, { merchant_name: p.merchant_name, valid: p.valid, expires_at: p.expires_at, server: baseUrl(req),
      apk_url: `${baseUrl(req)}/scantopay-observer.apk` });
  }

  // POST /api/v1/merchants  (partner) {name, vpa, external_ref, webhook_url?, rotate?}
  if (seg[2] === 'merchants' && seg.length === 3 && method === 'POST') {
    const partner = M.partnerFromKey(req.headers['x-partner-key']);
    if (!partner) return json(res, 401, { error: 'partner key required' });
    const b = await readBody(req);
    if (!b.external_ref) return json(res, 400, { error: 'external_ref required (your own id for this business)' });
    const r = M.createMerchant({ name: b.name, vpa: b.vpa, webhook_url: b.webhook_url, partner, external_ref: b.external_ref, rotate: !!b.rotate });
    console.log(`[merchant] ${r.created ? 'created' : 'updated'} ${r.merchant.id} "${r.merchant.name}" via ${partner}`);
    return json(res, r.created ? 201 : 200, { ...r, pairing: await pairingPayload(req, r.merchant.id) });
  }

  // POST /api/v1/signup  {invite, name, vpa, webhook_url?}  -> the /start page
  if (seg[2] === 'signup' && method === 'POST') {
    if (limited(req, res, 'signup')) return;
    const b = await readBody(req);
    if (!M.inviteOk(b.invite)) return json(res, 403, { error: 'This invite link is used or not valid. Ask ScanPay for a new one.' });
    const r = M.createMerchant({ name: b.name, vpa: b.vpa, webhook_url: b.webhook_url });
    M.useInvite(b.invite, r.merchant.id);
    console.log(`[merchant] signed up ${r.merchant.id} "${r.merchant.name}"`);
    return json(res, 201, { ...r, pairing: await pairingPayload(req, r.merchant.id) });
  }

  // Everything below needs the merchant's own API key.
  const m = M.byApiKey(bearer(req));
  if (!m) return json(res, 401, { error: 'API key required (Authorization: Bearer sk_live_…)' });

  // GET/POST /api/v1/me
  if (seg[2] === 'me' && seg.length === 3) {
    if (method === 'POST') {
      const b = await readBody(req);
      const updated = M.updateMerchant(m.id, b);
      return json(res, 200, { merchant: updated, phone: M.phoneStatus(m.id) });
    }
    return json(res, 200, { merchant: M.publicView(m), phone: M.phoneStatus(m.id), webhook_secret: m.webhook_secret });
  }
  // POST /api/v1/me/pairing -> fresh pairing QR (10 min, single use)
  if (seg[2] === 'me' && seg[3] === 'pairing' && method === 'POST') {
    return json(res, 200, await pairingPayload(req, m.id));
  }
  // POST /api/v1/me/rotate-key -> new API key, old one stops working at once
  if (seg[2] === 'me' && seg[3] === 'rotate-key' && method === 'POST') {
    return json(res, 200, { api_key: M.rotateKey(m.id) });
  }
  // POST /api/v1/me/phones/revoke -> unlink every phone (lost / sold / changed phone)
  if (seg[2] === 'me' && seg[3] === 'phones' && seg[4] === 'revoke' && method === 'POST') {
    const n = M.revokePhones(m.id);
    console.log(`[phone] ${m.id} unlinked ${n} phone(s)`);
    return json(res, 200, { revoked: n });
  }
  // POST /api/v1/me/deactivate -> leave ScanPay: key dies, phones unlinked, open payments cancelled, UPI ID freed.
  // A partner can bring the merchant back later (POST /api/v1/merchants) and gets a fresh key.
  if (seg[2] === 'me' && seg[3] === 'deactivate' && method === 'POST') {
    const phones = M.deactivate(m.id);
    const cancelled = cancelOpenOrders(m.id);
    console.log(`[merchant] deactivated ${m.id} (${phones} phone(s) unlinked, ${cancelled} payment(s) cancelled)`);
    return json(res, 200, { ok: true });
  }

  // POST /api/v1/payments {amount, ref?, ref_name?, items?, customer?, ttl_sec?}
  if (seg[2] === 'payments' && seg.length === 3 && method === 'POST') {
    const b = await readBody(req);
    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!(amount >= 1)) return json(res, 400, { error: 'amount must be at least ₹1' });
    if (amount > 100000) return json(res, 400, { error: 'amount above ₹1,00,000 needs a different payment method' });
    const o = createOrder({ amount, items: Array.isArray(b.items) ? b.items.slice(0, 100) : [], customer: b.customer || {},
      ref: b.ref ? String(b.ref).slice(0, 120) : null, ref_name: b.ref_name ? String(b.ref_name).slice(0, 60) : null, merchant_id: m.id,
      amount_locked: !!b.amount_locked, return_url: cleanReturnUrl(b.return_url) });
    const started = startPayment(o.id, { ttlSec: b.ttl_sec });
    return json(res, 201, paymentView(req, started.order));
  }
  // GET /api/v1/payments
  if (seg[2] === 'payments' && seg.length === 3 && method === 'GET') {
    return json(res, 200, listOrders(Math.min(Number(url.searchParams.get('limit')) || 50, 200), m.id).map((o) => paymentView(req, o)));
  }
  if (seg[2] === 'payments' && seg[3]) {
    const o = getOrder(seg[3]);
    if (!o || o.merchant_id !== m.id) return json(res, 404, { error: 'no such payment' });
    // GET /api/v1/payments/:id
    if (seg.length === 4 && method === 'GET') return json(res, 200, paymentView(req, o));
    // POST /api/v1/payments/:id/test-pay -> test-mode merchant only: pay it with a fake credit
    if (seg[4] === 'test-pay' && method === 'POST') {
      const r = await testPay(o);
      return json(res, r.status, r.status === 200 ? paymentView(req, getOrder(o.id)) : r.body);
    }
    // POST /api/v1/payments/:id/cancel -> e.g. the bill was paid in cash instead
    if (seg[4] === 'cancel' && method === 'POST') {
      if (['paid', 'confirmed'].includes(o.status)) return json(res, 409, { error: `payment is already ${o.status}` });
      if (o.status === 'cancelled') return json(res, 200, paymentView(req, o));
      return json(res, 200, paymentView(req, cancelOrder(o.id)));
    }
    // POST /api/v1/payments/:id/mark-paid {utr?} -> the merchant checked their bank app (iPhone, no SMS phone)
    if (seg[4] === 'mark-paid' && method === 'POST') {
      if (['paid', 'confirmed'].includes(o.status)) return json(res, 200, paymentView(req, o));
      if (!['awaiting_payment', 'utr_submitted', 'expired'].includes(o.status)) return json(res, 409, { error: `payment is ${o.status}` });
      const b = await readBody(req);
      const utr = String(b.utr || '').replace(/\D/g, '');
      if (utr && (utr.length < 9 || utr.length > 22)) return json(res, 400, { error: 'UTR is 12 digits (leave it empty if you don\'t have it)' });
      // One bank credit can never pay two bills: a used UTR is refused, a stray credit with it is linked.
      const r = markPaidByHand(o.id, utr, { force: b.force === true });
      if (!r.ok) return json(res, 400, refusal(r));
      return json(res, 200, paymentView(req, await onPaid(r.order)));
    }
  }
  // POST /api/v1/credits/:id/assign {payment_id, force?} -> attach an unmatched bank credit to a payment.
  // A credit smaller than the payment is refused (code 'credit_too_small') unless force: true.
  if (seg[2] === 'credits' && seg[3] && seg[4] === 'assign' && method === 'POST') {
    const c = listCredits(500, m.id).find((x) => String(x.id) === seg[3]);
    if (!c) return json(res, 404, { error: 'no such credit' });
    const b = await readBody(req);
    const o = getOrder(b.payment_id);
    if (!o || o.merchant_id !== m.id) return json(res, 404, { error: 'no such payment' });
    const r = assignCredit(c.id, o.id, { force: b.force === true });
    if (!r.ok) return json(res, 400, refusal(r));
    return json(res, 200, paymentView(req, await onPaid(r.order)));
  }
  // GET /api/v1/credits -> this merchant's bank-credit ledger (matched + unmatched)
  if (seg[2] === 'credits' && method === 'GET') return json(res, 200, listCredits(100, m.id));

  // POST /api/v1/dev/sms {text, sender?} -> demo only: pretend this merchant's phone got a bank SMS
  if (config.demoMode && seg[2] === 'dev' && seg[3] === 'sms' && method === 'POST') {
    const b = await readBody(req);
    const c = parseCredit(b.text, b.sender || 'VM-HDFCBK');
    if (!c) return json(res, 200, { parsed: false, reason: 'not a UPI credit' });
    return json(res, 200, { parsed: c, ...(await ingestCredit({ ...c, source: 'dev-sms', raw: b.text, merchant_id: m.id })) });
  }

  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const seg = path.split('/').filter(Boolean); // e.g. ['api','orders','ord_x','start']

  // CORS preflight for the Shopify embed and other cross-origin callers.
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  // --- pages ---
  if (path === '/') { res.writeHead(302, { location: '/store' }); return res.end(); }
  if (path === '/store') return serveFile(res, 'store.html');
  if (path === '/checkout') return serveFile(res, 'checkout.html');
  if (path === '/admin' || path === '/dashboard') return serveFile(res, 'dashboard.html');
  if (path === '/app.css') return serveFile(res, 'app.css');
  // Android observer app download (open this link on the phone to install)
  if (path === '/scantopay-observer.apk') return serveFile(res, 'scantopay-observer.apk');
  // Multi-merchant: self-signup, merchant page, phone pairing, phone view, platform admin
  if (path === '/start') return serveFile(res, 'start.html');
  if (path === '/merchant') return serveFile(res, 'merchant.html');
  if (/^\/pair\/[A-Za-z0-9]{6,20}$/.test(path)) return serveFile(res, 'pair.html');
  if (path === '/phone') return serveFile(res, 'phone.html');
  if (path === '/admin/merchants') return serveFile(res, 'merchants-admin.html');
  if (path === '/scanoye.js') return serveFile(res, 'scanoye.js');
  if (path === '/scanoye.css') return serveFile(res, 'scanoye.css');
  // Installable app (iPhone "Add to Home Screen", Android "Install app")
  if (path === '/manifest.webmanifest') return serveFile(res, 'manifest.webmanifest');
  if (path === '/sw.js') return serveFile(res, 'sw.js');
  if (/^\/icons\/[a-z0-9-]+\.png$/.test(path)) return serveFile(res, path.slice(1));

  // --- API ---
  try {
    if (seg[0] === 'api') {
      // --- merchant login ---
      if (seg[1] === 'admin') {
        if (seg[2] === 'login' && req.method === 'POST') {
          const ip = auth.clientIp(req);
          if (!auth.loginAllowed(ip)) return json(res, 429, { error: 'too many attempts, try in 15 min' });
          const b = await readBody(req);
          if (!auth.checkPassword(b.password)) {
            auth.loginFailed(ip);
            console.log(`[admin] failed login from ${ip}`);
            return json(res, 401, { error: 'wrong password' });
          }
          return json(res, 200, { ok: true }, { 'set-cookie': auth.sessionCookie(req) });
        }
        if (seg[2] === 'logout' && req.method === 'POST') {
          return json(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie });
        }
        if (seg[2] === 'me' && req.method === 'GET') {
          if (!auth.isAdmin(req)) return json(res, 401, { error: 'login required' });
          return json(res, 200, { ok: true, demoMode: config.demoMode });
        }
      }
      if (needsAdmin(seg, req.method) && !auth.isAdmin(req)) {
        return json(res, 401, { error: 'login required' });
      }

      // ===== Merchant API v1 (any client: Tably, Doctro, Shopify stores, any website) =====
      if (seg[1] === 'v1') return await v1(req, res, url, seg);

      // ===== Platform admin: every merchant + invite links =====
      if (seg[1] === 'merchants' && seg.length === 2 && req.method === 'GET') return json(res, 200, M.listMerchants());
      // POST /api/merchants/:id/rotate-key -> merchant lost their key: Arun issues a new one (shown once)
      if (seg[1] === 'merchants' && seg[2] && seg[3] === 'rotate-key' && req.method === 'POST') {
        if (seg[2] === M.DEFAULT_ID) return json(res, 400, { error: 'the default merchant has no API key' });
        const mm = M.getMerchant(seg[2]);
        if (!mm) return json(res, 404, { error: 'no such merchant' });
        console.log(`[admin] new API key issued for ${mm.id}`);
        return json(res, 200, { api_key: M.rotateKey(mm.id) });
      }
      if (seg[1] === 'invites' && req.method === 'GET') {
        return json(res, 200, M.listInvites().map((i) => ({ ...i, url: `${baseUrl(req)}/start?invite=${i.code}` })));
      }
      if (seg[1] === 'invites' && req.method === 'POST') {
        const b = await readBody(req);
        const c = M.createInvite(b.note);
        return json(res, 201, { code: c, url: `${baseUrl(req)}/start?invite=${c}` });
      }

      // POST /api/orders
      if (seg[1] === 'orders' && seg.length === 2 && req.method === 'POST') {
        const b = await readBody(req);
        if (!b.amount || Number(b.amount) <= 0) return json(res, 400, { error: 'amount required' });
        // Public (store checkout): always Arun's default merchant. merchant_id / amount_locked
        // from the body are ignored; other merchants create payments with their own API key.
        const pick = { amount: b.amount, items: Array.isArray(b.items) ? b.items : [], customer: b.customer && typeof b.customer === 'object' ? b.customer : {},
          method: b.method === 'cod' ? 'cod' : 'upi', ref: b.ref ?? null, ref_name: b.ref_name ?? null };
        return json(res, 201, createOrder({ ...pick, merchant_id: M.DEFAULT_ID }));
      }
      // GET /api/orders
      if (seg[1] === 'orders' && seg.length === 2 && req.method === 'GET') {
        return json(res, 200, listOrders());
      }
      // GET /api/stats
      if (seg[1] === 'stats' && req.method === 'GET') return json(res, 200, stats());
      // GET /api/funnel?from=ms&to=ms  (range-aware funnel + method split)
      if (seg[1] === 'funnel' && req.method === 'GET') {
        const from = Number(url.searchParams.get('from')) || 0;
        const to = Number(url.searchParams.get('to')) || (Date.now() + 1);
        return json(res, 200, funnel({ from, to }));
      }
      // GET /api/customers
      if (seg[1] === 'customers' && req.method === 'GET') return json(res, 200, customers());
      // GET /api/abandoned
      if (seg[1] === 'abandoned' && req.method === 'GET') return json(res, 200, abandoned());
      // GET /api/pending  -> orders awaiting merchant UTR approval
      if (seg[1] === 'pending' && req.method === 'GET') return json(res, 200, pendingApprovals());
      // GET /api/otp/status  -> OTP channel health (for the dashboard)
      if (seg[1] === 'otp' && seg[2] === 'status' && req.method === 'GET') {
        return json(res, 200, { channel: config.otp.channel, whatsapp_ready: waReady() });
      }
      // GET/POST /api/settings
      if (seg[1] === 'settings') {
        if (req.method === 'GET') return json(res, 200, settings.current());
        if (req.method === 'POST') {
          const b = await readBody(req);
          const keys = ['merchant_name', 'merchant_vpa', 'webhook_url', 'webhook_secret', 'payment_timeout_sec'];
          for (const k of keys) if (b[k] !== undefined) settings.set(k, b[k]);
          settings.apply();
          return json(res, 200, settings.current());
        }
      }
      if (seg[1] === 'orders' && seg[2]) {
        const id = seg[2];
        const order = getOrder(id);
        if (!order) return json(res, 404, { error: 'no such order' });

        // GET /api/orders/:id  (+ which business, and whether it's a test-mode merchant)
        if (seg.length === 3 && req.method === 'GET') {
          const om = M.getMerchant(order.merchant_id);
          return json(res, 200, { ...order, merchant_name: om ? om.name : '', test_mode: !!(om && om.test_mode) });
        }
        // POST /api/orders/:id/test-pay -> the checkout's "Pay (test)" button; test-mode merchants only
        if (seg[3] === 'test-pay' && req.method === 'POST') {
          if (limited(req, res, 'test-pay')) return;
          const r = await testPay(order);
          return json(res, r.status, r.body);
        }

        // POST /api/orders/:id/customer {name,phone,email,consent} -> save + send OTP
        if (seg[3] === 'customer' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b.name || !b.phone) return json(res, 400, { error: 'name and phone required' });
          setCustomer(id, b);
          // Live mode without a real OTP channel: never show the code on screen.
          // Capture details, skip OTP, let the buyer pay (CRM shows them unverified).
          if (config.otp.channel === 'console' && !config.demoMode) {
            return json(res, 200, { sent: false, skip_otp: true });
          }
          const code = issueOtp(id);
          const d = await deliverOtp(b.phone, code); // WhatsApp if configured, else console
          if (!d.delivered) return json(res, 502, { error: d.error || 'otp delivery failed', channel: d.channel });
          return json(res, 200, { sent: true, channel: d.channel, otp_demo: d.demoCode });
        }
        // POST /api/orders/:id/verify {code}
        if (seg[3] === 'verify' && req.method === 'POST') {
          const b = await readBody(req);
          const r = verifyOtp(id, b.code);
          return json(res, r.ok ? 200 : 400, r);
        }
        // POST /api/orders/:id/start
        if (seg[3] === 'start' && req.method === 'POST') {
          return json(res, 200, startPayment(id));
        }
        // POST /api/orders/:id/utr {utr}  -> buyer submits the UPI reference.
        // If the bank SMS with that UTR already arrived, the order confirms right away.
        if (seg[3] === 'utr' && req.method === 'POST') {
          const b = await readBody(req);
          const r = submitUtr(id, b.utr);
          if (!r.ok) return json(res, 400, r);
          const paid = verifyUtrAgainstCredits(id);
          if (paid) return json(res, 200, { ok: true, confirmed: true, order: await onPaid(paid) });
          return json(res, 200, { ok: true, confirmed: false, order: r.order });
        }
        // POST /api/orders/:id/approve  -> merchant confirms a submitted UTR
        if (seg[3] === 'approve' && req.method === 'POST') {
          const o = approveUtr(id);
          if (!o) return json(res, 404, { error: 'no such order' });
          return json(res, 200, await onPaid(o));
        }
        // POST /api/orders/:id/reject  -> merchant rejects, buyer can re-submit
        if (seg[3] === 'reject' && req.method === 'POST') {
          const o = rejectUtr(id);
          if (!o) return json(res, 404, { error: 'no such order' });
          return json(res, 200, o);
        }
        // GET /api/orders/:id/qr
        if (seg[3] === 'qr' && req.method === 'GET') {
          const { data, svg } = await upiQrSvg({ amount: order.pay_amount ?? order.amount, note: order.id, vpa: order.vpa,
            name: M.getMerchant(order.merchant_id)?.name });
          return json(res, 200, { data, svg });
        }
        // GET /api/orders/:id/events  (SSE live status)
        if (seg[3] === 'events' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.write(`data: ${JSON.stringify({ type: order.status })}\n\n`);
          const listener = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
          bus.on(id, listener);
          req.on('close', () => bus.off(id, listener));
          return;
        }
      }

      // --- demo-only: stand in for the Gmail bank-alert observer ---
      if (config.demoMode && seg[1] === 'dev') {
        // POST /api/dev/simulate-payment/:id  -> pays a specific order
        if (seg[2] === 'simulate-payment' && seg[3] && req.method === 'POST') {
          const o = getOrder(seg[3]);
          if (!o) return json(res, 404, { error: 'no such order' });
          if (o.status !== 'awaiting_payment') return json(res, 409, { error: `order is ${o.status}` });
          const utr = 'DEMO' + Math.floor(Math.random() * 1e9);
          const paid = markPaid(o.id, { utr });
          const confirmed = await onPaid(paid);
          return json(res, 200, confirmed);
        }
        // POST /api/dev/seed  -> populate demo orders/customers so the CRM has history
        if (seg[2] === 'seed' && req.method === 'POST') {
          const buyers = [
            { name: 'Priya Sharma', phone: '98xxxx2201', email: 'priya@example.com', verified: true, consent: true },
            { name: 'Rahul Verma',  phone: '98xxxx8890', email: 'rahul@example.com', verified: true, consent: true },
            { name: 'Aisha Khan',   phone: '97xxxx4412', email: 'aisha@example.com', verified: true, consent: false },
            { name: 'Dev Patel',    phone: '96xxxx7756', email: 'dev@example.com', verified: true, consent: true },
          ];
          const cat = [['Winter Puffer Jacket', 899], ['Everyday Cotton Tee', 499],
            ['Knit Sweater', 749], ['Reflective Raincoat', 1099], ['Cooling Vest', 649]];
          let made = 0;
          for (let i = 0; i < 14; i++) {
            const b = buyers[i % buyers.length];
            const [name, price] = cat[Math.floor(Math.random() * cat.length)];
            const o = createOrder({ amount: price, items: [{ name, qty: 1, price }],
              customer: b, method: i % 5 === 0 ? 'cod' : 'upi' });
            if (o.method === 'upi') {
              startPayment(o.id);
              markPaid(o.id, { utr: 'SEED' + Math.floor(Math.random() * 1e9) });
              confirm(o.id);
            }
            made++;
          }
          // a couple of abandoned carts (verified details captured, never paid)
          for (const b of [buyers[2], buyers[1]]) {
            const [name, price] = cat[Math.floor(Math.random() * cat.length)];
            const o = createOrder({ amount: price, items: [{ name, qty: 1, price }], method: 'upi' });
            setCustomer(o.id, b); verifyOtp(o.id, issueOtp(o.id)); startPayment(o.id);
          }
          return json(res, 200, { seeded: made });
        }
        // POST /api/dev/credit {amount,utr}  -> simulates a parsed bank credit
        if (seg[2] === 'credit' && req.method === 'POST') {
          const b = await readBody(req);
          return json(res, 200, await ingestCredit({ ...b, source: 'dev' }));
        }
        // POST /api/dev/sms {text}  -> simulates a raw bank SMS hitting the Android phone
        if (seg[2] === 'sms' && req.method === 'POST') {
          const b = await readBody(req);
          const c = parseCredit(b.text, b.sender);
          if (!c) return json(res, 200, { parsed: false, reason: 'not a credit SMS' });
          return json(res, 200, { parsed: c, ...(await ingestCredit({ ...c, source: 'dev-sms', raw: b.text })) });
        }
      }

      // --- observer ingestion: Android (SMS/push) and Gmail observers POST credits here ---
      // POST /api/observer/credit {amount, utr, payer?, source, raw?}  (x-observer-token header)
      if (seg[1] === 'observer' && seg[2] === 'credit' && req.method === 'POST') {
        const m = observerMerchant(req, res);
        if (!m) return;
        const b = await readBody(req);
        if (!b.amount) return json(res, 400, { error: 'amount required' });
        return json(res, 200, await ingestCredit({ amount: b.amount, utr: b.utr, payer: b.payer, source: b.source, raw: b.raw, merchant_id: m.id }, { wait: false }));
      }

      // POST /api/observer/pair {code, device} -> the phone swaps the QR's one-time code for its own token.
      if (seg[1] === 'observer' && seg[2] === 'pair' && req.method === 'POST') {
        if (limited(req, res, 'pair')) return;
        const b = await readBody(req);
        const r = M.redeemPairing(b.code, b.device);
        if (!r) return json(res, 400, { error: 'This pairing code is used or expired. Show a fresh QR and scan again.' });
        console.log(`[phone] paired ${b.device || 'a phone'} to ${r.merchant.name} (${r.merchant.id})`);
        return json(res, 200, { token: r.token, merchant_id: r.merchant.id, merchant_name: r.merchant.name, server: baseUrl(req) });
      }
      // POST /api/observer/ping {sms_permission?, notification_access?} -> heartbeat so the merchant
      // sees "phone connected", plus whether the phone still has SMS / notification access.
      if (seg[1] === 'observer' && seg[2] === 'ping' && req.method === 'POST') {
        const m = observerMerchant(req, res);
        if (!m) return;
        const b = await readBody(req);
        M.recordPhoneHealth(req.headers['x-observer-token'], b);
        return json(res, 200, { ok: true, merchant_name: m.name });
      }
      // GET /api/observer/summary -> what the phone's own screen shows (its merchant only)
      if (seg[1] === 'observer' && seg[2] === 'summary' && req.method === 'GET') {
        const m = observerMerchant(req, res);
        if (!m) return;
        return json(res, 200, { merchant: M.publicView(m), stats: stats(m.id),
          payments: listOrders(30, m.id).map((o) => paymentView(req, o)), credits: listCredits(30, m.id) });
      }

      // POST /api/observer/sms {text, sender?, source}  -> raw bank SMS from the Android app.
      // Parsed here (not on the phone) so bank-format fixes never need a new app build.
      // Debits / non-UPI messages are ignored and not stored.
      if (seg[1] === 'observer' && seg[2] === 'sms' && req.method === 'POST') {
        const m = observerMerchant(req, res);
        if (!m) return;
        const b = await readBody(req);
        const c = parseCredit(b.text, b.sender);
        // Never log the SMS text itself (it can carry balances, OTPs, names): sender + outcome only.
        const from = String(b.sender || '?').slice(0, 40);
        if (!c) {
          console.log(`[phone:${m.id}] ${from}: ignored`);
          return json(res, 200, { parsed: false, matched: false, reason: 'not a UPI credit' });
        }
        console.log(`[phone:${m.id}] ${from}: UPI credit ₹${c.amount} utr=${c.utr || 'n/a'}`);
        return json(res, 200, { parsed: c, ...(await ingestCredit({ ...c, source: b.source || 'android', raw: b.text, merchant_id: m.id }, { wait: false })) });
      }

      // --- bank credit ledger (exceptions view) ---
      // GET /api/credits
      if (seg[1] === 'credits' && seg.length === 2 && req.method === 'GET') {
        return json(res, 200, listCredits());
      }
      // POST /api/credits/:id/assign {order_id}  -> merchant attaches an unmatched credit
      if (seg[1] === 'credits' && seg[2] && seg[3] === 'assign' && req.method === 'POST') {
        const b = await readBody(req);
        const r = assignCredit(Number(seg[2]), b.order_id, { force: b.force === true });
        if (!r.ok) return json(res, 400, r);
        return json(res, 200, { ok: true, order: await onPaid(r.order) });
      }
    }
  } catch (e) {
    return json(res, 400, { error: e.message });
  }

  json(res, 404, { error: 'not found' });
});

// expire overdue payment windows every 5s
setInterval(() => { const n = expireDue(); if (n) console.log(`[sweeper] expired ${n}`); }, 5000);

// Every minute: alert the merchant about anything automation couldn't resolve.
setInterval(async () => {
  const { credits, stuckUtr } = needsAttention();
  for (const c of credits) {
    // Other merchants hear about it on their own webhook (their app shows it); Arun's default gets WhatsApp.
    if (c.merchant_id && c.merchant_id !== M.DEFAULT_ID) {
      await sendWebhook('credit.unmatched', { id: null, merchant_id: c.merchant_id, amount: c.amount, currency: 'INR', utr: c.utr, status: 'unmatched' },
        { credit_id: c.id, payer: c.payer });
      markCreditAlerted(c.id);
      continue;
    }
    await notifyMerchant(`₹${c.amount} received${c.payer ? ' from ' + c.payer : ''} (UTR ${c.utr || 'n/a'}) `
      + `but no order matched. Open ScanPay → Orders → Bank credits to assign it.`);
    markCreditAlerted(c.id);
  }
  for (const o of stuckUtr) {
    if (o.merchant_id && o.merchant_id !== M.DEFAULT_ID) { markOrderAlerted(o.id); continue; }
    await notifyMerchant(`Order ${o.id} (₹${o.pay_amount ?? o.amount}): buyer says paid, UTR ${o.utr}, `
      + `but no bank SMS in 10 min. Check your bank app.`);
    markOrderAlerted(o.id);
  }
}, 60 * 1000);

server.listen(config.port, () => {
  console.log(`\n  ScanPay (Careatic demo) running`);
  console.log(`  Store      http://localhost:${config.port}/store`);
  console.log(`  Admin      http://localhost:${config.port}/admin`);
  console.log(`  Merchant   ${config.merchant.name}  VPA ${config.merchant.vpa}`);
  console.log(`  Demo mode  ${config.demoMode ? 'ON (simulated payments enabled)' : 'off'}`);
  console.log(`  OTP        ${config.otp.channel}\n`);
  initOtp(); // spins up WhatsApp only when OTP_CHANNEL=whatsapp
});
