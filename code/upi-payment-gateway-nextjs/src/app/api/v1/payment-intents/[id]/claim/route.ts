import { z } from "zod";

import { jsonError } from "@/lib/auth";
import { claimUtr, getPaymentIntent } from "@/lib/intents";

export const dynamic = "force-dynamic";

const ClaimSchema = z.object({
  utr: z.string().trim().min(1).max(32),
});

/**
 * Customer submits the 12-digit UTR from their UPI app.
 *
 * Unauthenticated by necessity — the payer is an anonymous shopper, not a
 * merchant with an API key. Knowing the intent id is the only credential, so
 * this endpoint deliberately does almost nothing: it records a claim and moves
 * the intent to awaiting_confirmation. It cannot mark anything paid, which is
 * what keeps an unauthenticated endpoint from being a way to get free goods.
 *
 * TODO before production: rate limit by IP and by intent id. A determined
 * caller can currently burn through UTR guesses, and while a guess cannot
 * confirm a payment on its own, it does generate merchant review noise.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const intent = await getPaymentIntent(id);
  if (!intent) {
    return jsonError(404, "not_found", `No payment intent with id "${id}".`);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_json", "Request body must be valid JSON.");
  }

  const parsed = ClaimSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(422, "invalid_request", "A UTR is required.");
  }

  const result = await claimUtr(id, parsed.data.utr);

  if (!result.accepted) {
    return jsonError(422, "claim_rejected", result.reason ?? "Claim rejected.");
  }

  return Response.json({
    status: result.intent.status,
    message:
      result.intent.status === "paid"
        ? "This payment is already confirmed."
        : "Thanks — we've recorded your reference. The seller will confirm shortly.",
  });
}
