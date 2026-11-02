// Client IP trust + rate-limit memory. No server, no DB writes.
// Run: node test/security.test.mjs
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SCANTOPAY_DB = join(tmpdir(), `scanoye-sec-${Date.now()}.db`); // never data.db
const { config } = await import('../config.js');
const auth = await import('../lib/auth.js');

let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };
const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
const fake = { 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '198.51.100.1, 10.0.0.2' };

// 1. TRUST_PROXY off: headers are ignored, even from localhost
config.trustProxy = false;
assert.strictEqual(auth.clientIp(req('127.0.0.1', fake)), '127.0.0.1');
assert.strictEqual(auth.clientIp(req('203.0.113.77', fake)), '203.0.113.77');
ok('TRUST_PROXY off: cf-connecting-ip / x-forwarded-for ignored, socket address used');

// 2. TRUST_PROXY on: only a loopback peer (the local proxy) is believed
config.trustProxy = true;
for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.strictEqual(auth.clientIp(req(peer, fake)), '203.0.113.5', peer);
assert.strictEqual(auth.clientIp(req('::1', { 'x-forwarded-for': ' 198.51.100.1 , 10.0.0.2' })), '198.51.100.1');
assert.strictEqual(auth.clientIp(req('::1', {})), '::1');
for (const peer of ['203.0.113.77', '10.0.0.3', '::ffff:10.0.0.3', '127.0.0.2']) assert.strictEqual(auth.clientIp(req(peer, fake)), peer, peer);
ok('TRUST_PROXY on: headers read only from a loopback peer; a direct client cannot fake its IP');
config.trustProxy = false;

// 3. Rate-limit maps drop old IPs instead of growing forever
const realNow = Date.now;
let t = realNow();
Date.now = () => t;
try {
  for (let i = 0; i < 500; i++) { auth.rateOk('pair', '198.51.100.' + i); auth.loginFailed('203.0.113.' + i); auth.loginAllowed('203.0.113.' + i); }
  assert.ok(auth._rateSizes().hits >= 500 && auth._rateSizes().attempts >= 500);
  t += 16 * 60 * 1000; // past both windows (10 and 15 min)
  auth.rateOk('pair', '192.0.2.1');
  auth.loginAllowed('192.0.2.1');
  const s = auth._rateSizes();
  assert.ok(s.hits <= 1 && s.attempts === 0, JSON.stringify(s));
  ok('old rate-limit / login-attempt entries are pruned');
  // Pruning never forgets an IP that is still inside its window
  for (let i = 0; i < 5; i++) auth.loginFailed('192.0.2.9');
  t += 2 * 60 * 1000;
  assert.strictEqual(auth.loginAllowed('192.0.2.9'), false);
  ok('a locked-out IP stays locked out after a prune');
} finally { Date.now = realNow; }

console.log(`\n${n} security checks passed`);
