// End-to-end matching scenarios for automatic confirmation.
// Run: node test/auto-confirm.test.mjs   (uses a throwaway DB, not data.db)
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const dbFile = join(tmpdir(), `scantopay-test-${Date.now()}.db`);
process.env.SCANTOPAY_DB = dbFile;
const o = await import('../lib/orders.js');
const { db } = await import('../lib/db.js');
const { parseAxisCredit } = await import('../lib/parse-axis.js');

let n = 0;
const ok = (msg) => { n++; console.log(`  ok  ${msg}`); };
const sms = (amt, utr, who = 'FRIEND') => `Credited INR ${amt} to A/c X7486 on 23-OCT-2026 Ref UPI/CR/${utr}/${who}`;
const open = (amount, name = 'Buyer') => {
  const x = o.createOrder({ amount, items: [{ name: 'Item' }], customer: { name } });
  return o.startPayment(x.id).order;
};
const fromSms = (text) => o.recordCredit({ ...parseAxisCredit(text), source: 'test', raw: text });

// 1. Two buyers, same price, paying at the same time -> first pays the exact price,
//    second gets a few paise OFF. Nobody is ever charged above the listed price.
const a = open(899, 'A'), b = open(899, 'B');
assert.strictEqual(a.pay_amount, 899);
assert.ok(b.pay_amount >= 898 && b.pay_amount < 899);
assert.strictEqual(a.status, 'awaiting_payment'); assert.strictEqual(b.status, 'awaiting_payment');
ok(`same price, two buyers -> ₹${a.pay_amount} / ₹${b.pay_amount}, never above price, nobody queued`);

// 2. Bank SMS for B's exact (discounted) amount -> B paid, A untouched
let r = fromSms(sms(b.pay_amount.toFixed(2), '600000000001'));
assert.ok(r.matched && r.how === 'amount' && r.order.id === b.id);
assert.strictEqual(o.getOrder(a.id).status, 'awaiting_payment');
ok('exact-amount SMS confirms the right order, other buyer unaffected');

// 3. Round ₹899.00 arrives, A is the only live ₹899 order left -> A confirmed
r = fromSms(sms('899.00', '600000000002'));
assert.ok(r.matched && r.how === 'amount' && r.order.id === a.id);
ok('round price, no other order at that price -> auto-confirms');

// 4. Round amount while another order at that price is open -> ambiguous, held
const c1 = open(499), c2 = open(499);
assert.strictEqual(c1.pay_amount, 499); assert.ok(c2.pay_amount < 499);
r = fromSms(sms('499.00', '600000000003'));
assert.ok(!r.matched && r.reason === 'ambiguous');
ok('round amount, two orders at that price -> held as unmatched (no wrong order confirmed)');

// 5. ...then the buyer types their UTR -> auto-confirms against the held credit, no approval
o.submitUtr(c2.id, '600000000003');
const paid5 = o.verifyUtrAgainstCredits(c2.id);
assert.ok(paid5 && paid5.status === 'paid');
assert.strictEqual(o.getOrder(c1.id).status, 'awaiting_payment');
ok('buyer enters UTR -> matched to the held bank credit instantly');

// 6. Buyer enters UTR first, bank SMS arrives later (paise dropped) -> confirms by UTR
const d = open(749);
o.submitUtr(d.id, '600000000004');
r = fromSms(sms('749.00', '600000000004'));
assert.ok(r.matched && r.how === 'utr' && r.order.id === d.id);
ok('UTR typed first, SMS arrives after -> confirms by UTR');

// 7. Same payment reported twice (SMS + push) -> second one ignored
r = fromSms(sms('749.00', '600000000004'));
assert.ok(!r.matched && r.reason === 'duplicate_credit');
ok('same credit seen twice (SMS + push) -> no double confirm');

