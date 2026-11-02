import { jsonError } from "@/lib/auth";
import { dispatchPendingWebhooks } from "@/lib/dispatch";
import { expireStaleIntents } from "@/lib/intents";

export const dynamic = "force-dynamic";

/**
 * Queue runner: flushes due webhooks and releases expired amount slots.
 *
 * Intended to be hit on a schedule (Vercel Cron, or any external scheduler)
 * roughly every minute. Guarded by a shared secret rather than a merchant API
 * key because it acts across all merchants.
 */
export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return jsonError(
      503,
      "not_configured",
      "CRON_SECRET is not set, so the queue runner is disabled.",
    );
  }

  const provided = request.headers.get("authorization");
  if (provided !== `Bearer ${expected}`) {
    return jsonError(401, "unauthorized", "Invalid cron credentials.");
  }

  const expired = await expireStaleIntents();
  const webhooks = await dispatchPendingWebhooks();

  return Response.json({ expiredIntents: expired, webhooks });
}
