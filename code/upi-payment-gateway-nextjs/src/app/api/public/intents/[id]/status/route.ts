import { jsonError } from "@/lib/auth";
import { getPaymentIntent } from "@/lib/intents";

export const dynamic = "force-dynamic";

/**
 * Status poll for the hosted checkout page.
 *
 * Public because the payer has no credentials. It returns only the status —
 * no amounts, no reference, no customer details — so a leaked or guessed
 * intent id reveals nothing useful about the order or the merchant.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const intent = await getPaymentIntent(id);

  if (!intent) {
    return jsonError(404, "not_found", "Unknown payment.");
  }

  return Response.json(
    { status: intent.status },
    { headers: { "cache-control": "no-store" } },
  );
}
