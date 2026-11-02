import { z } from "zod";

import { NoAccountAvailableError } from "@/lib/accounts";
import { AmountSlotsExhaustedError } from "@/lib/amount";
import { authenticateMerchant, jsonError, unauthorized } from "@/lib/auth";
import {
  DuplicateReferenceError,
  createPaymentIntent,
  toPublicIntent,
} from "@/lib/intents";
import { MAX_AMOUNT_PAISE, MIN_AMOUNT_PAISE } from "@/lib/money";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  /** The merchant's own order id. Unique per merchant. */
  reference: z.string().min(1).max(128),
  /** Integer paise. Callers must not send rupees — see src/lib/money.ts. */
  amountPaise: z
    .number()
    .int("amountPaise must be an integer number of paise, not rupees")
    .min(MIN_AMOUNT_PAISE)
    .max(
      MAX_AMOUNT_PAISE,
      `UPI caps a single person-to-merchant transaction at ${MAX_AMOUNT_PAISE} paise`,
    ),
  description: z.string().max(200).optional(),
  customerEmail: z.string().email().optional(),
  customerPhone: z.string().max(20).optional(),
  expiresInSeconds: z.number().int().min(60).max(24 * 3600).optional(),
});

export async function POST(request: Request) {
  const merchant = await authenticateMerchant(request);
  if (!merchant) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_json", "Request body must be valid JSON.");
  }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      422,
      "invalid_request",
      "One or more fields are invalid.",
      parsed.error.flatten().fieldErrors,
    );
  }

  const { amountPaise, ...rest } = parsed.data;

  try {
    const intent = await createPaymentIntent({
      merchantId: merchant.id,
      baseAmountPaise: amountPaise,
      // Lets a caller safely retry a create that timed out mid-flight.
      idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
      ...rest,
    });
    return Response.json(toPublicIntent(intent), { status: 201 });
  } catch (err) {
    if (err instanceof DuplicateReferenceError) {
      return jsonError(
        409,
        "duplicate_reference",
        `Reference "${err.reference}" already has a ${err.existing.status} payment.`,
        { paymentIntentId: err.existing.id, status: err.existing.status },
      );
    }
    if (err instanceof NoAccountAvailableError) {
      // none_configured is the merchant's setup problem (422); all_at_limit is
      // transient capacity and worth retrying (503).
      return err.reason === "none_configured"
        ? jsonError(422, "no_upi_account", err.message)
        : jsonError(503, "upi_accounts_at_limit", err.message, { retryable: true });
    }
    if (err instanceof AmountSlotsExhaustedError) {
      // Every paise offset at this price is held by a live intent. Transient:
      // slots free up as intents are paid or expire.
      return jsonError(
        503,
        "amount_slots_exhausted",
        err.message,
        { retryable: true },
      );
    }
    throw err;
  }
}
