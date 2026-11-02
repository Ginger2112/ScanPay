// Order lifecycle + state machine + live event bus + single-slot UPI queue.
import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { db } from './db.js';
import { config } from '../config.js';
import { getMerchant, DEFAULT_ID } from './merchants.js';

export const bus = new EventEmitter();
bus.setMaxListeners(0);

// Allowed transitions. Anything not listed is rejected.
const TRANSITIONS = {
  created:          ['awaiting_payment', 'cod_pending', 'cancelled'],
  awaiting_payment: ['paid', 'utr_submitted', 'expired', 'cancelled'],
  utr_submitted:    ['paid', 'awaiting_payment', 'expired', 'cancelled'], // merchant approves/rejects
  cod_pending:      ['confirmed', 'cancelled'],
  paid:             ['confirmed'],
  confirmed:        [],
  expired:          ['awaiting_payment', 'paid', 'cancelled'], // retry, a late payment within grace, or the caller cancels
  cancelled:        [],
};

const now = () => Date.now();
const genId = () => 'ord_' + randomBytes(6).toString('hex');

function row(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

function logEvent(orderId, type, detail = '') {
  db.prepare('INSERT INTO events (order_id, type, detail, at) VALUES (?,?,?,?)')
    .run(orderId, type, String(detail), now());
  bus.emit(orderId, { type, detail, at: now() });
  bus.emit('*', { orderId, type, detail, at: now() });
}

export function createOrder({ amount, items = [], customer = {}, method = 'upi', ref = null, ref_name = null, merchant_id = DEFAULT_ID, amount_locked = false }) {
  const id = genId();
  db.prepare(`INSERT INTO orders (id, amount, items_json, customer_json, method, status, created_at, ref, ref_name, merchant_id, amount_locked)
              VALUES (?,?,?,?,?, 'created', ?,?,?,?,?)`)
    .run(id, Number(amount), JSON.stringify(items), JSON.stringify(customer), method, now(), ref, ref_name, merchant_id, amount_locked ? 1 : 0);
  logEvent(id, 'created', `amount=${amount} method=${method}${ref ? ' ref=' + ref : ''}`);
  return getOrder(id);
}

// --- verified customer capture + OTP (first-party data, owned by the merchant) ---
const otps = new Map(); // orderId -> { code, at }

export function setCustomer(id, customer = {}) {
  const o = row(id);
  if (!o) throw new Error('no such order');
  const prev = JSON.parse(o.customer_json || '{}');
  const merged = { ...prev, name: customer.name ?? prev.name, phone: customer.phone ?? prev.phone,
    email: customer.email ?? prev.email, consent: !!customer.consent, verified: prev.verified || false };
  db.prepare('UPDATE orders SET customer_json = ? WHERE id = ?').run(JSON.stringify(merged), id);
  logEvent(id, 'details_captured', `${merged.name || ''} ${merged.phone || ''}`);
  return getOrder(id);
}

export function issueOtp(id) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  otps.set(id, { code, at: now() });
  logEvent(id, 'otp_sent');
  return code; // real build sends via WhatsApp/SMS; demo returns it to the UI
}

export function verifyOtp(id, code) {
  const rec = otps.get(id);
  if (!rec) return { ok: false, reason: 'no_otp' };
  if (String(code) !== rec.code) return { ok: false, reason: 'bad_code' };
  const o = row(id);
  const cust = JSON.parse(o.customer_json || '{}');
  cust.verified = true; cust.verified_at = now();
  db.prepare('UPDATE orders SET customer_json = ? WHERE id = ?').run(JSON.stringify(cust), id);
  otps.delete(id);
  logEvent(id, 'customer_verified');
  return { ok: true, order: getOrder(id) };
}

export function getOrder(id) {
  const r = row(id);
  if (!r) return null;
  return {
    ...r,
    items: JSON.parse(r.items_json),
    customer: JSON.parse(r.customer_json),
  };
}

// merchantId = null lists every merchant (platform admin).
export function listOrders(limit = 100, merchantId = DEFAULT_ID) {
  const rows = merchantId
    ? db.prepare('SELECT * FROM orders WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?').all(merchantId, limit)
    : db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows
    .map((r) => ({ ...r, items: JSON.parse(r.items_json), customer: JSON.parse(r.customer_json) }));
}

