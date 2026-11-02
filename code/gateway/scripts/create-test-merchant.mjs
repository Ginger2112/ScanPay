// One-time setup: create (or fetch) a TEST-MODE merchant, e.g. ChargeOS before launch.
// Its UPI ID is fake, so nobody can pay it real money; payments are made with the checkout's test button.
// The API key + webhook secret are written to OUT_FILE (mode 600), never printed.
//   node --env-file=.env scripts/create-test-merchant.mjs <name> <external_ref> <webhook_url> <out_file> [--rotate]
import { writeFileSync } from 'node:fs';
import { createMerchant } from '../lib/merchants.js';
import { db } from '../lib/db.js';

const [name, ref, webhook, out] = process.argv.slice(2);
if (!name || !ref || !webhook || !out) {
  console.error('usage: create-test-merchant.mjs <name> <external_ref> <webhook_url> <out_file> [--rotate]');
  process.exit(2);
}
const vpa = `${ref.replace(/[^a-z0-9]/gi, '').toLowerCase()}.test@scanoyetest`;
const r = createMerchant({ name, vpa, webhook_url: webhook, partner: 'internal-test', external_ref: ref,
  rotate: process.argv.includes('--rotate'), test_mode: true });
// An existing merchant keeps test mode on (it's never switched off from here).
db.prepare('UPDATE merchants SET test_mode = 1 WHERE id = ?').run(r.merchant.id);
const lines = [`SCANOYE_MERCHANT_ID=${r.merchant.id}`, `SCANOYE_WEBHOOK_SECRET=${r.webhook_secret}`];
if (r.api_key) lines.push(`SCANOYE_KEY=${r.api_key}`);
writeFileSync(out, lines.join('\n') + '\n', { mode: 0o600 });
console.log(`${r.created ? 'created' : 'found'} ${r.merchant.id} "${r.merchant.name}" test_mode=on vpa=${vpa}${r.api_key ? ' (new key written)' : ' (key unchanged; use --rotate for a new one)'}`);
