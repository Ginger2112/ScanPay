// SQLite via the Node built-in module (node:sqlite). No native deps.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.SCANTOPAY_DB || join(__dirname, '..', 'data.db'); // tests use a temp file

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id            TEXT PRIMARY KEY,
    amount        REAL NOT NULL,
    currency      TEXT NOT NULL DEFAULT 'INR',
    items_json    TEXT NOT NULL DEFAULT '[]',
    customer_json TEXT NOT NULL DEFAULT '{}',
    method        TEXT NOT NULL DEFAULT 'upi',   -- upi | cod
    status        TEXT NOT NULL DEFAULT 'created',
    utr           TEXT,
    vpa           TEXT,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER,
    paid_at       INTEGER,
    confirmed_at  INTEGER,
    ref           TEXT,   -- external order ref (Shopify order GID)
    ref_name      TEXT    -- human order name (e.g. #1001)
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   TEXT NOT NULL,
    type       TEXT NOT NULL,
    detail     TEXT,
    at         INTEGER NOT NULL
  );

  -- Every bank credit an observer reports (SMS / push / email), matched or not.
  CREATE TABLE IF NOT EXISTS credits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    amount     REAL NOT NULL,
    utr        TEXT,
    payer      TEXT,
    source     TEXT,
    raw        TEXT,
    order_id   TEXT,                       -- set once matched
    status     TEXT NOT NULL DEFAULT 'unmatched',  -- unmatched | matched
    alerted    INTEGER NOT NULL DEFAULT 0,
    at         INTEGER NOT NULL
  );
`);

// Migrate older DBs: Shopify ref columns + the unique per-order payable amount.
// amount_locked = the payer's UPI app opened with this exact amount filled in (API callers like Tably).
// cancelled_at = when the payment was closed another way (its amount stays held for the grace window).
for (const col of ['ref TEXT', 'ref_name TEXT', 'pay_amount REAL', 'amount_locked INTEGER NOT NULL DEFAULT 0', 'cancelled_at INTEGER']) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${col};`); } catch { /* column exists */ }
}

// --- multi-merchant ---
// Every order and bank credit belongs to one merchant. Arun's original setup is merchant
// 'default': its name, VPA and webhook still come from config/settings, so nothing changes for it.
db.exec(`
  CREATE TABLE IF NOT EXISTS merchants (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    vpa            TEXT NOT NULL,
    api_key_hash   TEXT NOT NULL UNIQUE,
    api_key_hint   TEXT NOT NULL,               -- last 4 chars, to recognise a key
    webhook_url    TEXT NOT NULL DEFAULT '',
    webhook_secret TEXT NOT NULL,
    partner        TEXT,                        -- who created it via API (e.g. 'tably'), null = self-signup
    external_ref   TEXT,                        -- the partner's own id for this merchant
    active         INTEGER NOT NULL DEFAULT 1,
    created_at     INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS merchants_partner_ref ON merchants (partner, external_ref);

  -- Paired Android phones. Each has its own token (stored hashed).
  CREATE TABLE IF NOT EXISTS observers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_id TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    device      TEXT,
    paired_at   INTEGER NOT NULL,
    last_seen   INTEGER,
    revoked     INTEGER NOT NULL DEFAULT 0
  );

  -- One-time pairing codes behind the QR (10 minutes, single use).
  CREATE TABLE IF NOT EXISTS pairings (
    code        TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER
  );

  -- Invite links for self-signup on /start.
  CREATE TABLE IF NOT EXISTS invites (
    code        TEXT PRIMARY KEY,
    note        TEXT,
    created_at  INTEGER NOT NULL,
    used_at     INTEGER,
    merchant_id TEXT
  );
`);
for (const t of ['orders', 'credits']) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN merchant_id TEXT NOT NULL DEFAULT 'default';`); } catch { /* exists */ }
}
db.exec(`CREATE INDEX IF NOT EXISTS orders_merchant ON orders (merchant_id, status);
         CREATE INDEX IF NOT EXISTS credits_merchant ON credits (merchant_id, status);`);
// Phone health from the heartbeat: is SMS permission / notification access on? (NULL = not reported)
for (const col of ['sms_ok INTEGER', 'push_ok INTEGER']) {
  try { db.exec(`ALTER TABLE observers ADD COLUMN ${col};`); } catch { /* exists */ }
}
// Test-mode merchant (e.g. ChargeOS before launch): fake UPI ID, payments are made with a test button,
// everything else (matching, webhook, sweep) runs exactly like a real payment. No real money can move.
try { db.exec('ALTER TABLE merchants ADD COLUMN test_mode INTEGER NOT NULL DEFAULT 0;'); } catch { /* exists */ }
// return_url: where the checkout sends the buyer after paying (set by the merchant's own API call).
try { db.exec('ALTER TABLE orders ADD COLUMN return_url TEXT;'); } catch { /* exists */ }
