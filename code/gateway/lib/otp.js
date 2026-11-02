// OTP delivery dispatcher. Pluggable channels: console (demo) and whatsapp.
// To add SMS later: implement sendSms(phone, text) and add a case here.
import { config } from '../config.js';
import * as wa from './whatsapp.js';

let started = false;

// Called once at server boot. Spins up WhatsApp when it's the OTP channel or
// when merchant payment alerts need it.
export async function initOtp() {
  const needWa = config.otp.channel === 'whatsapp' || !!config.merchant.alertPhone;
  if (needWa && !started) {
    started = true;
    try { await wa.start(); } catch (e) { console.log('[otp] whatsapp start failed:', e.message); }
  }
}

function message(code) {
  return `${config.otp.brand}: ${code} is your verification code. Valid for 5 minutes. Do not share it with anyone.`;
}

/**
 * Deliver an OTP. Returns { channel, delivered, demoCode? }.
 * In console mode the code is returned so the demo UI can display it.
 */
export async function deliverOtp(phone, code) {
  if (config.otp.channel === 'whatsapp') {
    if (!wa.isReady()) return { channel: 'whatsapp', delivered: false, error: 'whatsapp not connected' };
    try {
      await wa.sendText(phone, message(code));
      return { channel: 'whatsapp', delivered: true };
    } catch (e) {
      return { channel: 'whatsapp', delivered: false, error: e.message };
    }
  }
  // console / demo
  console.log(`[otp:console] ${phone} -> ${code}`);
  return { channel: 'console', delivered: true, demoCode: code };
}

export function waReady() { return wa.isReady(); }
