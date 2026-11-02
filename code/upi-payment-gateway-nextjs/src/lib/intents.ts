import type { PaymentIntent, UpiAccount } from "@prisma/client";

import { selectAccountForAmount } from "./accounts";
import { AmountSlotsExhaustedError, candidateChargeAmounts } from "./amount";
import { isUniqueViolation, prisma, violationInvolves } from "./db";
import { formatInr } from "./money";
import { buildUpiUri, isValidUtrFormat } from "./upi";
import { type PaymentStatus, isLive } from "./types";

/** How long a customer has to pay before the amount slot is recycled.
 *  Long enough for someone to switch apps and fumble a PIN, short enough that
 *  a busy store does not exhaust its 100 slots at one price point. */
export const DEFAULT_EXPIRY_SECONDS = 30 * 60;

export class DuplicateReferenceError extends Error {
  constructor(
    readonly reference: string,
    readonly existing: PaymentIntent,
  ) {
    super(`A payment intent already exists for reference "${reference}"`);
    this.name = "DuplicateReferenceError";
  }
}

export interface CreatePaymentIntentInput {
  merchantId: string;
  reference: string;
  baseAmountPaise: number;
  description?: string;
  customerEmail?: string;
  customerPhone?: string;
  expiresInSeconds?: number;
  idempotencyKey?: string;
}

/**
 * Creates a payment intent and reserves a unique charge amount for it.
 *
 * Allocation is optimistic: we ask the database for amounts already held by
 * live intents, pick a free one, and let the unique index arbitrate if a
 * concurrent request grabbed it first. Retrying on the violation is what makes
 * this correct under concurrency — the in-memory `taken` set is only there to
 * keep the number of retries small.
 */
export async function createPaymentIntent(
  input: CreatePaymentIntentInput,
): Promise<PaymentIntent> {
  const {
    merchantId,
    reference,
    baseAmountPaise,
    description,
    customerEmail,
    customerPhone,
    expiresInSeconds = DEFAULT_EXPIRY_SECONDS,
    idempotencyKey,
  } = input;

  // A retried request over a flaky connection must not create a second order.
  if (idempotencyKey) {
    const existing = await prisma.paymentIntent.findUnique({
      where: { idempotencyKey },
    });
    if (existing) return existing;
  }

  // Same order submitted twice: hand back what we already made rather than
  // burning a second amount slot on it.
  const byReference = await prisma.paymentIntent.findUnique({
    where: { merchantId_reference: { merchantId, reference } },
  });
  if (byReference) {
    if (isLive(byReference.status as PaymentStatus)) return byReference;
    throw new DuplicateReferenceError(reference, byReference);
  }

  await expireStaleIntents(merchantId);

  // Which of the merchant's UPI accounts collects this one. Chosen before the
  // amount, because charge amounts are unique per account — the pool we're
  // allocating from depends on which account we picked.
  const account = await selectAccountForAmount(merchantId, baseAmountPaise);

  const held = await prisma.paymentIntent.findMany({
    where: { upiAccountId: account.id, activeAmountKey: { not: null } },
    select: { activeAmountKey: true },
  });
  const taken = new Set(
    held.map((row) => row.activeAmountKey).filter((v): v is number => v !== null),
  );

  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const candidates = candidateChargeAmounts(baseAmountPaise).filter(
    (amount) => !taken.has(amount),
  );

  if (candidates.length === 0) throw new AmountSlotsExhaustedError(baseAmountPaise);

  for (const chargeAmountPaise of candidates) {
    try {
      return await prisma.paymentIntent.create({
        data: {
          merchantId,
          upiAccountId: account.id,
          reference,
          baseAmountPaise,
          chargeAmountPaise,
          activeAmountKey: chargeAmountPaise,
          status: "pending",
          description,
          customerEmail,
          customerPhone,
          expiresAt,
          idempotencyKey,
        },
      });
    } catch (err) {
      // Someone else took this amount between our read and our write. Any
      // other unique violation is a real conflict and must surface.
      if (isUniqueViolation(err) && violationInvolves(err, "activeAmountKey")) {
        continue;
      }
      throw err;
    }
  }

  throw new AmountSlotsExhaustedError(baseAmountPaise);
}

