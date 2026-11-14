// Merchants: every business that collects into its OWN UPI ID through ScanPay.
// 'default' is Arun's original single-merchant setup, read live from config/settings so
// ChargeOS, Jazz94/Careatic and the Shopify connector keep working exactly as before.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { config } from '../config.js';

export const DEFAULT_ID = 'default';
const now = () => Date.now();
const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
const rand = (n) => randomBytes(n).toString('base64url');
// Pairing / invite codes: no look-alike letters, easy to read out loud.
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const code = (len) => [...randomBytes(len)].map((b) => ALPHA[b % ALPHA.length]).join('');

export const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

function defaultMerchant() {
  return {
    id: DEFAULT_ID, name: config.merchant.name, vpa: config.merchant.vpa,
    webhook_url: config.webhook.url, webhook_secret: config.webhook.secret,
    partner: null, external_ref: null, active: 1, created_at: 0, test_mode: 0,
  };
}

export function getMerchant(id) {
  if (!id || id === DEFAULT_ID) return defaultMerchant();
  return db.prepare('SELECT * FROM merchants WHERE id = ?').get(id) || null;
}

// Two merchants can never share a VPA: the bank SMS would not say which one was paid.
function vpaTaken(vpa, exceptId) {
  const v = String(vpa).toLowerCase();
  if (exceptId !== DEFAULT_ID && config.merchant.vpa.toLowerCase() === v) return true;
  return !!db.prepare('SELECT 1 FROM merchants WHERE lower(vpa) = ? AND id != ? AND active = 1').get(v, exceptId || '');
}

// Webhooks must go to the merchant's public server, never into our own machine or network
// (localhost, 10.x, 192.168.x, cloud metadata 169.254.x ...). Demo mode allows them for local testing.
// Known limit: this checks the hostname as written, not the IP it resolves to. A public name whose DNS
// points at (or later re-points to) a private address (DNS rebinding) still gets through. Closing that
// needs resolving the name and pinning the checked IP for the actual request.
export function privateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true;
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4 written as IPv6
    if (mapped) return privateHost(mapped[1]);
    const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/); // same, as URL() writes it
    if (hex) { const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16); return privateHost(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`); }
    return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h); // fc00::/7, fe80::/10
  }
  return false;
}

function cleanUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  let x;
  try { x = new URL(s); if (!/^https?:$/.test(x.protocol)) throw 0; } catch { throw new Error('webhook_url must be an http(s) link'); }
  if (!config.demoMode && privateHost(x.hostname)) throw new Error('webhook_url must be a public address (not localhost or a private network)');
  return x.toString();
}

/**
 * Create a merchant. Returns the API key ONCE (only its hash is stored).
 * Partner callers pass partner + external_ref; calling again with the same pair
 * returns the existing merchant (no new key unless rotate is set).
 */
export function createMerchant({ name, vpa, webhook_url = '', partner = null, external_ref = null, rotate = false, test_mode = false }) {
  name = String(name || '').trim().slice(0, 80);
  vpa = String(vpa || '').trim();
  if (!name) throw new Error('business name required');
  if (!VPA_RE.test(vpa)) throw new Error("that UPI ID doesn't look right (like yourshop@okhdfcbank)");
  const hook = cleanUrl(webhook_url);

  if (partner && external_ref) {
    const ex = db.prepare('SELECT * FROM merchants WHERE partner = ? AND external_ref = ?').get(partner, String(external_ref));
    if (ex) {
      if (vpaTaken(vpa, ex.id)) throw new Error('this UPI ID is already connected to another ScanPay merchant');
      db.prepare('UPDATE merchants SET name = ?, vpa = ?, webhook_url = ?, active = 1 WHERE id = ?').run(name, vpa, hook || ex.webhook_url, ex.id);
      const out = { merchant: publicView(getMerchant(ex.id)), created: false, webhook_secret: ex.webhook_secret };
      // A deactivated merchant coming back always gets a fresh key: the old one stays dead.
      if (rotate || !ex.active) out.api_key = rotateKey(ex.id);
      if (!ex.active) out.reactivated = true;
      return out;
    }
  }
  if (vpaTaken(vpa)) throw new Error('this UPI ID is already connected to another ScanPay merchant');

  const id = 'mer_' + randomBytes(6).toString('hex');
  const key = 'sk_live_' + rand(24);
  const secret = 'whsec_' + rand(24);
  db.prepare(`INSERT INTO merchants (id, name, vpa, api_key_hash, api_key_hint, webhook_url, webhook_secret, partner, external_ref, created_at, test_mode)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name, vpa, hash(key), key.slice(-4), hook, secret, partner, external_ref ? String(external_ref) : null, now(), test_mode ? 1 : 0);
  return { merchant: publicView(getMerchant(id)), created: true, api_key: key, webhook_secret: secret };
}

