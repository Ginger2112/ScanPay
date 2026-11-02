// Verifies webhook delivery against a real HTTP receiver, including that the
// signature we send validates with the reference verifier merchants will use.
process.env.API_KEY_PEPPER ??= "change-me-in-production";

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createUpiAccount } from "../src/lib/accounts";
import { generateApiKey } from "../src/lib/apikey";
import { prisma } from "../src/lib/db";
import { dispatchPendingWebhooks } from "../src/lib/dispatch";
import { createPaymentIntent, markPaid } from "../src/lib/intents";
import { generateWebhookSecret, signatureHeaderName, verifySignature } from "../src/lib/webhook";

const ok = (label: string, cond: boolean, extra = "") =>
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);

// UTRs are written to a table that replay detection queries across ALL orders,
// so a hardcoded value makes the suite pass once and fail on every re-run.
let utrSeq = 0;
const uniqueUtr = () =>
  String(Date.now()).slice(-11).padStart(11, "1") + String(utrSeq++ % 10);

interface Received {
  body: string;
  signature: string | undefined;
  verified: boolean;
}

async function main() {
  const received: Received[] = [];
  let respondWith = 200;
  const secret = generateWebhookSecret();

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const signature = req.headers[signatureHeaderName().toLowerCase()] as string | undefined;
      received.push({
        body,
        signature,
        // Verify against the RAW bytes, exactly as a merchant would.
        verified: signature ? verifySignature(body, signature, secret).valid : false,
      });
      res.writeHead(respondWith).end();
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/hook`;

  const key = generateApiKey("test");
  const merchant = await prisma.merchant.create({
    data: {
      name: "Webhook Test Store",
      email: `hook-${Date.now()}@example.com`,
      apiKeyHash: key.hash,
      apiKeyPrefix: key.prefix,
      webhookSecret: secret,
      webhookUrl: url,
    },
  });

  await createUpiAccount({
    merchantId: merchant.id,
    provider: "phonepe_business",
    vpa: `hooktest${Date.now()}@ybl`,
    payeeName: "Webhook Test Store",
  });

  try {
    console.log("\n1. Successful delivery");
    const intent = await createPaymentIntent({
      merchantId: merchant.id, reference: `HOOK-${Date.now()}`, baseAmountPaise: 75000,
    });
    await markPaid(intent.id, { verifiedVia: "manual_approval", utr: uniqueUtr(), actor: "test" });

    const run = await dispatchPendingWebhooks(new Date(), { merchantId: merchant.id });
    ok("one delivery attempted", run.attempted === 1, `attempted ${run.attempted}`);
    ok("delivered", run.delivered === 1);
    ok("receiver got exactly one call", received.length === 1);
    ok("signature header present", Boolean(received[0]?.signature));
    ok("signature verifies against raw body", received[0]?.verified === true);
    ok("payload is the paid event", JSON.parse(received[0].body).event === "payment.paid");

    const row = await prisma.webhookDelivery.findFirstOrThrow({
      where: { paymentIntentId: intent.id },
    });
    ok("marked delivered", row.deliveredAt !== null);
    ok("no further retry scheduled", row.nextAttemptAt === null);

    console.log("\n2. Receiver returns 500 — must retry, not drop");
    respondWith = 500;
    received.length = 0;
    const failing = await createPaymentIntent({
      merchantId: merchant.id, reference: `HOOK-FAIL-${Date.now()}`, baseAmountPaise: 75000,
    });
    await markPaid(failing.id, { verifiedVia: "manual_approval", utr: uniqueUtr(), actor: "test" });

    const failRun = await dispatchPendingWebhooks(new Date(), { merchantId: merchant.id });
    ok("attempted", failRun.attempted === 1);
    ok("not counted as delivered", failRun.delivered === 0);
    ok("scheduled for retry", failRun.failed === 1);

    const failRow = await prisma.webhookDelivery.findFirstOrThrow({
      where: { paymentIntentId: failing.id },
    });
    ok("still undelivered", failRow.deliveredAt === null);
    ok("retry time set in the future", (failRow.nextAttemptAt?.getTime() ?? 0) > Date.now());
    ok("error recorded", failRow.lastError === "HTTP 500", failRow.lastError ?? "");

    console.log("\n3. Retry is not attempted before its backoff elapses");
    received.length = 0;
    const tooSoon = await dispatchPendingWebhooks(new Date(), { merchantId: merchant.id });
    ok("nothing attempted yet", tooSoon.attempted === 0, `attempted ${tooSoon.attempted}`);
    ok("receiver not called again", received.length === 0);

    console.log("\n4. Retry succeeds once the receiver recovers");
    respondWith = 200;
    const later = new Date(Date.now() + 10 * 60 * 1000);
    const recovered = await dispatchPendingWebhooks(later, { merchantId: merchant.id });
    ok("attempted on the next window", recovered.attempted === 1);
    ok("delivered", recovered.delivered === 1);
    ok("signature still verifies", received.at(-1)?.verified === true);
  } finally {
    server.close();
    await prisma.merchant.delete({ where: { id: merchant.id } });
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