/**
 * Records a customer's claim that they paid, with the UTR from their app.
 *
 * This does NOT mark the order paid. A UTR is self-reported and we have no way
 * to check it against the banking network, so it only moves the intent to
 * awaiting_confirmation for the merchant to approve. Treating a claim as
 * proof of payment is the single easiest way to get merchants defrauded.
 */
export async function claimUtr(
  paymentIntentId: string,
  utr: string,
  actor = "customer",
): Promise<{ intent: PaymentIntent; accepted: boolean; reason?: string }> {
  const intent = await getPaymentIntent(paymentIntentId);
  if (!intent) throw new Error(`Unknown payment intent: ${paymentIntentId}`);

  const trimmed = utr.trim();
  const reject = async (reason: string) => {
    await prisma.verificationEvent.create({
      data: {
        paymentIntentId,
        kind: "utr_claim",
        utr: trimmed,
        actor,
        accepted: false,
        note: reason,
      },
    });
    return { intent, accepted: false, reason };
  };

  if (intent.status === "paid") {
    return { intent, accepted: true, reason: "already confirmed" };
  }
  if (!isLive(intent.status as PaymentStatus)) {
    return reject(`intent is ${intent.status}`);
  }
  if (!isValidUtrFormat(trimmed)) {
    return reject("UTR must be exactly 12 digits");
  }

  // The same UTR against a different order means someone is replaying a real
  // receipt. Worth surfacing to the merchant rather than silently accepting.
  const reused = await prisma.verificationEvent.findFirst({
    where: { utr: trimmed, paymentIntentId: { not: paymentIntentId } },
  });
  if (reused) {
    return reject("this UTR was already submitted against another order");
  }

  const [, updated] = await prisma.$transaction([
    prisma.verificationEvent.create({
      data: {
        paymentIntentId,
        kind: "utr_claim",
        utr: trimmed,
        actor,
        accepted: true,
      },
    }),
    prisma.paymentIntent.update({
      where: { id: paymentIntentId },
      data: { status: "awaiting_confirmation" },
    }),
  ]);

  return { intent: updated, accepted: true };
}

/**
 * Confirms that money actually arrived, releases the amount slot, and queues
 * the webhook that tells the merchant's store the order is paid.
 */
export async function markPaid(
  paymentIntentId: string,
  options: {
    verifiedVia: "manual_approval" | "email_match" | "utr_claim";
    utr?: string | null;
    actor: string;
  },
): Promise<PaymentIntent> {
  const intent = await prisma.paymentIntent.findUnique({
    where: { id: paymentIntentId },
    include: { merchant: true },
  });
  if (!intent) throw new Error(`Unknown payment intent: ${paymentIntentId}`);

  // Confirming twice must not fire two webhooks — the store would double-count
  // the order.
  if (intent.status === "paid") return intent;

  const paidAt = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.paymentIntent.update({
      where: { id: paymentIntentId },
      data: {
        status: "paid",
        paidAt,
        verifiedVia: options.verifiedVia,
        // Releases the charge amount back into the pool for reuse.
        activeAmountKey: null,
      },
    });

    await tx.verificationEvent.create({
      data: {
        paymentIntentId,
        kind: options.verifiedVia === "email_match" ? "email_match" : "manual_approval",
        utr: options.utr ?? null,
        actor: options.actor,
        accepted: true,
      },
    });

    if (intent.merchant.webhookUrl) {
      await tx.webhookDelivery.create({
        data: {
          paymentIntentId,
          url: intent.merchant.webhookUrl,
          event: "payment.paid",
          payload: JSON.stringify(
            buildWebhookPayload({ ...result, utr: options.utr ?? null }),
          ),
          nextAttemptAt: new Date(),
        },
      });
    }

    return result;
  });

  return updated;
}

/** Merchant says the money never arrived. Keeps the audit trail and returns
 *  the intent to pending so the customer can try again. */
