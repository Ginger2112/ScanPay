// WhatsApp OTP sender via Baileys (unofficial WhatsApp Web).
// Pair once: start with OTP_CHANNEL=whatsapp and scan the QR printed in the
// terminal with a WhatsApp account (use a DEDICATED number, not personal).
// Auth is persisted to data/wa-auth so you only pair once.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = join(__dirname, '..', 'data', 'wa-auth');

let sock = null;
let ready = false;

export function isReady() { return ready; }

export async function start() {
  // Dynamic import keeps Baileys out of the hot path when channel != whatsapp.
  const baileys = await import('@whiskeysockets/baileys');
  const makeWASocket = baileys.default || baileys.makeWASocket;
  const { useMultiFileAuthState, DisconnectReason } = baileys;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log('\n[whatsapp] Scan this QR with WhatsApp (Linked devices) to pair:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') { ready = true; console.log('[whatsapp] connected — OTP delivery live.'); }
    if (connection === 'close') {
      ready = false;
      const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      console.log(`[whatsapp] disconnected${loggedOut ? ' (logged out — delete data/wa-auth and re-pair)' : ', reconnecting…'}`);
      if (!loggedOut) start().catch((e) => console.log('[whatsapp] reconnect failed', e.message));
    }
  });
  return sock;
}

// Normalize an Indian phone number to a WhatsApp JID.
export function toJid(phone) {
  let d = String(phone).replace(/\D/g, '');
  if (d.length === 10) d = '91' + d;
  else if (d.length === 11 && d.startsWith('0')) d = '91' + d.slice(1);
  return d + '@s.whatsapp.net';
}

export async function sendText(phone, text) {
  if (!sock || !ready) throw new Error('whatsapp not connected');
  await sock.sendMessage(toJid(phone), { text });
}
