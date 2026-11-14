// Merchant alerts for the rare payment that can't be matched automatically.
// Sent over WhatsApp when paired and MERCHANT_ALERT_PHONE is set; always logged.
import { config } from '../config.js';
import * as wa from './whatsapp.js';

export async function notifyMerchant(text) {
  console.log(`[alert] ${text}`);
  if (config.merchant.alertPhone && wa.isReady()) {
    try {
      await wa.sendText(config.merchant.alertPhone, `ScanPay: ${text}`);
      return { sent: 'whatsapp' };
    } catch (e) {
      console.log('[alert] whatsapp send failed:', e.message);
    }
  }
  return { sent: 'log' };
}