function setStatus(id, next, patch = {}) {
  const o = row(id);
  if (!o) throw new Error('no such order');
  const allowed = TRANSITIONS[o.status] || [];
  if (o.status !== next && !allowed.includes(next)) {
    throw new Error(`illegal transition ${o.status} -> ${next}`);
  }
  const cols = ['status = ?'];
  const vals = [next];
  for (const [k, v] of Object.entries(patch)) { cols.push(`${k} = ?`); vals.push(v); }
  vals.push(id);
  db.prepare(`UPDATE orders SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  logEvent(id, next);
  return getOrder(id);
}

// --- single-slot queue (one active payer per VPA) ---
function activeHolder(vpa) {
  return db.prepare(
    `SELECT id FROM orders WHERE vpa = ? AND status = 'awaiting_payment' AND expires_at > ? LIMIT 1`,
  ).get(vpa, now());
}

// --- unique payable amount per order ---
const round2 = (n) => Math.round(n * 100) / 100;
const graceMs = () => config.matchGraceMin * 60 * 1000;

// Orders that could still receive a payment: open QR, UTR pending, or recently expired.
const LIVE_SQL = `(status IN ('awaiting_payment','utr_submitted')
                   OR (status = 'expired' AND expires_at > ?))`;

// The same payment often shows up twice (bank SMS + UPI-app push) within a few minutes.
const TWIN_MS = 3 * 60 * 1000;

// An amount stays held (not handed to a new order) while a payment could still arrive for it:
//   - live orders (open QR, UTR pending, recently expired)
//   - cancelled within the grace window: a late payment for it must not confirm someone else
//   - marked paid by hand with no bank credit linked yet, within grace: its SMS may still come
//   - paid in the last 3 minutes: its SMS/push twin may still come
const HELD_SQL = `(${LIVE_SQL}
  OR (status = 'cancelled' AND cancelled_at > ?)
  OR (status IN ('paid','confirmed') AND (paid_at > ?
      OR (paid_at > ? AND NOT EXISTS (SELECT 1 FROM credits c WHERE c.order_id = orders.id)))))`;

// Unique amounts only need to be unique per merchant: each merchant has its own bank account.
function payAmountTaken(pay, exceptId, merchantId) {
  const cutoff = now() - graceMs();
  return !!db.prepare(
    `SELECT 1 FROM orders WHERE ${HELD_SQL} AND merchant_id = ? AND ABS(pay_amount - ?) < 0.001 AND id != ? LIMIT 1`,
  ).get(cutoff, cutoff, now() - TWIN_MS, cutoff, merchantId, pay, exceptId);
}

// The buyer is never charged more than the listed price. The exact price is used
// when no other live order holds it; otherwise a few paise come OFF (₹899 → ₹898.63)
// so each live order still has a unique amount. Never below ₹1 (UPI minimum).
function assignPayAmount(o) {
  const base = Number(o.amount);
  const m = o.merchant_id;
  if (o.pay_amount && o.pay_amount <= base && !payAmountTaken(o.pay_amount, o.id, m)) return o.pay_amount;
  if (!payAmountTaken(base, o.id, m)) return base;
  const shuffle = (a) => a.sort(() => Math.random() - 0.5);
  for (const p of shuffle(Array.from({ length: 99 }, (_, i) => i + 1))) {
    const pay = round2(base - p / 100);
    if (pay >= 1 && !payAmountTaken(pay, o.id, m)) return pay;
  }
  throw new Error('checkout busy for this price — please retry in a few minutes');
}

// ttlSec: how long the QR stays open (API callers like a restaurant bill may want longer).
export function startPayment(id, { ttlSec } = {}) {
  const o = row(id);
  if (!o) throw new Error('no such order');
  // A reload must not reopen an order that's already past the QR stage.
  if (['utr_submitted', 'paid', 'confirmed'].includes(o.status)) {
    return { queued: false, order: getOrder(id) };
  }
  const merchant = getMerchant(o.merchant_id);
  if (!merchant || !merchant.active) throw new Error('merchant is not active');
  const vpa = merchant.vpa;

  if (config.queueEnabled) {
    const holder = activeHolder(vpa);
    if (holder && holder.id !== id) {
      logEvent(id, 'queued', `behind ${holder.id}`);
      return { queued: true, holder: holder.id, order: getOrder(id) };
    }
  }

  const pay_amount = config.uniqueAmounts ? assignPayAmount(o) : Number(o.amount);
  const ttl = Math.min(Math.max(Number(ttlSec) || config.paymentTimeoutSec, 60), 3600);
  const expires = now() + ttl * 1000;
  const order = setStatus(id, 'awaiting_payment', { vpa, expires_at: expires, pay_amount });
  return { queued: false, order };
}

// Called by the observer (or the demo simulate endpoint) when a credit lands.
export function markPaid(id, { utr } = {}) {
  const patch = { paid_at: now() };
  if (utr) patch.utr = utr; // keep a UTR the buyer already submitted
  const order = setStatus(id, 'paid', patch);
  logEvent(id, 'payment_detected', `utr=${utr || 'n/a'}`);
  return order;
}

// The merchant's app closed this payment another way (cash, card, bill changed).
export function cancelOrder(id) {
  return setStatus(id, 'cancelled', { cancelled_at: now() });
}

// Merchant left Scan Oye: close every payment that could still be paid.
export function cancelOpenOrders(merchantId) {
  const open = db.prepare(`SELECT id FROM orders WHERE merchant_id = ? AND status IN ('awaiting_payment','utr_submitted','expired')`).all(merchantId);
  for (const { id } of open) cancelOrder(id);
  return open.length;
}

export function confirm(id) {
  return setStatus(id, 'confirmed', { confirmed_at: now() });
}

// --- manual UTR confirmation (iPhone-friendly, no SMS observer needed) ---
// Buyer submits the UPI reference shown in their app; merchant approves in the CRM.
export function submitUtr(id, utr) {
  const o = row(id);
  if (!o) return { ok: false, reason: 'no_such_order' };
  const clean = String(utr || '').replace(/\D/g, '');
  if (clean.length < 9 || clean.length > 22) return { ok: false, reason: 'bad_utr' };
  if (utrSeen(clean, o.merchant_id)) return { ok: false, reason: 'duplicate_utr' };
  if (!['awaiting_payment', 'utr_submitted'].includes(o.status)) {
    return { ok: false, reason: `order is ${o.status}` };
  }
  const order = setStatus(id, 'utr_submitted', { utr: clean });
  logEvent(id, 'utr_submitted', clean);
  return { ok: true, order };
}

// Merchant marks a payment paid after checking the bank app. One UTR can pay only one bill:
// refused if another payment already has it; an unmatched bank credit with it gets linked.
export function markPaidByHand(id, utr, { force = false } = {}) {
  const o = row(id);
  if (!o) return { ok: false, reason: 'no such payment' };
  if (utr) {
    const used = 'This UTR is already used on another payment';
    if (db.prepare('SELECT 1 FROM orders WHERE utr = ? AND merchant_id = ? AND id != ? LIMIT 1').get(utr, o.merchant_id, id)) return { ok: false, reason: used };
    const c = db.prepare('SELECT id, amount, status, order_id FROM credits WHERE utr = ? AND merchant_id = ? LIMIT 1').get(utr, o.merchant_id);
    if (c && c.status === 'matched' && c.order_id !== id) return { ok: false, reason: used };
    if (c && c.status === 'unmatched') {
      const small = creditTooSmall(c, o, force);
      if (small) return small;
      return { ok: true, order: payOrder(id, utr, c.id) };
    }
  }
  return { ok: true, order: markPaid(id, { utr: utr || undefined }) };
}

// Merchant approves a submitted UTR -> mark paid (server then confirms + webhook).
export function approveUtr(id) {
  const o = row(id);
  if (!o) return null;
  return setStatus(id, 'paid', { paid_at: now() });
}

// Merchant rejects -> back to awaiting so the buyer can re-submit.
export function rejectUtr(id) {
  const o = row(id);
  if (!o) return null;
  const expires = now() + config.paymentTimeoutSec * 1000;
  return setStatus(id, 'awaiting_payment', { utr: null, expires_at: expires });
}

// Orders waiting on merchant approval (for the CRM queue).
export function pendingApprovals() {
  return listOrders(500).filter((o) => o.status === 'utr_submitted');
}

export function expireDue() {
  const due = db.prepare(
    `SELECT id FROM orders WHERE status = 'awaiting_payment' AND expires_at <= ?`,
  ).all(now());
  for (const { id } of due) setStatus(id, 'expired');
  return due.length;
}

// --- CRM aggregates ---
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const startOfYesterday = () => startOfToday() - 86400000;
const PAID = `('paid','confirmed')`;

export function stats(merchantId = DEFAULT_ID) {
  // Every query is scoped to one merchant: "orders" below is that merchant's orders only.
  const q = (sql, ...a) => db.prepare(sql.replace(/FROM orders WHERE/g, 'FROM orders WHERE merchant_id = ? AND')).get(merchantId, ...a);
  const today = startOfToday(), yday = startOfYesterday();
  // Revenue = what actually arrived (the paise-discounted pay_amount), not the list price.
  const paidSum = (from, to) => (q(
    `SELECT COALESCE(SUM(COALESCE(pay_amount, amount)),0) v FROM orders WHERE status IN ${PAID} AND created_at >= ? AND created_at < ?`,
    from, to).v) || 0;
  const paidCount = (from, to) => q(
    `SELECT COUNT(*) v FROM orders WHERE status IN ${PAID} AND created_at >= ? AND created_at < ?`, from, to).v;
  return {
    revenue_total: q(`SELECT COALESCE(SUM(COALESCE(pay_amount, amount)),0) v FROM orders WHERE status IN ${PAID}`).v,
    revenue_today: paidSum(today, Date.now() + 1),
    revenue_yesterday: paidSum(yday, today),
    orders_total: q('SELECT COUNT(*) v FROM orders WHERE 1').v,
    orders_today: q('SELECT COUNT(*) v FROM orders WHERE created_at >= ?', today).v,
    orders_yesterday: q('SELECT COUNT(*) v FROM orders WHERE created_at >= ? AND created_at < ?', yday, today).v,
    paid_today: paidCount(today, Date.now() + 1),
    awaiting: q(`SELECT COUNT(*) v FROM orders WHERE status = 'awaiting_payment' AND expires_at > ?`, now()).v,
    cod_pending: q(`SELECT COUNT(*) v FROM orders WHERE status = 'cod_pending'`).v,
    upi_count: q(`SELECT COUNT(*) v FROM orders WHERE method = 'upi' AND status IN ${PAID}`).v,
    cod_count: q(`SELECT COUNT(*) v FROM orders WHERE method = 'cod'`).v,
  };
}

// Customer history: group paid/all orders by a stable key (phone > email > name).
export function customers() {
  const all = listOrders(1000);
  const map = new Map();
  for (const o of all) {
    const c = o.customer || {};
    const key = c.phone || c.email || c.name;
    if (!key) continue;
    if (!map.has(key)) map.set(key, { key, name: c.name || key, phone: c.phone || '', email: c.email || '',
      verified: false, orders: 0, paid_orders: 0, spent: 0, last_at: 0, methods: new Set() });
    const r = map.get(key);
    if (c.verified) r.verified = true;
    if (c.email && !r.email) r.email = c.email;
    r.orders++;
    if (o.status === 'paid' || o.status === 'confirmed') { r.paid_orders++; r.spent += o.amount; }
    r.methods.add(o.method);
    r.last_at = Math.max(r.last_at, o.created_at);
  }
  return [...map.values()]
    .map((r) => ({ ...r, methods: [...r.methods] }))
    .sort((a, b) => b.spent - a.spent);
}

// Fastrr-style conversion funnel + method split for a date range (ms epoch).
// Stages come from the events we already log, so the drop-off is real.
export function funnel({ from = 0, to = Date.now() + 1, merchantId = DEFAULT_ID } = {}) {
  const inRange = 'o.merchant_id = ? AND o.created_at >= ? AND o.created_at < ?';
  const reached = (type) => db.prepare(
    `SELECT COUNT(DISTINCT o.id) v FROM orders o JOIN events e ON e.order_id = o.id
     WHERE e.type = ? AND ${inRange}`).get(type, merchantId, from, to).v;

  const orders = db.prepare(`SELECT COUNT(*) v FROM orders o WHERE ${inRange}`).get(merchantId, from, to).v;
  const revenue = db.prepare(
    `SELECT COALESCE(SUM(amount),0) v FROM orders o WHERE status IN ('paid','confirmed') AND ${inRange}`
  ).get(merchantId, from, to).v;

  const methodRows = db.prepare(
    `SELECT method,
            COUNT(*) c,
            COALESCE(SUM(CASE WHEN status IN ('paid','confirmed') THEN amount ELSE 0 END),0) rev
     FROM orders o WHERE ${inRange} GROUP BY method`).all(merchantId, from, to);
  const method = { upi: { count: 0, revenue: 0 }, cod: { count: 0, revenue: 0 } };
  for (const r of methodRows) if (method[r.method]) method[r.method] = { count: r.c, revenue: r.rev };

  return {
    from, to, orders, revenue, method,
    stages: [
      { key: 'checkout',  label: 'Checkout started', count: orders },
      { key: 'qr',        label: 'QR shown',         count: reached('awaiting_payment') },
      { key: 'detected',  label: 'Payment detected', count: reached('paid') },
      { key: 'confirmed', label: 'Confirmed',        count: reached('confirmed') },
    ],
  };
}

// Abandoned carts: buyer gave verified details but never paid. First-party
// re-engagement list the merchant owns (vs a third party monetizing it).
export function abandoned() {
  const ids = db.prepare(
    `SELECT DISTINCT o.id FROM orders o JOIN events e ON e.order_id = o.id
     WHERE e.type = 'details_captured' AND o.merchant_id = ? AND o.status NOT IN ('paid','confirmed','utr_submitted')`).all(DEFAULT_ID);
  return ids.map(({ id }) => getOrder(id))
    .map((o) => ({ id: o.id, name: o.customer.name || '—', phone: o.customer.phone || '',
      email: o.customer.email || '', verified: !!o.customer.verified, consent: !!o.customer.consent,
      amount: o.amount, status: o.status, at: o.created_at }))
    .sort((a, b) => b.at - a.at);
}

// Has this UTR already been recorded against any order? (de-dup across sources)
export function utrSeen(utr, merchantId = DEFAULT_ID) {
  if (!utr) return false;
  return !!db.prepare('SELECT 1 FROM orders WHERE utr = ? AND merchant_id = ? LIMIT 1').get(String(utr), merchantId);
}

// --- bank credit ledger + automatic matching ---
// Every credit an observer reports is recorded, then matched to an order by:
//   1. UTR  — the buyer already submitted this UTR on the checkout page
//   2. exact unique amount (₹899.37) — the normal case, one order per amount
//   3. base price (₹899) — buyer dropped the paise; only if exactly one live order fits
// Unmatched credits stay in the ledger and trigger a merchant alert.

function linkCredit(creditId, orderId) {
  db.prepare(`UPDATE credits SET status = 'matched', order_id = ? WHERE id = ?`).run(orderId, creditId);
}

function liveCandidates(merchantId, where, ...args) {
  return db.prepare(
    `SELECT id, status, amount_locked, pay_amount FROM orders WHERE ${LIVE_SQL} AND merchant_id = ? AND ${where} ORDER BY created_at DESC`,
  ).all(now() - graceMs(), merchantId, ...args);
}

// The same payment often shows up twice: bank SMS (with UTR) and a UPI-app push (no UTR).
// It's the same payment when, within 3 minutes and at the same amount, it was already seen
// on the OTHER channel (sms vs push), or the exact same text was re-posted on one channel.
// Two real payments of the same amount on the same channel stay two payments.
const channel = (source) => (/push|notif|app/i.test(String(source || '')) ? 'push' : 'sms');
function twinCredit(merchantId, amount, { source, raw, needNoUtr }) {
  const rows = db.prepare(
    `SELECT * FROM credits WHERE merchant_id = ? AND ABS(amount - ?) < 0.001 AND at > ?
     ${needNoUtr ? 'AND utr IS NULL' : ''} ORDER BY at DESC LIMIT 5`,
  ).all(merchantId, amount, now() - TWIN_MS);
  return rows.find((c) => channel(c.source) !== channel(source) || (raw && c.raw === raw)) || null;
}

function payOrder(orderId, utr, creditId) {
  const order = markPaid(orderId, { utr });
  if (creditId) linkCredit(creditId, orderId);
  return order;
}

// Paid by hand (or approved) within the grace window, with no bank credit linked yet.
function recentHandPaid(merchantId, amount) {
  return db.prepare(
    `SELECT id FROM orders WHERE merchant_id = ? AND status IN ('paid','confirmed') AND paid_at > ?
     AND ABS(COALESCE(pay_amount, amount) - ?) < 0.001 AND NOT EXISTS (SELECT 1 FROM credits c WHERE c.order_id = orders.id)`,
  ).all(merchantId, now() - graceMs(), amount);
}
function recentlyCancelled(merchantId, amount) {
  return !!db.prepare(
    `SELECT 1 FROM orders WHERE merchant_id = ? AND status = 'cancelled' AND cancelled_at > ? AND ABS(pay_amount - ?) < 0.001 LIMIT 1`,
  ).get(merchantId, now() - graceMs(), amount);
}

export function recordCredit({ amount, utr = null, payer = null, source = null, raw = null, merchant_id = DEFAULT_ID }) {
  const m = merchant_id;
  amount = round2(Number(amount));
  utr = utr ? String(utr).replace(/\D/g, '') || null : null;

  // Same credit seen twice (SMS + push + email) -> ignore the repeats.
  if (utr && db.prepare('SELECT 1 FROM credits WHERE utr = ? AND merchant_id = ? LIMIT 1').get(utr, m)) {
    return { matched: false, reason: 'duplicate_credit' };
  }
  // A live order asking for exactly this amount means it's a new payment, never a repeat.
  const openAtAmount = liveCandidates(m, 'ABS(pay_amount - ?) < 0.001', amount).length > 0;
  if (!utr && !openAtAmount && twinCredit(m, amount, { source, raw })) return { matched: false, reason: 'duplicate_credit' };
  // The no-UTR push twin already sits in the ledger: never store this payment a second time.
  let twin = null;
  if (utr && !openAtAmount) {
    twin = twinCredit(m, amount, { source, raw, needNoUtr: true });
    if (twin && twin.status === 'matched') {
      db.prepare('UPDATE credits SET utr = ? WHERE id = ?').run(utr, twin.id);
      db.prepare('UPDATE orders SET utr = COALESCE(utr, ?) WHERE id = ?').run(utr, twin.order_id);
      return { matched: false, reason: 'duplicate_credit' };
    }
  }
  let creditId;
  if (twin) {
    // Unmatched push twin: give it the UTR and keep matching with that one credit,
    // so two unmatched rows can never be assigned to two bills.
    db.prepare('UPDATE credits SET utr = ?, payer = COALESCE(payer, ?) WHERE id = ?').run(utr, payer, twin.id);
    creditId = twin.id;
  } else {
    creditId = db.prepare(
      `INSERT INTO credits (amount, utr, payer, source, raw, at, merchant_id) VALUES (?,?,?,?,?,?,?)`,
    ).run(amount, utr, payer, source, raw, now(), m).lastInsertRowid;
  }

  // Order already confirmed with this UTR (e.g. merchant approved first) -> just link it.
  if (utr) {
    const done = db.prepare(`SELECT id FROM orders WHERE utr = ? AND merchant_id = ? AND status IN ('paid','confirmed')`).get(utr, m);
    if (done) { linkCredit(creditId, done.id); return { matched: false, reason: 'already_confirmed' }; }
  }

  // 1. UTR the buyer already typed in
  if (utr) {
    const byUtr = db.prepare(`SELECT id, amount, pay_amount FROM orders WHERE status = 'utr_submitted' AND utr = ? AND merchant_id = ?`).get(utr, m);
    if (byUtr && amount >= Number(byUtr.pay_amount ?? byUtr.amount) - 0.001) {
      return { matched: true, how: 'utr', order: payOrder(byUtr.id, utr, creditId) };
    }
  }
  // The push twin already went through the amount rules below and found nothing.
  if (twin) return { matched: false, reason: 'duplicate_credit', creditId };
  // 2. exact unique amount. A round amount (₹899.00) is also what a paise-discounted
  //    buyer sends if they drop the paise, so it only counts when no other live order
  //    shares that base price.
  const exact = liveCandidates(m, 'ABS(pay_amount - ?) < 0.001', amount);
  // An amount-locked order whose QR asked for a different amount can't have sent this one.
  const base = liveCandidates(m, 'ABS(amount - ?) < 0.001', amount)
    .filter((b) => !(b.amount_locked && Math.abs(Number(b.pay_amount) - amount) > 0.001));
  // An amount-locked order (UPI app opened with this exact amount) wins its exact match outright:
  // the other buyer was asked for a different amount and can't silently drop the paise.
  if (exact.length === 1 && (exact[0].amount_locked || !base.some((b) => b.id !== exact[0].id))) {
    return { matched: true, how: 'amount', order: payOrder(exact[0].id, utr, creditId) };
  }

  // A late payment for an order already marked paid by hand -> link it there (no second webhook).
  // A late payment for a cancelled order stays unmatched (merchant gets the alert).
  // Either way it must never confirm a different order by the base-price rule below.
  const handPaid = recentHandPaid(m, amount);
  if (handPaid.length === 1) { linkCredit(creditId, handPaid[0].id); return { matched: false, reason: 'already_confirmed' }; }
  if (handPaid.length > 1) return { matched: false, reason: 'ambiguous', creditId };
  if (recentlyCancelled(m, amount)) return { matched: false, reason: 'cancelled_order', creditId };

  // 3. paise dropped: base price, and only one live order at that price
  if (base.length === 1) return { matched: true, how: 'base_amount', order: payOrder(base[0].id, utr, creditId) };

  return { matched: false, reason: exact.length + base.length > 1 ? 'ambiguous' : 'no_matching_order', creditId };
}

// Buyer typed a UTR: if the bank credit with that UTR is already in the ledger, confirm now.
export function verifyUtrAgainstCredits(orderId) {
  const o = row(orderId);
  if (!o || o.status !== 'utr_submitted' || !o.utr) return null;
  const c = db.prepare(`SELECT id, amount FROM credits WHERE utr = ? AND merchant_id = ? AND status = 'unmatched'`).get(o.utr, o.merchant_id);
  if (!c || Number(c.amount) < Number(o.pay_amount ?? o.amount) - 0.001) return null;
  return payOrder(orderId, o.utr, c.id);
}

// Merchant manually attaches an unmatched credit to an order (exception handling).
export function assignCredit(creditId, orderId, { force = false } = {}) {
  const c = db.prepare('SELECT * FROM credits WHERE id = ?').get(creditId);
  if (!c) return { ok: false, reason: 'no_such_credit' };
  if (c.status === 'matched') return { ok: false, reason: 'already_matched' };
  const o = row(orderId);
  if (!o) return { ok: false, reason: 'no_such_order' };
  if (o.merchant_id !== c.merchant_id) return { ok: false, reason: 'credit belongs to another merchant' };
  if (['paid', 'confirmed'].includes(o.status)) return { ok: false, reason: `order is ${o.status}` };
  if (['created', 'cod_pending', 'cancelled'].includes(o.status)) {
    return { ok: false, reason: `order is ${o.status}` };
  }
  const small = creditTooSmall(c, o, force);
  if (small) return small;
  return { ok: true, order: payOrder(orderId, c.utr, c.id) };
}

// A credit smaller than the bill can't pay it, unless the merchant says so (force: true).
const inr = (n) => '₹' + Number(n).toFixed(2);
function creditTooSmall(c, o, force) {
  const pay = Number(o.pay_amount ?? o.amount);
  if (force || Number(c.amount) >= pay - 0.001) return null;
  return { ok: false, code: 'credit_too_small', credit_amount: Number(c.amount), pay_amount: pay,
    reason: `This credit (${inr(c.amount)}) is less than the payment (${inr(pay)})` };
}

export function listCredits(limit = 100, merchantId = DEFAULT_ID) {
  return db.prepare('SELECT * FROM credits WHERE merchant_id = ? ORDER BY at DESC LIMIT ?').all(merchantId, limit);
}

// For the alert sweeper: things a human should look at.
export function needsAttention() {
  const t = now();
  return {
    credits: db.prepare(
      `SELECT * FROM credits WHERE status = 'unmatched' AND alerted = 0 AND at < ?`,
    ).all(t - 2 * 60 * 1000),
    stuckUtr: db.prepare(
      `SELECT o.* FROM orders o WHERE o.status = 'utr_submitted'
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.order_id = o.id AND e.type = 'alerted')
       AND EXISTS (SELECT 1 FROM events e WHERE e.order_id = o.id AND e.type = 'utr_submitted' AND e.at < ?)`,
    ).all(t - 10 * 60 * 1000),
  };
}
export function markCreditAlerted(id) { db.prepare('UPDATE credits SET alerted = 1 WHERE id = ?').run(id); }
export function markOrderAlerted(id) { logEvent(id, 'alerted'); }

// Back-compat name used by older callers.
export const matchCredit = recordCredit;
