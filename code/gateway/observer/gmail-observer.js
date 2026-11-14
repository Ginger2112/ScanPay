// ScanPay — Gmail bank-alert observer (backup detection source).
//
// Connects to a Gmail inbox over IMAP, watches for unread Axis Bank credit
// alerts, parses amount + UTR, and posts them to the ScanPay payment core,
// which matches them to the pending order and auto-confirms.
//
// This runs as its OWN process against ANY Gmail account — independent of the
// store and of Claude. Point it at whichever inbox receives your Axis alerts.
//
// Setup (one time):
//   1. On the Gmail account that gets the alerts: enable 2-Step Verification,
//      then create an App Password (Google Account → Security → App passwords).
//   2. Copy observer/.env.example to observer/.env and fill it in.
//   3. Run:  node --env-file=observer/.env observer/gmail-observer.js
//
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { parseAxisCredit, isAxisSender } from '../lib/parse-axis.js';

const CFG = {
  user: process.env.GMAIL_USER,
  pass: process.env.GMAIL_APP_PASSWORD,
  host: process.env.IMAP_HOST || 'imap.gmail.com',
  port: Number(process.env.IMAP_PORT || 993),
  pgBase: process.env.PG_BASE || 'http://localhost:6100',
  token: process.env.OBSERVER_TOKEN || 'dev-observer-token',
  pollSec: Number(process.env.POLL_SEC || 15),
  // Comma-separated extra senders; Axis addresses are always accepted.
  senders: (process.env.ALERT_SENDERS || '').split(',').map((s) => s.trim()).filter(Boolean),
};

if (!CFG.user || !CFG.pass) {
  console.error('Missing GMAIL_USER / GMAIL_APP_PASSWORD. See observer/.env.example.');
  process.exit(1);
}

function senderAllowed(from) {
  return isAxisSender(from) || CFG.senders.some((s) => from.toLowerCase().includes(s.toLowerCase()));
}

async function postCredit({ amount, utr }) {
  try {
    const res = await fetch(`${CFG.pgBase}/api/observer/credit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-observer-token': CFG.token },
      body: JSON.stringify({ amount, utr, source: 'gmail' }),
    });
    const j = await res.json().catch(() => ({}));
    if (j.matched) console.log(`  ✓ matched ₹${amount} (UTR ${utr || 'n/a'}) -> ${j.order_id}`);
    else console.log(`  · no match for ₹${amount} (${j.reason || res.status})`);
  } catch (e) {
    console.log(`  ! post failed: ${e.message}`);
  }
}

async function scan(client) {
  const lock = await client.getMailboxLock('INBOX');
  try {
    // Unread messages from the last day — cheap and avoids re-reading history.
    const uids = await client.search({ seen: false, since: new Date(Date.now() - 864e5) });
    if (!uids || uids.length === 0) return;
    for await (const msg of client.fetch(uids, { source: true, envelope: true })) {
      const from = (msg.envelope?.from?.[0]?.address) || '';
      if (!senderAllowed(from)) continue;
      const parsed = await simpleParser(msg.source);
      const body = parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, ' ') : '');
      const credit = parseAxisCredit(body);
      if (credit) {
        console.log(`[alert] ${from} :: ₹${credit.amount} UTR=${credit.utr || 'n/a'}`);
        await postCredit(credit);
      }
      await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true }); // don't re-process
    }
  } finally {
    lock.release();
  }
}

async function main() {
  console.log(`ScanPay Gmail observer → ${CFG.user} (poll ${CFG.pollSec}s, core ${CFG.pgBase})`);
  const client = new ImapFlow({
    host: CFG.host, port: CFG.port, secure: true,
    auth: { user: CFG.user, pass: CFG.pass }, logger: false,
  });
  client.on('error', (e) => console.log('[imap] error', e.message));

  async function loop() {
    try {
      if (!client.usable) await client.connect();
      await scan(client);
    } catch (e) {
      console.log('[scan] error', e.message);
      try { await client.logout(); } catch {}
    }
    setTimeout(loop, CFG.pollSec * 1000);
  }
  await client.connect();
  console.log('[imap] connected. watching for Axis credit alerts…');
  loop();
}

main().catch((e) => { console.error('fatal', e.message); process.exit(1); });
