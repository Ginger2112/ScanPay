import { authenticateMerchant, jsonError, unauthorized } from "@/lib/auth";
import { getPaymentIntent, toPublicIntent } from "@/lib/intents";

export const dynamic = "force-dynamic";

/** Status poll. The merchant's server calls this; the webhook is the push
 *  equivalent and is the one integrations should prefer. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const merchant = await authenticateMerchant(request);
  if (!merchant) return unauthorized();

  const { id } = await params;
  const intent = await getPaymentIntent(id);

  // Same response for "does not exist" and "belongs to another merchant", so
  // the endpoint cannot be used to probe for valid intent ids.
  if (!intent || intent.merchantId !== merchant.id) {
    return jsonError(404, "not_found", `No payment intent with id "${id}".`);
  }

  return Response.json(toPublicIntent(intent));
}