export function rotateKey(id) {
  const key = 'sk_live_' + rand(24);
  db.prepare('UPDATE merchants SET api_key_hash = ?, api_key_hint = ? WHERE id = ?').run(hash(key), key.slice(-4), id);
  return key;
}

export function updateMerchant(id, { name, vpa, webhook_url }) {
  const m = getMerchant(id);
  if (!m || id === DEFAULT_ID) throw new Error('no such merchant');
  const next = { name: name !== undefined ? String(name).trim().slice(0, 80) : m.name, vpa: vpa !== undefined ? String(vpa).trim() : m.vpa,
    webhook_url: webhook_url !== undefined ? cleanUrl(webhook_url) : m.webhook_url };
  if (!next.name) throw new Error('business name required');
  if (!VPA_RE.test(next.vpa)) throw new Error("that UPI ID doesn't look right");
  if (vpaTaken(next.vpa, id)) throw new Error('this UPI ID is already connected to another ScanPay merchant');
  db.prepare('UPDATE merchants SET name = ?, vpa = ?, webhook_url = ? WHERE id = ?').run(next.name, next.vpa, next.webhook_url, id);
  return publicView(getMerchant(id));
}

export function byApiKey(key) {
  if (!key || !String(key).startsWith('sk_')) return null;
  return db.prepare('SELECT * FROM merchants WHERE api_key_hash = ? AND active = 1').get(hash(key)) || null;
}

// --- partner keys (platforms that onboard their own users, e.g. Tably) ---
// PARTNER_KEYS="tably:longsecret,doctro:othersecret"
export function partnerFromKey(key) {
  if (!key) return null;
  for (const pair of String(config.partnerKeys || '').split(',')) {
    const i = pair.indexOf(':');
    if (i < 1) continue;
    const name = pair.slice(0, i).trim(), secret = pair.slice(i + 1).trim();
    if (!secret) continue;
    const a = createHash('sha256').update(secret).digest(), b = createHash('sha256').update(String(key)).digest();
    if (timingSafeEqual(a, b)) return name;
  }
  return null;
}

// --- phone pairing ---
export function newPairing(merchantId, minutes = 10) {
  const c = code(10);
  db.prepare('INSERT INTO pairings (code, merchant_id, expires_at) VALUES (?,?,?)').run(c, merchantId, now() + minutes * 60000);
  return { code: c, expires_at: now() + minutes * 60000 };
}

export function pairingInfo(c) {
  const p = db.prepare('SELECT * FROM pairings WHERE code = ?').get(String(c || '').toUpperCase());
  if (!p) return null;
  const m = getMerchant(p.merchant_id);
  return { ...p, merchant_name: m ? m.name : '', valid: !p.used_at && p.expires_at > now() };
}

// The phone swaps the one-time code for its own long-lived token.
export function redeemPairing(c, device = '') {
  const p = db.prepare('SELECT * FROM pairings WHERE code = ?').get(String(c || '').toUpperCase());
  if (!p || p.used_at || p.expires_at <= now()) return null;
  const m = getMerchant(p.merchant_id);
  if (!m || !m.active) return null;
  db.prepare('UPDATE pairings SET used_at = ? WHERE code = ?').run(now(), p.code);
  const token = 'obs_' + rand(24);
  db.prepare('INSERT INTO observers (merchant_id, token_hash, device, paired_at, last_seen) VALUES (?,?,?,?,?)')
    .run(p.merchant_id, hash(token), String(device).slice(0, 80), now(), now());
  return { token, merchant: m };
}