export async function rejectClaim(
  paymentIntentId: string,
  actor: string,
  note: string,
): Promise<PaymentIntent> {
  const [, updated] = await prisma.$transaction([
    prisma.verificationEvent.create({
      data: {
        paymentIntentId,
        kind: "manual_rejection",
        actor,
        accepted: false,
        note,
      },
    }),
    prisma.paymentIntent.update({
      where: { id: paymentIntentId },
      data: { status: "pending" },
    }),
  ]);
  return updated;
}

/**
 * Releases amount slots held by intents nobody paid.
 *
 * Without this the 100 slots at a given price leak until a busy store cannot
 * create new orders. Runs opportunistically on create, and should also run on
 * a schedule once this is deployed.
 */
export async function expireStaleIntents(merchantId?: string): Promise<number> {
  const result = await prisma.paymentIntent.updateMany({
    where: {
      ...(merchantId ? { merchantId } : {}),
      status: { in: ["pending", "awaiting_confirmation"] },
      expiresAt: { lt: new Date() },
    },
    data: { status: "expired", activeAmountKey: null },
  });
  return result.count;
}

/** Reads an intent, expiring it first if its deadline has passed, so callers
 *  never see a stale "pending" that is really dead. */
export async function getPaymentIntent(
  id: string,
): Promise<PaymentIntent | null> {
  const intent = await prisma.paymentIntent.findUnique({ where: { id } });
  if (!intent) return null;

  if (isLive(intent.status as PaymentStatus) && intent.expiresAt < new Date()) {
    return prisma.paymentIntent.update({
      where: { id },
      data: { status: "expired", activeAmountKey: null },
    });
  }
  return intent;
}

/** The customer-facing view: everything needed to render a checkout.
 *  Addressed to the UPI account this intent was routed to, never to the
 *  merchant record — a merchant may collect into several. */
export function buildCheckout(intent: PaymentIntent, account: UpiAccount) {
  const upiUri = buildUpiUri({
    vpa: account.vpa,
    payeeName: account.payeeName,
    amountPaise: intent.chargeAmountPaise,
    note: intent.description ?? `Order ${intent.reference}`,
    reference: intent.reference,
  });

  return {
    id: intent.id,
    status: intent.status,
    reference: intent.reference,
    payeeName: account.payeeName,
    vpa: account.vpa,
    baseAmountPaise: intent.baseAmountPaise,
    chargeAmountPaise: intent.chargeAmountPaise,
    /** Paise added for reconciliation — shown to the customer so the amount
     *  never looks like an unexplained discrepancy against their order total. */
    deltaPaise: intent.chargeAmountPaise - intent.baseAmountPaise,
    displayAmount: formatInr(intent.chargeAmountPaise),
    upiUri,
    expiresAt: intent.expiresAt.toISOString(),
  };
}

export function buildWebhookPayload(
  intent: PaymentIntent & { utr?: string | null },
) {
  return {
    event: intent.status === "paid" ? "payment.paid" : "payment.expired",
    id: intent.id,
    reference: intent.reference,
    status: intent.status,
    baseAmountPaise: intent.baseAmountPaise,
    chargeAmountPaise: intent.chargeAmountPaise,
    verifiedVia: intent.verifiedVia,
    utr: intent.utr ?? null,
    paidAt: intent.paidAt?.toISOString() ?? null,
    createdAt: intent.createdAt.toISOString(),
  };
}

/** API response shape. Deliberately excludes internal columns like
 *  activeAmountKey and idempotencyKey. */
export function toPublicIntent(intent: PaymentIntent) {
  return {
    id: intent.id,
    reference: intent.reference,
    status: intent.status,
    baseAmountPaise: intent.baseAmountPaise,
    chargeAmountPaise: intent.chargeAmountPaise,
    description: intent.description,
    verifiedVia: intent.verifiedVia,
    expiresAt: intent.expiresAt.toISOString(),
    paidAt: intent.paidAt?.toISOString() ?? null,
    createdAt: intent.createdAt.toISOString(),
    checkoutUrl: `${process.env.APP_URL ?? ""}/pay/${intent.id}`,
  };
}
