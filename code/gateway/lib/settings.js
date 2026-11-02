// Merchant settings: persisted in SQLite, applied onto the live config object
// so onboarding changes (VPA, name, webhook, timeout) take effect immediately.
import { db } from './db.js';
import { config } from '../config.js';

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);

export function getAll() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function set(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

// Push stored settings onto the runtime config object (mutated in place).
export function apply() {
  const s = getAll();
  if (s.merchant_name) config.merchant.name = s.merchant_name;
  if (s.merchant_vpa)  config.merchant.vpa = s.merchant_vpa;
  if (s.webhook_url !== undefined) config.webhook.url = s.webhook_url;
  if (s.webhook_secret) config.webhook.secret = s.webhook_secret;
  if (s.payment_timeout_sec) config.paymentTimeoutSec = Number(s.payment_timeout_sec);
}

// Current effective settings for the dashboard UI.
export function current() {
  return {
    merchant_name: config.merchant.name,
    merchant_vpa: config.merchant.vpa,
    webhook_url: config.webhook.url,
    webhook_secret: config.webhook.secret,
    payment_timeout_sec: config.paymentTimeoutSec,
  };
}

apply(); // on import, load any saved settings
