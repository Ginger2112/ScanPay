// Merchant admin login: password -> signed session cookie (stateless, survives
// restarts), plus a small per-IP rate limit on login attempts.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const COOKIE = 'stp_admin';
const secret = () => createHash('sha256').update('scantopay-admin:' + config.admin.password).digest();
const sign = (payload) => createHmac('sha256', secret()).update(payload).digest('hex');

function sameText(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

export function checkPassword(pw) {
  return !!config.admin.password && sameText(pw || '', config.admin.password);
}

export function sessionCookie(req) {
  const exp = Date.now() + config.admin.sessionDays * 864e5;
  const value = `${exp}.${sign(String(exp))}`;
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.admin.sessionDays * 86400}${secure}`;
}

export const clearCookie = `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

export function isAdmin(req) {
  if (!config.admin.password) return false;
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sig.length === 64 && sameText(sig, sign(exp));
}

// Drop IPs whose newest entry is older than the window, at most once a minute, so the maps never grow forever.
const lastPrune = new Map();
function prune(map, windowMs) {
  const now = Date.now();
  if (now - (lastPrune.get(map) || 0) < 60 * 1000) return;
  lastPrune.set(map, now);
  for (const [k, v] of map) if (!v.length || now - v[v.length - 1] >= windowMs) map.delete(k);
}

// 5 failed logins per IP per 15 minutes.
const LOGIN_WINDOW = 15 * 60 * 1000;
const attempts = new Map();
export function loginAllowed(ip) {
  const now = Date.now();
  prune(attempts, LOGIN_WINDOW);
  const a = (attempts.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW);
  if (a.length) attempts.set(ip, a); else attempts.delete(ip);
  return a.length < 5;
}
export function loginFailed(ip) { (attempts.get(ip) || attempts.set(ip, []).get(ip)).push(Date.now()); }

// Guessing pairing / invite codes: max 20 tries per IP per 10 minutes for each route.
const hits = new Map();
export function rateOk(bucket, ip, max = 20, windowMs = 10 * 60 * 1000) {
  const k = bucket + '|' + ip, now = Date.now();
  prune(hits, windowMs);
  const a = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (a.length >= max) { hits.set(k, a); return false; }
  a.push(now); hits.set(k, a);
  return true;
}
// For tests: how many IP entries the limiters hold right now.
export const _rateSizes = () => ({ attempts: attempts.size, hits: hits.size });

// The real client IP. Proxy headers (cf-connecting-ip, x-forwarded-for) are only believed when
// TRUST_PROXY=1 AND the connection itself comes from this machine (Caddy); otherwise anyone could
// send a fake header and dodge the rate limits and the login lockout.
const LOOPBACK = new Set(['::1', '127.0.0.1', '::ffff:127.0.0.1']);
export function clientIp(req) {
  const peer = req.socket.remoteAddress || '?';
  if (!config.trustProxy || !LOOPBACK.has(peer)) return peer;
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || peer;
}
