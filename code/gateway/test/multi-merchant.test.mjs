// Multi-merchant end to end over HTTP: partner connect, invite signup, phone pairing,
// per-merchant SMS matching, signed webhooks, strict separation, and the default merchant
// still working unchanged. Starts its own server on a throwaway DB.
// Run: node test/multi-merchant.test.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6300 + Math.floor(Math.random() * 90);
const HOOK_PORT = PORT + 100;
const B = `http://localhost:${PORT}`;
const dbFile = join(tmpdir(), `scanoye-mm-${Date.now()}.db`);
const dbFile2 = dbFile.replace('.db', '-live.db'); // second server, DEMO_MODE=off
let live = null;
let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

// A fake merchant backend that records webhooks with their raw body.
const hooks = [];
const hookSrv = createServer((req, res) => {
  let raw = ''; req.on('data', (c) => (raw += c));
  req.on('end', () => {
    hooks.push({ path: req.url, raw, sig: req.headers['x-scanoye-signature'] });
    if (req.url === '/hang') return; // a merchant server that never answers
    // /flaky fails the first delivery, to prove the retry re-sends the same signed body
    if (req.url === '/flaky' && hooks.filter((h) => h.path === '/flaky').length === 1) { res.statusCode = 500; return res.end('down'); }
    res.end('ok');
  });
}).listen(HOOK_PORT);

