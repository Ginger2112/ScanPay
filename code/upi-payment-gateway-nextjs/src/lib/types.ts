// Status vocabularies. These live in TS rather than the database because
// SQLite has no enum support (see prisma/schema.prisma). Anything crossing the
// API boundary is validated against these with zod.

export const PAYMENT_STATUSES = [
  "pending", // created, customer has not told us anything yet
  "awaiting_confirmation", // customer claimed a UTR, merchant has not approved
  "paid", // confirmed — money is in the merchant's bank
  "expired", // amount slot released, customer must start over
  "cancelled", // merchant or store cancelled the order
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Statuses that still hold a charge-amount slot. */
export const LIVE_STATUSES: readonly PaymentStatus[] = [
  "pending",
  "awaiting_confirmation",
];

export function isLive(status: PaymentStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

export const VERIFICATION_KINDS = [
  "utr_claim", // customer submitted a 12-digit reference
  "manual_approval", // merchant confirmed they saw the money
  "manual_rejection", // merchant said the money never arrived
  "email_match", // server matched a bank credit-alert email (phase 2)
] as const;

export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export const WEBHOOK_EVENTS = ["payment.paid", "payment.expired"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
