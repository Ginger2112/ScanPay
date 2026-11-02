import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { WebhookEvent } from "./types";

// Outbound webhooks.
//
// This is the merchant's only trustworthy signal that an order is paid. A
// merchant who trusts an unsigned callback can be told "order 123 is paid" by
// anyone who guesses the URL, so the signature is not optional decoration —
// it is the whole security model of the integration.
//
// Scheme (deliberately the same shape Stripe uses, because merchants and their
// developers already know how to verify it):
//
//   X-Upi-Signature: t=1754531400,v1=<hex hmac-sha256>
//
// The signed message is `${timestamp}.${rawBody}`. Including the timestamp
// inside the MAC is what stops an attacker replaying yesterday's valid
// "payment.paid" for a new order.

const SIGNATURE_HEADER = "X-Upi-Signature";

/** Reject signatures older than this. Bounds the replay window while leaving
 *  room for clock skew on the merchant's server. */
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export interface WebhookPayload {
  event: WebhookEvent;
  /** Our payment intent id. */
  id: string;
  /** The merchant's own order reference. */
  reference: string;
  status: string;
  /** What the merchant asked us to collect, in paise. */
  baseAmountPaise: number;
  /** What the customer was actually asked to pay, in paise. */
  chargeAmountPaise: number;
  /** How it was confirmed: utr_claim | manual_approval | email_match */
  verifiedVia: string | null;
  utr: string | null;
  paidAt: string | null;
  createdAt: string;
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export function signPayload(
  rawBody: string,
  secret: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const signature = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

export function signatureHeaderName(): string {
  return SIGNATURE_HEADER;
}

/**
 * Verifies a signature header against a raw body.
 *
 * Exported because it is also the reference implementation we hand merchants
 * in the docs — keeping one copy means the docs cannot drift from what the
 * server actually produces.
 *
 * `rawBody` must be the exact bytes received. Re-serialising parsed JSON
 * reorders keys and silently breaks verification.
 */
export function verifySignature(
  rawBody: string,
  header: string,
  secret: string,
  options: { toleranceSeconds?: number; now?: number } = {},
): { valid: boolean; reason?: string } {
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const parts = new Map(
    header
      .split(",")
      .map((part) => part.trim().split("="))
      .filter((kv): kv is [string, string] => kv.length === 2),
  );

  const timestamp = Number(parts.get("t"));
  const provided = parts.get("v1");

  if (!Number.isFinite(timestamp) || !provided) {
    return { valid: false, reason: "malformed signature header" };
  }
  if (Math.abs(now - timestamp) > tolerance) {
    return { valid: false, reason: "timestamp outside tolerance" };
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "signature mismatch" };
  }
  return { valid: true };
}

/** Exponential backoff with a cap. Merchant endpoints go down; a paid order
 *  that never reaches the store is the worst failure this system has, so we
 *  retry for roughly a day before giving up. */
export const RETRY_SCHEDULE_SECONDS = [
  0, 30, 120, 600, 1800, 7200, 21600, 43200,
] as const;

export const MAX_WEBHOOK_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length;

export function nextAttemptAt(attempts: number, from = new Date()): Date | null {
  if (attempts >= MAX_WEBHOOK_ATTEMPTS) return null;
  return new Date(from.getTime() + RETRY_SCHEDULE_SECONDS[attempts] * 1000);
}
