// Build the UPI deep-link and render it as a scannable SVG QR.
import QRCode from 'qrcode';
import { config } from '../config.js';

// Standard UPI intent string. Any UPI app (GPay/PhonePe/Paytm) reads this.
// name = the payee name the buyer's UPI app shows (each merchant's own).
export function upiString({ amount, note, vpa = config.merchant.vpa, name = config.merchant.name }) {
  const p = new URLSearchParams({
    pa: vpa,
    pn: name,
    am: Number(amount).toFixed(2),
    cu: 'INR',
    tn: note || `Order ${Date.now()}`,
  });
  return `upi://pay?${p.toString()}`;
}

export async function upiQrSvg({ amount, note, vpa, name }) {
  const data = upiString({ amount, note, vpa, name });
  const svg = await QRCode.toString(data, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#ffffff' },
  });
  return { data, svg };
}
