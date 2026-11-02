import { prisma } from "./db";
import { MAX_WEBHOOK_ATTEMPTS, nextAttemptAt, signPayload, signatureHeaderName } from "./webhook";

// Webhook delivery.
//
// A paid order that never reaches the merchant's store is the worst failure
// this system has: the customer's money is gone and the store still shows
// unpaid. So delivery is queued durably in the database rather than fired
// inline, and retried on a backoff until it lands or we exhaust attempts.

/** Per-request timeout. Merchant endpoints that hang must not block the queue. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Cap per run so one invocation cannot run unboundedly long. */
const BATCH_SIZE = 50;

export interface DispatchResult {
  attempted: number;
  delivered: number;
  failed: number;
  exhausted: number;
}

export async function dispatchPendingWebhooks(
  now = new Date(),
  options: { merchantId?: string } = {},
): Promise<DispatchResult> {
  const due = await prisma.webhookDelivery.findMany({
    where: {
      deliveredAt: null,
      attempts: { lt: MAX_WEBHOOK_ATTEMPTS },
      nextAttemptAt: { lte: now },
      // Scoping to one merchant lets an operator drain or replay a single
      // store's queue without touching everyone else's.
      ...(options.merchantId
        ? { paymentIntent: { merchantId: options.merchantId } }
        : {}),
    },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
    include: { paymentIntent: { include: { merchant: true } } },
  });

  const result: DispatchResult = {
    attempted: due.length,
    delivered: 0,
    failed: 0,
    exhausted: 0,
  };

  for (const delivery of due) {
    const secret = delivery.paymentIntent.merchant.webhookSecret;
    const attempts = delivery.attempts + 1;

    try {
      const response = await postSigned(delivery.url, delivery.payload, secret);

      if (response.ok) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            attempts,
            lastStatus: response.status,
            lastError: null,
            deliveredAt: new Date(),
            nextAttemptAt: null,
          },
        });
        result.delivered++;
        continue;
      }

      const retryAt = nextAttemptAt(attempts, now);
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          attempts,
          lastStatus: response.status,
          lastError: `HTTP ${response.status}`,
          nextAttemptAt: retryAt,
        },
      });
      if (retryAt) result.failed++;
      else result.exhausted++;
    } catch (err) {
      const retryAt = nextAttemptAt(attempts, now);
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          attempts,
          lastError: err instanceof Error ? err.message : String(err),
          nextAttemptAt: retryAt,
        },
      });
      if (retryAt) result.failed++;
      else result.exhausted++;
    }
  }

  return result;
}

async function postSigned(url: string, body: string, secret: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Signed over the exact bytes we send. Merchants must verify against
        // the raw body, not re-serialised JSON.
        [signatureHeaderName()]: signPayload(body, secret),
        "user-agent": "upi-gateway-webhooks/1",
      },
      body,
      signal: controller.signal,
      redirect: "manual",
    });
  } finally {
    clearTimeout(timer);
  }
}
