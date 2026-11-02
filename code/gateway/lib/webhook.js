// HMAC-SHA256 signed webhook to the merchant's own backend.
// The receiver must verify the signature over the RAW body before trusting it.
// Each merchant has its own URL + secret; 'default' still uses config.webhook.
// A failed delivery (network error or non-2xx) is re-sent in the background with the SAME
// body + signature at about 10s, 1 min, 5 min and 15 min. Receivers de-dup by order_id + event.
import { createHmac } from 'node:crypto';
import { getMerchant, DEFAULT_ID } from './merchants.js';
import { config } from '../config.js';

async function post(url, body, signature, followRedirects) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-scanoye-signature': signature, 'x-youpi-signature': signature },
      body,
      // Merchant-set URLs don't follow redirects, so a redirect can't bounce us into a private network.
      redirect: followRedirects ? 'follow' : 'manual',
      signal: AbortSignal.timeout(10000),
    });
    return { delivered: res.ok, status: res.status };
  } catch (e) {
    return { delivered: false, error: e.message };
  }
}

// Background retries: never awaited, so the caller is never held up.
function retryLater(job, attempt = 0) {
  const delays = config.webhook.retryDelaysMs;
  if (attempt >= delays.length) { console.log(`[webhook] ${job.label} gave up after ${delays.length} retries`); return; }
  const t = setTimeout(async () => {
    const r = await post(job.url, job.body, job.signature, job.follow);
    console.log(`[webhook] ${job.label} retry ${attempt + 1} -> ${r.status || 'FAILED ' + r.error}`);
    if (!r.delivered) retryLater(job, attempt + 1);
  }, delays[attempt]);
  t.unref?.();
}

export async function sendWebhook(event, order, extra = {}) {
  const m = getMerchant(order.merchant_id);
  const body = JSON.stringify({
    event,                       // e.g. 'order.paid'
    order_id: order.id,
    merchant_id: order.merchant_id || 'default',
    amount: order.amount,
    pay_amount: order.pay_amount ?? order.amount,
    currency: order.currency,
    utr: order.utr || null,
    status: order.status,
    ref: order.ref || null,
    ...extra,
    at: Date.now(),
  });
  const signature = createHmac('sha256', m.webhook_secret).update(body).digest('hex');

  if (!m.webhook_url) {
    console.log(`[webhook] (no URL set) ${event} ${order.id} sig=${signature.slice(0, 12)}…`);
    return { delivered: false, signature };
  }
  // First attempt is awaited, as before.
  const job = { url: m.webhook_url, body, signature, follow: m.id === DEFAULT_ID, label: `${event} ${order.id || extra.credit_id || ''}` };
  const r = await post(job.url, body, signature, job.follow);
  console.log(`[webhook] ${job.label} -> ${r.status || 'FAILED ' + r.error}`);
  if (!r.delivered) retryLater(job);
  return { ...r, signature };
}