// 8. Payment lands after the QR timer ran out -> still confirms within grace
const e = open(1299);
db.prepare('UPDATE orders SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, e.id);
o.expireDue();
assert.strictEqual(o.getOrder(e.id).status, 'expired');
r = fromSms(sms(e.pay_amount.toFixed(2), '600000000005'));
assert.ok(r.matched && r.order.id === e.id);
ok('paid after the timer expired -> still confirms (grace window)');

// 9. Underpaid with a UTR -> NOT confirmed
const f = open(1999);
o.submitUtr(f.id, '600000000006');
r = fromSms(sms('500.00', '600000000006'));
assert.ok(!r.matched);
assert.strictEqual(o.getOrder(f.id).status, 'utr_submitted');
ok('underpayment with a matching UTR -> not confirmed, held for review');

// 10. Merchant assigns the held ambiguous credit... already used; assign the underpaid one manually
const held = db.prepare(`SELECT id FROM credits WHERE utr = '600000000006'`).get();
const refused = o.assignCredit(held.id, f.id);
assert.ok(!refused.ok && refused.code === 'credit_too_small' && refused.credit_amount === 500 && refused.pay_amount === f.pay_amount, JSON.stringify(refused));
assert.strictEqual(o.getOrder(f.id).status, 'utr_submitted');
const as = o.assignCredit(held.id, f.id, { force: true });
assert.ok(as.ok && as.order.status === 'paid');
ok('a smaller held credit is refused unless the merchant forces it, then assigns in one click');

// 11. Alerts: unmatched credit older than 2 min and a UTR stuck 10+ min show up for the sweeper
fromSms(sms('333.33', '600000000007', 'STRANGER'));
db.prepare(`UPDATE credits SET at = ? WHERE utr = '600000000007'`).run(Date.now() - 3 * 60 * 1000);
const g = open(650);
o.submitUtr(g.id, '600000000008');
db.prepare(`UPDATE events SET at = ? WHERE order_id = ? AND type = 'utr_submitted'`).run(Date.now() - 11 * 60 * 1000, g.id);
const att = o.needsAttention();
assert.ok(att.credits.some((c) => c.utr === '600000000007'));
assert.ok(att.stuckUtr.some((x) => x.id === g.id));
o.markCreditAlerted(att.credits[0].id); o.markOrderAlerted(g.id);
const att2 = o.needsAttention();
assert.ok(!att2.credits.some((c) => c.utr === '600000000007') && !att2.stuckUtr.some((x) => x.id === g.id));
ok('stray payment + stuck UTR raise one alert each, never repeated');

// 12. Reloading the checkout of a confirmed order doesn't reopen it
const again = o.startPayment(a.id).order;
assert.strictEqual(again.status, 'paid');
ok('page reload on a paid order keeps it paid');

// 13. ₹1 item is charged exactly ₹1 (never ₹1.xx)
const one = open(1);
assert.strictEqual(one.pay_amount, 1);
ok('₹1 item -> QR asks for exactly ₹1.00');

// 14. Discounted buyer (₹299 -> ₹298.xx) pays their QR amount and types the UTR -> confirms
const h1 = open(299), h2 = open(299);
assert.ok(h2.pay_amount < 299);
o.submitUtr(h2.id, '600000000009');
r = fromSms(sms(h2.pay_amount.toFixed(2), '600000000009'));
assert.ok(r.matched && r.order.id === h2.id);
assert.strictEqual(o.getOrder(h1.id).status, 'awaiting_payment');
ok('discounted QR amount + UTR -> confirms (not treated as underpaid)');

// 15. Cancelled payment: its amount stays held, and a late SMS for it confirms nobody
const k1 = open(777);
assert.strictEqual(k1.pay_amount, 777);
o.cancelOrder(k1.id);
const k2 = open(777);
assert.ok(k2.pay_amount < 777, 'cancelled amount must not be reused at once');
r = fromSms(sms('777.00', '600000000010'));
assert.ok(!r.matched && r.reason === 'cancelled_order', JSON.stringify(r));
assert.strictEqual(o.getOrder(k2.id).status, 'awaiting_payment');
assert.strictEqual(db.prepare(`SELECT status FROM credits WHERE utr = '600000000010'`).get().status, 'unmatched');
ok('late SMS for a cancelled payment stays unmatched, never confirms the next order at that price');

// 16. Marked paid by hand (no bank credit yet): amount held; its late SMS links to it, no second payment
const m1 = open(555);
o.markPaidByHand(m1.id, ''); o.confirm(m1.id);
const m2 = open(555);
assert.ok(m2.pay_amount < 555, 'hand-paid amount must not be reused at once');
r = fromSms(sms('555.00', '600000000011'));
assert.ok(!r.matched && r.reason === 'already_confirmed', JSON.stringify(r));
assert.strictEqual(db.prepare(`SELECT order_id FROM credits WHERE utr = '600000000011'`).get().order_id, m1.id);
assert.strictEqual(o.getOrder(m2.id).status, 'awaiting_payment');
ok('late SMS for a hand-paid payment links to it, other order untouched');

// 17. Base-price rule skips an amount-locked order whose QR asked for a different amount
const p1 = open(610);
const lk = o.startPayment(o.createOrder({ amount: 610, amount_locked: true }).id).order;
assert.ok(p1.pay_amount === 610 && lk.pay_amount < 610);
r = fromSms(sms('610.00', '600000000012'));
assert.ok(r.matched && r.order.id === p1.id, JSON.stringify(r));
r = fromSms(sms('610.00', '600000000013'));
assert.ok(!r.matched, JSON.stringify(r));
assert.strictEqual(o.getOrder(lk.id).status, 'awaiting_payment');
ok('round amount never confirms an amount-locked order that was asked for paise');

// 18. A genuine second payment of the same amount is not swallowed as a twin
r = o.recordCredit({ amount: 432, source: 'android-push', raw: 'Received ₹432 from Riya' });
assert.ok(!r.matched && r.reason === 'no_matching_order');
const q1 = open(432);
assert.strictEqual(q1.pay_amount, 432);
r = fromSms(sms('432.00', '600000000014'));
assert.ok(r.matched && r.order.id === q1.id, JSON.stringify(r));
ok('same amount on the other channel within 3 min is a new payment when an order asks for it');

// 19. Mark paid by hand: a UTR already on another payment is refused; an unmatched credit with it is linked
const u1 = open(820);
assert.strictEqual(o.markPaidByHand(u1.id, '600000000012').ok, false);
fromSms(sms('819.00', '600000000015', 'WALKIN'));
const uSmall = o.markPaidByHand(u1.id, '600000000015');
assert.ok(!uSmall.ok && uSmall.code === 'credit_too_small', JSON.stringify(uSmall));
const u = o.markPaidByHand(u1.id, '600000000015', { force: true });
assert.ok(u.ok && u.order.status === 'paid');
assert.strictEqual(db.prepare(`SELECT order_id FROM credits WHERE utr = '600000000015'`).get().order_id, u1.id);
const u2 = open(821);
assert.strictEqual(o.markPaidByHand(u2.id, '600000000015').ok, false);
ok('one bank credit / UTR can never pay two bills by hand');

// 20. Revenue counts what actually arrived (pay_amount), not the list price
const st = o.stats();
const got = db.prepare(`SELECT SUM(COALESCE(pay_amount, amount)) v FROM orders WHERE status IN ('paid','confirmed') AND merchant_id = 'default'`).get().v;
const list = db.prepare(`SELECT SUM(amount) v FROM orders WHERE status IN ('paid','confirmed') AND merchant_id = 'default'`).get().v;
assert.ok(Math.abs(st.revenue_total - got) < 0.001 && st.revenue_total < list);
ok('revenue = money received, not list price');

// 21. Push (no UTR) arrives first with no order, its SMS twin (with UTR) seconds later:
//     one payment, one ledger row, so it can never be assigned to two bills.
const countAt = (amt) => db.prepare('SELECT COUNT(*) n FROM credits WHERE ABS(amount - ?) < 0.001').get(amt).n;
r = o.recordCredit({ amount: 271.5, source: 'android-push', raw: 'Received ₹271.50 from Kabir' });
assert.ok(!r.matched && r.reason === 'no_matching_order');
r = fromSms(sms('271.50', '600000000016', 'KABIR'));
assert.ok(!r.matched && r.reason === 'duplicate_credit', JSON.stringify(r));
assert.strictEqual(countAt(271.5), 1);
const tw = db.prepare('SELECT * FROM credits WHERE ABS(amount - 271.5) < 0.001').get();
assert.ok(tw.utr === '600000000016' && tw.status === 'unmatched');
r = fromSms(sms('271.50', '600000000016', 'KABIR'));
assert.ok(!r.matched && r.reason === 'duplicate_credit' && countAt(271.5) === 1);
ok('push then SMS twin with no order -> one unmatched credit that carries the UTR, replays ignored');

// 22. Same, but the buyer already typed that UTR on an order (paid a bit more): the twin confirms it, still one row
const w = open(700);
o.submitUtr(w.id, '600000000017');
r = o.recordCredit({ amount: 750, source: 'android-push', raw: 'Received ₹750 from Zara' });
assert.ok(!r.matched);
r = fromSms(sms('750.00', '600000000017', 'ZARA'));
assert.ok(r.matched && r.how === 'utr' && r.order.id === w.id, JSON.stringify(r));
assert.strictEqual(countAt(750), 1);
assert.strictEqual(db.prepare('SELECT order_id FROM credits WHERE ABS(amount - 750) < 0.001').get().order_id, w.id);
ok('push then SMS twin matching a typed UTR -> confirms with the one existing credit');

db.close();
try { rmSync(dbFile); rmSync(dbFile + '-wal'); rmSync(dbFile + '-shm'); } catch {}
console.log(`\n${n}/22 auto-confirm scenarios passed`);