const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), SCANTOPAY_DB: dbFile, DEMO_MODE: 'on', PARTNER_KEYS: 'tably:test-partner', ADMIN_PASSWORD: 'admin-pw',
    OBSERVER_TOKEN: 'legacy-token', MERCHANT_VPA: 'arun.default@okaxis', WEBHOOK_URL: '', OTP_CHANNEL: 'console',
    WEBHOOK_RETRY_DELAYS: '300,300,300,300', TRUST_PROXY: '' },
});
let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(B + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, json: j, headers: r.headers };
}
const key = (k) => ({ authorization: 'Bearer ' + k });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(B + '/store')).ok) break; } catch {} await wait(200); }

  // --- partner connect (Tably) ---
  let r = await call('/api/v1/merchants', { method: 'POST', body: { name: 'Kadak Corner', vpa: 'kadak@okhdfcbank', external_ref: 'rest_1' } });
  assert.strictEqual(r.status, 401); ok('partner API refuses calls without the partner key');
  r = await call('/api/v1/merchants', { method: 'POST', headers: { 'x-partner-key': 'nope' }, body: { name: 'X', vpa: 'x@ybl', external_ref: 'x' } });
  assert.strictEqual(r.status, 401); ok('wrong partner key refused');
  r = await call('/api/v1/merchants', { method: 'POST', headers: { 'x-partner-key': 'test-partner' },
    body: { name: 'Kadak Corner', vpa: 'kadak@okhdfcbank', external_ref: 'rest_1', webhook_url: `http://localhost:${HOOK_PORT}/kadak` } });
  assert.strictEqual(r.status, 201);
  assert.ok(r.json.api_key.startsWith('sk_live_') && r.json.webhook_secret.startsWith('whsec_'));
  assert.ok(r.json.pairing.qr_svg.includes('<svg') && /\/pair\/[A-Z0-9]{10}$/.test(r.json.pairing.url));
  const kadak = { id: r.json.merchant.id, key: r.json.api_key, secret: r.json.webhook_secret, pair: r.json.pairing.code };
  ok('partner creates a merchant in one call: API key + webhook secret + pairing QR');

  r = await call('/api/v1/merchants', { method: 'POST', headers: { 'x-partner-key': 'test-partner' }, body: { name: 'Kadak Corner Café', vpa: 'kadak@okhdfcbank', external_ref: 'rest_1' } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.merchant.id, kadak.id); assert.ok(!r.json.api_key);
  assert.strictEqual(r.json.merchant.webhook_url, `http://localhost:${HOOK_PORT}/kadak`);
  ok('connecting again is idempotent (same merchant, no new key, webhook kept)');

  r = await call('/api/v1/merchants', { method: 'POST', headers: { 'x-partner-key': 'test-partner' }, body: { name: 'Thief', vpa: 'kadak@okhdfcbank', external_ref: 'rest_2' } });
  assert.strictEqual(r.status, 400); ok('a UPI ID already used by another merchant is refused');
  r = await call('/api/v1/merchants', { method: 'POST', headers: { 'x-partner-key': 'test-partner' }, body: { name: 'Thief', vpa: 'ARUN.default@okaxis', external_ref: 'rest_3' } });
  assert.strictEqual(r.status, 400); ok("Arun's own default VPA can't be claimed by anyone");
  r = await call('/api/v1/merchants', { method: 'POST', headers: { 'x-partner-key': 'test-partner' }, body: { name: 'Bad', vpa: 'not-a-vpa', external_ref: 'rest_4' } });
  assert.strictEqual(r.status, 400); ok('bad UPI ID refused');

  // --- invite-only signup ---
  r = await call('/api/v1/signup', { method: 'POST', body: { invite: 'NOPE', name: 'Sharma Clinic', vpa: 'sharma@ybl' } });
  assert.strictEqual(r.status, 403); ok('signup without a valid invite is refused');
  r = await call('/api/invites', { method: 'POST', body: { note: 'Sharma' } });
  assert.strictEqual(r.status, 401); ok('only admin can create invites');
  const login = await fetch(B + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'admin-pw' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  r = await call('/api/invites', { method: 'POST', headers: { cookie }, body: { note: 'Sharma' } });
  const invite = r.json.code;
  assert.ok(/start\?invite=/.test(r.json.url));
  r = await call('/api/v1/signup', { method: 'POST', body: { invite, name: 'Sharma Clinic', vpa: 'sharma@ybl', webhook_url: `http://localhost:${HOOK_PORT}/sharma` } });
  assert.strictEqual(r.status, 201);
  const sharma = { id: r.json.merchant.id, key: r.json.api_key, secret: r.json.webhook_secret, pair: r.json.pairing.code };
  ok('invite link signup creates a merchant with key + pairing QR');
  r = await call('/api/v1/signup', { method: 'POST', body: { invite, name: 'Again', vpa: 'again@ybl' } });
  assert.strictEqual(r.status, 403); ok('an invite works only once');

  // --- pairing ---
  r = await call('/api/v1/pair/' + kadak.pair);
  assert.ok(r.json.valid && r.json.merchant_name === 'Kadak Corner Café'); ok('pairing page shows which business the phone joins');
  r = await call('/api/observer/pair', { method: 'POST', body: { code: kadak.pair, device: 'Redmi 12' } });
  assert.ok(r.json.token.startsWith('obs_'));
  kadak.phone = r.json.token;
  r = await call('/api/observer/pair', { method: 'POST', body: { code: kadak.pair, device: 'Other' } });
  assert.strictEqual(r.status, 400); ok('phone pairs with the one-time code; the code cannot be reused');
  r = await call('/api/v1/pair/' + kadak.pair); assert.strictEqual(r.json.valid, false);
  assert.deepStrictEqual(r.json, { valid: false }); ok('a used pairing code no longer reveals the business name');
  sharma.phone = (await call('/api/observer/pair', { method: 'POST', body: { code: sharma.pair, device: 'Samsung A15' } })).json.token;
  r = await call('/api/v1/me', { headers: key(kadak.key) });
  assert.ok(r.json.phone.paired && r.json.phone.device === 'Redmi 12' && r.json.phone.online); ok('merchant sees "phone connected"');
  r = await call('/api/observer/ping', { method: 'POST', headers: { 'x-observer-token': 'obs_fake' } });
  assert.strictEqual(r.status, 401); ok('unknown phone token refused');

  // --- payments + per-merchant matching ---
  r = await call('/api/v1/payments', { method: 'POST', body: { amount: 500 } });
  assert.strictEqual(r.status, 401); ok('payments need the merchant key');
  const kp = (await call('/api/v1/payments', { method: 'POST', headers: key(kadak.key), body: { amount: 500, ref: 'visit_1', ref_name: 'Bill B-1 Table 7', ttl_sec: 1800 } })).json;
  assert.strictEqual(kp.vpa, 'kadak@okhdfcbank'); assert.strictEqual(kp.pay_amount, 500);
  assert.ok(kp.upi_url.includes('pa=kadak%40okhdfcbank') && kp.upi_url.includes('pn=Kadak+Corner'));
  assert.ok(kp.expires_at - Date.now() > 25 * 60 * 1000);
  ok('payment uses the merchant\'s own VPA + name, custom QR window honoured');
  const sp = (await call('/api/v1/payments', { method: 'POST', headers: key(sharma.key), body: { amount: 500, ref: 'bill_9' } })).json;
  assert.strictEqual(sp.pay_amount, 500); ok('same ₹500 at a different merchant keeps the exact price (amounts unique per merchant only)');

  // Sharma's phone reports ₹500 -> only Sharma's payment is paid
  r = await call('/api/observer/sms', { method: 'POST', headers: { 'x-observer-token': sharma.phone },
    body: { sender: 'VM-HDFCBK', source: 'android-sms', text: 'Rs.500.00 credited to HDFC Bank A/c XX1234 on 31-10-26 from VPA dev@ybl (UPI 430599990001)' } });
  assert.ok(r.json.matched && r.json.order_id === sp.id);
  assert.strictEqual((await call('/api/v1/payments/' + kp.id, { headers: key(kadak.key) })).json.status, 'awaiting_payment');
  ok("one merchant's bank SMS never pays another merchant's order");

  await wait(300);
  const sh = hooks.find((h) => h.path === '/sharma');
  assert.ok(sh && sh.sig === createHmac('sha256', sharma.secret).update(sh.raw).digest('hex'));
  const shb = JSON.parse(sh.raw);
  assert.strictEqual(shb.event, 'order.paid'); assert.strictEqual(shb.ref, 'bill_9'); assert.strictEqual(shb.utr, '430599990001');
  ok('signed webhook goes to that merchant\'s own URL with its own secret, carrying ref + UTR');

  // Kadak's phone: PhonePe Business push (no UTR) then the bank SMS (with UTR) for the same payment
  r = await call('/api/observer/sms', { method: 'POST', headers: { 'x-observer-token': kadak.phone },
    body: { sender: 'com.phonepe.app.business', source: 'android-push', text: '₹500 received Received ₹500 from Meera Nair' } });
  assert.ok(r.json.matched && r.json.order_id === kp.id); ok('UPI business-app push confirms by amount');
  r = await call('/api/observer/sms', { method: 'POST', headers: { 'x-observer-token': kadak.phone },
    body: { sender: 'VK-ICICIB', source: 'android-sms', text: 'Dear Customer, Acct XX123 is credited with Rs 500.00 on 31-Oct-26 from MEERA NAIR. UPI:430599990002-ICICI Bank.' } });
  assert.strictEqual(r.json.reason, 'duplicate_credit');
  assert.strictEqual((await call('/api/v1/payments/' + kp.id, { headers: key(kadak.key) })).json.utr, '430599990002');
  ok('the bank SMS for the same payment is a duplicate, and fills in the UTR');
  await wait(300);
  const kh = hooks.filter((h) => h.path === '/kadak');
  assert.strictEqual(kh.length, 1); ok('exactly one webhook per payment');

  // Isolation of reads
  assert.strictEqual((await call('/api/v1/payments/' + sp.id, { headers: key(kadak.key) })).status, 404);
  const kl = (await call('/api/v1/payments', { headers: key(kadak.key) })).json;
  assert.ok(kl.every((p) => p.id !== sp.id));
  const kc = (await call('/api/v1/credits', { headers: key(kadak.key) })).json;
  assert.ok(kc.every((c) => c.merchant_id === kadak.id));
  ok('a merchant key cannot read another merchant\'s payments or credits');

  // Cancel
  const kp2 = (await call('/api/v1/payments', { method: 'POST', headers: key(kadak.key), body: { amount: 250, ref: 'visit_2' } })).json;
  r = await call(`/api/v1/payments/${kp2.id}/cancel`, { method: 'POST', headers: key(kadak.key) });
  assert.strictEqual(r.json.status, 'cancelled');
  r = await call(`/api/v1/payments/${kp.id}/cancel`, { method: 'POST', headers: key(kadak.key) });
  assert.strictEqual(r.status, 409); ok('cancel works for open payments, refused for paid ones');

  // Two open payments with the same price: a round SMS is ambiguous, unless the first was amount-locked
  const l1 = (await call('/api/v1/payments', { method: 'POST', headers: key(kadak.key), body: { amount: 365, ref: 'lock_1', amount_locked: true } })).json;
  const l2 = (await call('/api/v1/payments', { method: 'POST', headers: key(kadak.key), body: { amount: 365, ref: 'lock_2', amount_locked: true } })).json;
  assert.ok(l1.pay_amount === 365 && l2.pay_amount < 365);
  r = await call('/api/observer/sms', { method: 'POST', headers: { 'x-observer-token': kadak.phone },
    body: { sender: 'VM-HDFCBK', text: 'Rs.365.00 credited to HDFC Bank A/c XX1234 on 31-10-26 from VPA a@ybl (UPI 430599990020)' } });
  assert.ok(r.json.matched && r.json.order_id === l1.id, JSON.stringify(r.json));
  r = await call('/api/observer/sms', { method: 'POST', headers: { 'x-observer-token': kadak.phone },
    body: { sender: 'VM-HDFCBK', text: `Rs.${l2.pay_amount.toFixed(2)} credited to HDFC Bank A/c XX1234 on 31-10-26 from VPA b@ybl (UPI 430599990021)` } });
  assert.ok(r.json.matched && r.json.order_id === l2.id);
  ok('same price at two tables: amount-locked payments each match their own SMS');

  // Manual confirm (iPhone-only merchant) + attaching a stray credit
  const kp3 = (await call('/api/v1/payments', { method: 'POST', headers: key(kadak.key), body: { amount: 120, ref: 'visit_3' } })).json;
  r = await call(`/api/v1/payments/${kp3.id}/mark-paid`, { method: 'POST', headers: key(sharma.key), body: {} });
  assert.strictEqual(r.status, 404);
  r = await call(`/api/v1/payments/${kp3.id}/mark-paid`, { method: 'POST', headers: key(kadak.key), body: { utr: '12' } });
  assert.strictEqual(r.status, 400);
  r = await call(`/api/v1/payments/${kp3.id}/mark-paid`, { method: 'POST', headers: key(kadak.key), body: { utr: '430599990010' } });
  assert.strictEqual(r.json.status, 'confirmed'); assert.strictEqual(r.json.utr, '430599990010');
  ok('merchant can mark a payment paid by hand (own payments only, UTR checked)');
  const kp4 = (await call('/api/v1/payments', { method: 'POST', headers: key(kadak.key), body: { amount: 333, ref: 'visit_4' } })).json;
  await call('/api/observer/sms', { method: 'POST', headers: { 'x-observer-token': kadak.phone },
    body: { sender: 'VM-HDFCBK', text: 'Rs.330.00 credited to HDFC Bank A/c XX1234 on 31-10-26 from VPA x@ybl (UPI 430599990011)' } });
  const stray = (await call('/api/v1/credits', { headers: key(kadak.key) })).json.find((c) => c.utr === '430599990011');
  assert.ok(stray && stray.status === 'unmatched');
  r = await call(`/api/v1/credits/${stray.id}/assign`, { method: 'POST', headers: key(sharma.key), body: { payment_id: kp4.id } });
  assert.strictEqual(r.status, 404);
  r = await call(`/api/v1/credits/${stray.id}/assign`, { method: 'POST', headers: key(kadak.key), body: { payment_id: kp4.id } });
  assert.ok(r.status === 400 && r.json.code === 'credit_too_small' && r.json.credit_amount === 330 && r.json.pay_amount === 333, JSON.stringify(r.json));
  assert.strictEqual((await call('/api/v1/payments/' + kp4.id, { headers: key(kadak.key) })).json.status, 'awaiting_payment');
  ok('attaching a credit smaller than the payment is refused with both amounts');
  r = await call(`/api/v1/credits/${stray.id}/assign`, { method: 'POST', headers: key(kadak.key), body: { payment_id: kp4.id, force: true } });
  assert.strictEqual(r.json.status, 'confirmed');
  ok('a stray bank credit can be attached to a payment (own merchant only, force for a smaller one)');

  // Non-UPI / debit SMS is ignored
  r = await call('/api/observer/sms', { method: 'POST', headers: { 'x-observer-token': kadak.phone },
    body: { sender: 'VM-HDFCBK', text: 'Sent Rs.250.00 From HDFC Bank A/C x1234 To RAHUL On 31/10/26 Ref 430599990003' } });
  assert.strictEqual(r.json.parsed, false); ok('debit SMS ignored');
  r = await call('/api/observer/sms', { method: 'POST', headers: { 'x-observer-token': kadak.phone },
    body: { sender: '+91 98765 43210', text: 'Rs.140.00 credited to HDFC Bank A/c XX1234 on 31-10-26 from VPA x@ybl (UPI 430599990040)' } });
  assert.strictEqual(r.json.parsed, false); ok('a "bank" SMS typed from a personal phone number is ignored');
  assert.ok(!log.includes('from VPA dev@ybl') && !log.includes('Sent Rs.250.00') && log.includes('VM-HDFCBK: ignored'));
  ok('server log keeps sender + outcome only, never the SMS text');
  assert.ok(kp.checkout_url.endsWith('/checkout?id=' + kp.id)); ok('checkout_url uses the ?id= the checkout page reads');

  // Mark paid by hand: a UTR can pay only one bill; a stray bank credit with that UTR is linked
  const kp5 = (await call('/api/v1/payments', { method: 'POST', headers: key(kadak.key), body: { amount: 140, ref: 'visit_5' } })).json;
  r = await call(`/api/v1/payments/${kp5.id}/mark-paid`, { method: 'POST', headers: key(kadak.key), body: { utr: '430599990010' } });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.json.error, 'This UTR is already used on another payment');
  await call('/api/observer/sms', { method: 'POST', headers: { 'x-observer-token': kadak.phone },
    body: { sender: 'VM-HDFCBK', text: 'Rs.138.00 credited to HDFC Bank A/c XX1234 on 31-10-26 from VPA y@ybl (UPI 430599990030)' } });
  r = await call(`/api/v1/payments/${kp5.id}/mark-paid`, { method: 'POST', headers: key(kadak.key), body: { utr: '430599990030' } });
  assert.ok(r.status === 400 && r.json.code === 'credit_too_small', JSON.stringify(r.json));
  r = await call(`/api/v1/payments/${kp5.id}/mark-paid`, { method: 'POST', headers: key(kadak.key), body: { utr: '430599990030', force: true } });
  assert.strictEqual(r.json.status, 'confirmed');
  const linked = (await call('/api/v1/credits', { headers: key(kadak.key) })).json.find((c) => c.utr === '430599990030');
  assert.ok(linked.status === 'matched' && linked.order_id === kp5.id);
  ok('mark paid refuses a UTR used elsewhere and links the stray credit with that UTR');

  // Phone health from the heartbeat
  r = await call('/api/observer/ping', { method: 'POST', headers: { 'x-observer-token': kadak.phone }, body: { sms_permission: false, notification_access: true } });
  assert.strictEqual(r.status, 200);
  r = await call('/api/v1/me', { headers: key(kadak.key) });
  assert.ok(r.json.phone.sms_ok === false && r.json.phone.push_ok === true);
  r = await call('/api/v1/me', { headers: key(sharma.key) });
  assert.ok(r.json.phone.sms_ok === null && r.json.phone.push_ok === null);
  ok('phone reports SMS / notification permission; unknown stays null');

  // Webhook retry: first delivery gets a 500, the retry re-sends the SAME body + signature
  r = await call('/api/v1/merchants', { method: 'POST', headers: { 'x-partner-key': 'test-partner' },
    body: { name: 'Flaky Foods', vpa: 'flaky@ybl', external_ref: 'rest_7', webhook_url: `http://localhost:${HOOK_PORT}/flaky` } });
  const flaky = { key: r.json.api_key };
  const fp = (await call('/api/v1/payments', { method: 'POST', headers: key(flaky.key), body: { amount: 99 } })).json;
  r = await call(`/api/v1/payments/${fp.id}/mark-paid`, { method: 'POST', headers: key(flaky.key), body: {} });
  assert.strictEqual(r.json.status, 'confirmed');
  await wait(1200);
  const fh = hooks.filter((h) => h.path === '/flaky');
  assert.ok(fh.length === 2 && fh[0].raw === fh[1].raw && fh[0].sig === fh[1].sig, `got ${fh.length} deliveries`);
  ok('a failed webhook is retried in the background with the same signed body, and stops once delivered');

  // Unlink phones, then deactivate + partner re-connect
  r = await call('/api/v1/merchants', { method: 'POST', headers: { 'x-partner-key': 'test-partner' }, body: { name: 'Chai Stop', vpa: 'chai@ybl', external_ref: 'rest_5' } });
  const chai = { id: r.json.merchant.id, key: r.json.api_key };
  chai.phone = (await call('/api/observer/pair', { method: 'POST', body: { code: r.json.pairing.code, device: 'Moto G' } })).json.token;
  r = await call('/api/v1/me/phones/revoke', { method: 'POST', headers: key(chai.key) });
  assert.deepStrictEqual(r.json, { revoked: 1 });
  r = await call('/api/observer/ping', { method: 'POST', headers: { 'x-observer-token': chai.phone } });
  assert.ok(r.status === 401 && r.json.error === 'phone unlinked');
  r = await call('/api/observer/sms', { method: 'POST', headers: { 'x-observer-token': chai.phone }, body: { sender: 'VM-HDFCBK', text: 'x' } });
  assert.ok(r.status === 401 && r.json.error === 'phone unlinked');
  assert.strictEqual((await call('/api/v1/me', { headers: key(chai.key) })).json.phone.paired, false);
  ok('"Unlink all phones" revokes every phone token at once');

  const pc = (await call('/api/v1/me/pairing', { method: 'POST', headers: key(chai.key) })).json;
  chai.phone2 = (await call('/api/observer/pair', { method: 'POST', body: { code: pc.code, device: 'Moto G' } })).json.token;
  const cp = (await call('/api/v1/payments', { method: 'POST', headers: key(chai.key), body: { amount: 60 } })).json;
  r = await call('/api/v1/me/deactivate', { method: 'POST', headers: key(chai.key) });
  assert.deepStrictEqual(r.json, { ok: true });
  assert.strictEqual((await call('/api/v1/me', { headers: key(chai.key) })).status, 401);
  r = await call('/api/observer/ping', { method: 'POST', headers: { 'x-observer-token': chai.phone2 } });
  assert.ok(r.status === 401 && r.json.error === 'phone unlinked');
  assert.strictEqual((await call('/api/orders/' + cp.id)).json.status, 'cancelled');
  ok('deactivate kills the key, unlinks phones and cancels open payments');
  r = await call('/api/v1/merchants', { method: 'POST', headers: { 'x-partner-key': 'test-partner' }, body: { name: 'New Chai', vpa: 'chai@ybl', external_ref: 'rest_6' } });
  assert.strictEqual(r.status, 201); ok("a deactivated merchant's UPI ID is free again");
  r = await call('/api/v1/merchants', { method: 'POST', headers: { 'x-partner-key': 'test-partner' }, body: { name: 'Chai Stop', vpa: 'chai.stop@ybl', external_ref: 'rest_5' } });
  assert.ok(r.status === 200 && r.json.merchant.id === chai.id && r.json.merchant.active && r.json.api_key && r.json.api_key !== chai.key);
  assert.strictEqual((await call('/api/v1/me', { headers: key(chai.key) })).status, 401);
  assert.strictEqual((await call('/api/v1/me', { headers: key(r.json.api_key) })).status, 200);
  ok('partner re-connect reactivates it with a fresh key (old key stays dead)');

  // Admin key recovery
  r = await call(`/api/merchants/${sharma.id}/rotate-key`, { method: 'POST' });
  assert.strictEqual(r.status, 401);
  r = await call('/api/merchants/default/rotate-key', { method: 'POST', headers: { cookie } });
  assert.strictEqual(r.status, 400);
  r = await call(`/api/merchants/${sharma.id}/rotate-key`, { method: 'POST', headers: { cookie } });
  assert.ok(r.json.api_key.startsWith('sk_live_'));
  assert.strictEqual((await call('/api/v1/me', { headers: key(sharma.key) })).status, 401);
  sharma.key = r.json.api_key;
  assert.strictEqual((await call('/api/v1/me', { headers: key(sharma.key) })).status, 200);
  ok('admin can issue a merchant a new key (not for default, admin only)');

  // --- default merchant unchanged ---
  const legacy = (await call('/api/orders', { method: 'POST', body: { amount: 899, items: [{ name: 'Puffer' }] } })).json;
  assert.strictEqual(legacy.merchant_id, 'default');
  const st = (await call(`/api/orders/${legacy.id}/start`, { method: 'POST' })).json.order;
  assert.strictEqual(st.vpa, 'arun.default@okaxis');
  r = await call('/api/observer/sms', { method: 'POST', headers: { 'x-observer-token': 'legacy-token' },
    body: { sender: 'JK-AUBANK', text: `Credited INR ${st.pay_amount.toFixed(2)} to A/c X7486 on 31-OCT-2026 Ref UPI/CR/430599990004/ARUN` } });
  assert.ok(r.json.matched && r.json.order_id === legacy.id);
  ok("Arun's original store flow (public order API + shared phone token + AU SMS) works unchanged");
  const ms = (await call('/api/merchants', { headers: { cookie } })).json;
  // default + Kadak, Sharma, Flaky Foods, Chai Stop, New Chai
  assert.ok(ms.length === 6 && ms[0].id === 'default', `got ${ms.length}`); ok('admin sees every merchant');
  const stats = (await call('/api/stats', { headers: { cookie } })).json;
  assert.strictEqual(stats.orders_total, 1); ok("Arun's own dashboard counts only his own orders");
  r = await call('/api/orders', { method: 'POST', body: { amount: 50, merchant_id: kadak.id, amount_locked: true } });
  assert.ok(r.json.merchant_id === 'default' && r.json.amount_locked === 0);
  ok('public order API always uses the default merchant (merchant_id / amount_locked ignored)');

  // Settings + key rotation
  r = await call('/api/v1/me', { method: 'POST', headers: key(kadak.key), body: { vpa: 'sharma@ybl' } });
  assert.strictEqual(r.status, 400); ok('merchant cannot switch to another merchant\'s UPI ID');
  const rot = (await call('/api/v1/me/rotate-key', { method: 'POST', headers: key(kadak.key) })).json.api_key;
  assert.strictEqual((await call('/api/v1/me', { headers: key(kadak.key) })).status, 401);
  assert.strictEqual((await call('/api/v1/me', { headers: key(rot) })).status, 200);
  ok('rotating the key kills the old one at once');

  // The phone gives up after 5s: /api/observer/sms must answer at once even when the merchant's webhook hangs
  r = await call('/api/v1/merchants', { method: 'POST', headers: { 'x-partner-key': 'test-partner' },
    body: { name: 'Slow Stall', vpa: 'slow@ybl', external_ref: 'rest_8', webhook_url: `http://localhost:${HOOK_PORT}/hang` } });
  const slow = { key: r.json.api_key };
  slow.phone = (await call('/api/observer/pair', { method: 'POST', body: { code: r.json.pairing.code, device: 'Nokia' } })).json.token;
  const slp = (await call('/api/v1/payments', { method: 'POST', headers: key(slow.key), body: { amount: 77 } })).json;
  const slowSms = { sender: 'VM-HDFCBK', source: 'android-sms', text: 'Rs.77.00 credited to HDFC Bank A/c XX1234 on 31-10-26 from VPA s@ybl (UPI 430599990050)' };
  let t0 = Date.now();
  r = await call('/api/observer/sms', { method: 'POST', headers: { 'x-observer-token': slow.phone }, body: slowSms });
  const took = Date.now() - t0;
  assert.ok(r.json.matched && r.json.order_id === slp.id, JSON.stringify(r.json));
  assert.ok(took < 2000, `took ${took} ms`);
  assert.strictEqual((await call('/api/v1/payments/' + slp.id, { headers: key(slow.key) })).json.status, 'confirmed');
  ok(`/api/observer/sms answers in ${took} ms while the merchant webhook hangs (payment already confirmed)`);
  r = await call('/api/observer/sms', { method: 'POST', headers: { 'x-observer-token': slow.phone }, body: slowSms });
  assert.ok(!r.json.matched && r.json.reason === 'duplicate_credit');
  const slp2 = (await call('/api/v1/payments', { method: 'POST', headers: key(slow.key), body: { amount: 66 } })).json;
  const slowPush = { sender: 'com.phonepe.app.business', source: 'android-push', text: '₹66 received Received ₹66 from Om' };
  t0 = Date.now();
  r = await call('/api/observer/credit', { method: 'POST', headers: { 'x-observer-token': slow.phone }, body: { amount: 66, source: 'android-push', raw: slowPush.text } });
  assert.ok(r.json.matched && r.json.order_id === slp2.id && Date.now() - t0 < 2000, JSON.stringify(r.json));
  r = await call('/api/observer/sms', { method: 'POST', headers: { 'x-observer-token': slow.phone }, body: slowPush });
  assert.ok(!r.json.matched && r.json.reason === 'duplicate_credit', JSON.stringify(r.json));
  assert.strictEqual((await call('/api/v1/credits', { headers: key(slow.key) })).json.length, 2);
  ok('/api/observer/credit answers fast too; a replayed SMS (with or without UTR) is harmless');

  // XSS: anyone can create an order, so the dashboard must escape what buyers type
  const evil = '<img src=x onerror=alert(1)>';
  r = await call('/api/orders', { method: 'POST', body: { amount: 10, items: [{ name: evil }], customer: { name: evil, phone: evil, email: evil }, ref: evil, ref_name: evil } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await call('/api/orders/' + r.json.id)).json.customer.name, evil); // stored as typed: escaping is the page's job
  for (const page of ['/admin', '/checkout']) {
    const html = await (await fetch(B + page)).text();
    const script = html.slice(html.lastIndexOf('<script>'));
    const escLine = script.match(/^const esc ?=.*$/m);
    assert.ok(escLine, page + ' defines esc()');
    const esc = new Function(escLine[0] + '; return esc;')();
    assert.strictEqual(esc(evil), '&lt;img src=x onerror=alert(1)&gt;');
    assert.strictEqual(esc(`"'&`), '&quot;&#39;&amp;');
    // Every ${...} that outputs a server value (o.name, c.payer, i.name ...) must go through esc(), Number(), inr() or an escaping helper.
    // A field used only as a condition (c.utr?, o.status==='paid' &&) is fine: its output sits in a nested ${esc(...)}.
    const SAFE = /^(esc|Number|inr|badge|cust|vbadge|new Date)\(/;
    const FIELD = /\b(?:o|c|i|st|order)\.(id|name|phone|email|payer|utr|source|order_id|ref|ref_name|label|method|items|status)\b/;
    const COND = /^!?[\w.]+\s*(\?|===|!==|&&)/;
    const bad = [];
    for (const m of script.matchAll(/\$\{([^{}]*?)\}/g)) {
      const expr = m[1].trim();
      if (SAFE.test(expr) || !FIELD.test(expr) || COND.test(expr)) continue;
      bad.push(expr);
    }
    assert.deepStrictEqual(bad, [], page + ' unescaped: ' + bad.join(' | '));
  }
  ok('dashboard + checkout escape every buyer-supplied value (name, phone, email, items, ids, UTR, payer, source)');

  // Pages
  for (const p of ['/start', '/start?invite=X', '/merchant', '/pair/ABCDEFGHJK', '/phone', '/admin/merchants', '/scanoye.css', '/scanoye.js', '/store', '/admin',
    '/manifest.webmanifest', '/sw.js', '/icons/apple-touch-icon.png', '/icons/icon-512.png', '/scantopay-observer.apk']) {
    assert.strictEqual((await fetch(B + p)).status, 200, p);
  }
  ok('all merchant pages load');

  // Guessing pairing codes: 20 tries per IP per 10 minutes, then 429
  let last = 0;
  for (let i = 0; i < 22; i++) last = (await call('/api/v1/pair/ZZZZZZZZZZ')).status;
  assert.strictEqual(last, 429); ok('pairing-code lookups are rate limited per IP');
  r = await call('/api/v1/pair/ZZZZZZZZZZ', { headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.10' } });
  assert.strictEqual(r.status, 429); ok('a faked cf-connecting-ip / x-forwarded-for does not get round the limit (TRUST_PROXY off)');
  for (let i = 0; i < 5; i++) await call('/api/admin/login', { method: 'POST', body: { password: 'wrong' + i } });
  r = await call('/api/admin/login', { method: 'POST', body: { password: 'admin-pw' } });
  assert.strictEqual(r.status, 429);
  r = await call('/api/admin/login', { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.7' }, body: { password: 'admin-pw' } });
  assert.strictEqual(r.status, 429); ok('admin login lockout cannot be dodged with a faked IP header');

  // --- live mode (DEMO_MODE=off) with nothing set: no default partner key, no shared phone token, no private webhooks ---
  const P2 = PORT + 200, B2 = `http://localhost:${P2}`;
  live = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(P2), SCANTOPAY_DB: dbFile2, DEMO_MODE: 'off', ADMIN_PASSWORD: 'admin-pw', PARTNER_KEYS: '', OBSERVER_TOKEN: '', OTP_CHANNEL: 'console', TRUST_PROXY: '1' },
  });
  live.stdout.on('data', (d) => (log += d)); live.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(B2 + '/store')).ok) break; } catch {} await wait(200); }
  const call2 = (p, o = {}) => fetch(B2 + p, { method: o.method || 'GET', headers: { 'content-type': 'application/json', ...(o.headers || {}) },
    body: o.body ? JSON.stringify(o.body) : undefined }).then(async (x) => ({ status: x.status, json: await x.json().catch(() => ({})) }));
  r = await call2('/api/v1/merchants', { method: 'POST', headers: { 'x-partner-key': 'dev-partner-key' }, body: { name: 'X', vpa: 'x@ybl', external_ref: 'x' } });
  assert.strictEqual(r.status, 401); ok('live mode: no built-in partner key');
  for (const t of ['dev-observer-token', '']) {
    r = await call2('/api/observer/ping', { method: 'POST', headers: { 'x-observer-token': t } });
    assert.strictEqual(r.status, 401, `token "${t}"`);
  }
  ok('live mode without OBSERVER_TOKEN: the shared phone token is switched off');
  const lc = (await fetch(B2 + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'admin-pw' }) }))
    .headers.get('set-cookie').split(';')[0];
  const inv2 = (await call2('/api/invites', { method: 'POST', headers: { cookie: lc }, body: { note: 'x' } })).json.code;
  for (const u of ['http://localhost:9000/x', 'http://127.0.0.1/x', 'http://10.0.0.5/x', 'http://172.20.1.1/x', 'http://192.168.1.10/x',
    'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'http://[fd00::1]/x', 'http://[fe80::1]/x', 'http://0.0.0.0/x', 'http://shop.localhost/x', 'http://2130706433/x']) {
    r = await call2('/api/v1/signup', { method: 'POST', body: { invite: inv2, name: 'Hook Test', vpa: 'hooktest@ybl', webhook_url: u } });
    assert.strictEqual(r.status, 400, u);
  }
  r = await call2('/api/v1/signup', { method: 'POST', body: { invite: inv2, name: 'Hook Test', vpa: 'hooktest@ybl', webhook_url: 'https://shop.example.com/hook' } });
  assert.strictEqual(r.status, 201);
  ok('live mode: webhook links to localhost / private networks are refused, public ones accepted');
  // TRUST_PROXY=1 behind a local proxy (Caddy): the forwarded client IP is the one rate-limited
  for (let i = 0; i < 21; i++) last = (await call2('/api/v1/pair/ZZZZZZZZZZ', { headers: { 'cf-connecting-ip': '203.0.113.1' } })).status;
  assert.strictEqual(last, 429);
  assert.strictEqual((await call2('/api/v1/pair/ZZZZZZZZZZ', { headers: { 'x-forwarded-for': '203.0.113.2, 10.0.0.1' } })).status, 404);
  assert.strictEqual((await call2('/api/v1/pair/ZZZZZZZZZZ', { headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 429);
  ok('TRUST_PROXY=1 on a localhost connection: limits follow cf-connecting-ip / first x-forwarded-for');

  console.log(`\n${n} multi-merchant checks passed`);
} catch (e) {
  console.error('\nFAILED:', e.message, '\n--- server log ---\n' + log.slice(-2500));
  process.exitCode = 1;
} finally {
  srv.kill(); if (live) live.kill(); hookSrv.closeAllConnections?.(); hookSrv.close();
  await wait(200);
  for (const d of [dbFile, dbFile2]) for (const f of [d, d + '-wal', d + '-shm']) { try { rmSync(f); } catch {} }
}
