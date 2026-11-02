// Merchant-side CLI, standing in for the dashboard until one exists.
//
//   npm run payments            list recent payments
//   npm run payments confirm <id>   mark one paid (as a merchant would)
//   npm run payments reject  <id>   record that the money never arrived
//
// Confirming here is the same code path the future dashboard will use: it
// releases the amount slot, writes the audit event, and queues the webhook.

process.env.API_KEY_PEPPER ??= "change-me-in-production";

import { prisma } from "../src/lib/db";
import { dispatchPendingWebhooks } from "../src/lib/dispatch";
import { markPaid, rejectClaim } from "../src/lib/intents";
import { formatInr } from "../src/lib/money";

const STATUS_LABEL: Record<string, string> = {
  pending: "waiting",
  awaiting_confirmation: "NEEDS REVIEW",
  paid: "paid",
  expired: "expired",
  cancelled: "cancelled",
};

async function list() {
  const intents = await prisma.paymentIntent.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
    include: {
      merchant: { select: { name: true } },
      verificationEvents: {
        where: { kind: "utr_claim", accepted: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  if (intents.length === 0) {
    console.log("\nNo payments yet. Create one with the curl in the README.\n");
    return;
  }

  console.log("\nRecent payments\n");
  for (const i of intents) {
    const claimed = i.verificationEvents[0]?.utr;
    const label = (STATUS_LABEL[i.status] ?? i.status).padEnd(13);
    console.log(
      `  ${label} ${formatInr(i.chargeAmountPaise).padStart(12)}  ${i.reference.padEnd(22)} ${i.id}`,
    );
    if (claimed) console.log(`  ${" ".repeat(13)} customer says UTR ${claimed}`);
  }

  const needsReview = intents.filter((i) => i.status === "awaiting_confirmation");
  if (needsReview.length > 0) {
    console.log(
      `\n${needsReview.length} payment(s) need review. Check the amount actually ` +
        `landed in your bank, then:\n  npm run payments confirm ${needsReview[0].id}\n`,
    );
  } else {
    console.log("");
  }
}

async function confirm(id: string) {
  const intent = await prisma.paymentIntent.findUnique({ where: { id } });
  if (!intent) return console.error(`No payment with id ${id}`);

  const claim = await prisma.verificationEvent.findFirst({
    where: { paymentIntentId: id, kind: "utr_claim", accepted: true },
    orderBy: { createdAt: "desc" },
  });

  const paid = await markPaid(id, {
    verifiedVia: "manual_approval",
    utr: claim?.utr ?? null,
    actor: "cli",
  });

  console.log(
    `\nConfirmed ${paid.reference} — ${formatInr(paid.chargeAmountPaise)}`,
  );
  console.log("Amount slot released back into the pool.");

  const run = await dispatchPendingWebhooks(new Date(), {
    merchantId: paid.merchantId,
  });
  console.log(
    run.attempted === 0
      ? "No webhook queued (merchant has no webhookUrl set).\n"
      : `Webhook: ${run.delivered} delivered, ${run.failed} will retry.\n`,
  );
}

async function reject(id: string) {
  const intent = await rejectClaim(id, "cli", "money not received");
  console.log(
    `\nRejected. ${intent.reference} is back to pending so the customer can retry.\n`,
  );
}

async function main() {
  const [command, id] = process.argv.slice(2);

  if (command === "confirm" || command === "reject") {
    if (!id) {
      console.error(`Usage: npm run payments ${command} <payment-intent-id>`);
      process.exitCode = 1;
      return;
    }
    await (command === "confirm" ? confirm(id) : reject(id));
    return;
  }

  if (command && command !== "list") {
    console.error(`Unknown command "${command}". Use: list | confirm | reject`);
    process.exitCode = 1;
    return;
  }

  await list();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
