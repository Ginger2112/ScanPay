// Shared helpers for the Scan Oye merchant pages (start, merchant, pair, phone, admin).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rs = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (ms) => (ms ? new Date(ms).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const ago = (ms) => {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return when(ms);
};

async function api(path, { method = 'GET', body, key, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (key) h.authorization = 'Bearer ' + key;
  const r = await fetch(path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong (' + r.status + ')'); e.status = r.status; e.data = j; throw e; }
  return j; // a network failure throws from fetch() itself, with no .status
}

function copyBtn(btn, text) {
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch { btn.textContent = 'Select & copy'; }
    setTimeout(() => (btn.textContent = 'Copy'), 1500);
  });
}

const STATUS_LABEL = { awaiting_payment: 'Waiting', utr_submitted: 'UTR sent', paid: 'Paid', confirmed: 'Paid', expired: 'Expired',
  cancelled: 'Cancelled', created: 'Created', cod_pending: 'COD' };
const statusPill = (s) => `<span class="pill ${s === 'paid' || s === 'confirmed' ? 'paid' : ''}">${esc(STATUS_LABEL[s] || s)}</span>`;

// Installable app: offline shell + an "Add to Home Screen" hint on iPhone Safari.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function installHint() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let dismissed = false;
  try { dismissed = localStorage.getItem('scanoye_install_hint') === 'no'; } catch {}
  if (!ios || isInstalled() || dismissed) return '';
  return `<div class="card install" id="installHint"><img class="ic" src="/icons/apple-touch-icon.png" alt="">
    <div><b>Put Scan Oye on your home screen</b><div class="muted">In Safari tap <b>Share</b> (the square with the arrow), then <b>Add to Home Screen</b>. It opens full-screen like an app.</div>
    <div class="muted">The home-screen app asks for your API key once: copy it from your saved note first.</div>
    <button class="ghost sm" style="margin-top:8px" onclick="try{localStorage.setItem('scanoye_install_hint','no')}catch(e){};this.closest('#installHint').remove()">Got it</button></div></div>`;
}

function phoneLine(p) {
  if (!p || !p.paired) return '<span class="status"><span class="tick wait">…</span> Phone not connected yet</span>';
  return `<span class="status"><span class="tick ok">✓</span> Phone connected</span> <span class="muted">· ${esc(p.device || 'Android')} · last seen ${ago(p.last_seen)}</span>`
    + (p.online ? '' : '<div class="warn">The phone hasn\'t checked in for 30+ minutes. Open the Scan Oye app on it and keep it on Wi-Fi or data.</div>')
    + (p.sms_ok === false ? '<div class="warn">SMS permission is off on the phone: open the Scan Oye app and allow SMS</div>' : '');
}