// Which merchant does this phone belong to? The legacy shared token = the default merchant
// (switched off when no OBSERVER_TOKEN is set in live mode). Unlinked phones and phones of
// deactivated merchants get nothing.
export function merchantForObserver(token) {
  if (!token || typeof token !== 'string') return null;
  if (config.observer.token && token === config.observer.token) return getMerchant(DEFAULT_ID);
  const o = db.prepare('SELECT * FROM observers WHERE token_hash = ? AND revoked = 0').get(hash(token));
  if (!o) return null;
  const m = getMerchant(o.merchant_id);
  if (!m || !m.active) return null;
  db.prepare('UPDATE observers SET last_seen = ? WHERE id = ?').run(now(), o.id);
  return m;
}

// A token we know, but whose phone was unlinked (or whose merchant left): the app shows "unlinked".
export function phoneUnlinked(token) {
  if (!token || typeof token !== 'string') return false;
  const o = db.prepare('SELECT o.revoked, m.active FROM observers o LEFT JOIN merchants m ON m.id = o.merchant_id WHERE o.token_hash = ?').get(hash(token));
  return !!(o && (o.revoked || !o.active));
}

// Unlink every phone of a merchant at once (lost or sold phone). Returns how many.
export function revokePhones(merchantId) {
  return Number(db.prepare('UPDATE observers SET revoked = 1 WHERE merchant_id = ? AND revoked = 0').run(merchantId).changes);
}

// Merchant leaves: key stops working (byApiKey needs active = 1), phones unlinked, UPI ID freed.
// Open payments are cancelled by the caller (orders.js owns that).
export function deactivate(merchantId) {
  if (!merchantId || merchantId === DEFAULT_ID) throw new Error('no such merchant');
  db.prepare('UPDATE merchants SET active = 0 WHERE id = ?').run(merchantId);
  return revokePhones(merchantId);
}

// Heartbeat from the phone: optional permission health.
export function recordPhoneHealth(token, { sms_permission, notification_access } = {}) {
  const b = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : null);
  const sms = b(sms_permission), push = b(notification_access);
  if (sms === null && push === null) return;
  db.prepare('UPDATE observers SET sms_ok = COALESCE(?, sms_ok), push_ok = COALESCE(?, push_ok) WHERE token_hash = ?').run(sms, push, hash(token));
}

export function phoneStatus(merchantId) {
  const rows = db.prepare('SELECT device, paired_at, last_seen, sms_ok, push_ok FROM observers WHERE merchant_id = ? AND revoked = 0 ORDER BY last_seen DESC').all(merchantId);
  const last = rows[0] || null;
  const flag = (v) => (v === null || v === undefined ? null : !!v);
  return { paired: rows.length > 0, phones: rows.length, device: last && last.device, last_seen: last && last.last_seen,
    online: !!(last && last.last_seen && now() - last.last_seen < 30 * 60000),
    sms_ok: last ? flag(last.sms_ok) : null, push_ok: last ? flag(last.push_ok) : null };
}

// --- invites (self-signup is invite-only while we pilot) ---
export function createInvite(note = '') {
  const c = code(12);
  db.prepare('INSERT INTO invites (code, note, created_at) VALUES (?,?,?)').run(c, String(note).slice(0, 80), now());
  return c;
}
export function inviteOk(c) {
  const i = db.prepare('SELECT * FROM invites WHERE code = ?').get(String(c || '').toUpperCase());
  return !!(i && !i.used_at);
}
export function useInvite(c, merchantId) {
  db.prepare('UPDATE invites SET used_at = ?, merchant_id = ? WHERE code = ? AND used_at IS NULL').run(now(), merchantId, String(c).toUpperCase());
}
export function listInvites() {
  return db.prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT 50').all();
}

// Safe to show: never the key hash or the webhook secret.
export function publicView(m) {
  if (!m) return null;
  return { id: m.id, name: m.name, vpa: m.vpa, webhook_url: m.webhook_url, partner: m.partner, external_ref: m.external_ref,
    api_key_hint: m.api_key_hint || null, active: !!m.active, created_at: m.created_at, test_mode: !!m.test_mode };
}

export function listMerchants() {
  const rows = db.prepare('SELECT * FROM merchants ORDER BY created_at DESC').all();
  return [defaultMerchant(), ...rows].map((m) => {
    const c = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN status IN ('paid','confirmed') THEN amount END),0) paid
                          FROM orders WHERE merchant_id = ?`).get(m.id);
    return { ...publicView(m), orders: c.n, paid_total: c.paid, phone: phoneStatus(m.id) };
  });
}
