// End-to-end lifecycle check against the real dev database.
process.env.API_KEY_PEPPER ??= "change-me-in-production";

import { prisma } from "../src/lib/db";
import {
  claimUtr,
  createPaymentIntent,
  expireStaleIntents,
  markPaid,
} from "../src/lib/intents";
import { verifySignature, signPayload } from "../src/lib/webhook";

const ok = (label: string, cond: boolean, extra = "") =>
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);

async function main() {
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { email: "demo@example.com" },
  });

  // Give the merchant a webhook endpoint so deliveries get queued.
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { webhookUrl: "http://127.0.0.1:9/upi-webhook" /* discard port — never delivered */ },
  });

  const ref = `LIFECYCLE-${Date.now()}`;
  console.log("\n1. Create");
  const intent = await createPaymentIntent({
    merchantId: merchant.id,
    reference: ref,
    baseAmountPaise: 129900,
  });
  ok("status is pending", intent.status === "pending");
  ok("holds an amount slot", intent.activeAmountKey === intent.chargeAmountPaise);
  ok("never undercharges", intent.chargeAmountPaise >= intent.baseAmountPaise,
     `${intent.baseAmountPaise} -> ${intent.chargeAmountPaise}`);

  console.log("\n2. Customer submits a bad UTR");
  const bad = await claimUtr(intent.id, "123");
  ok("rejected", !bad.accepted, bad.reason);
  ok("still pending", (await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status === "pending");

  console.log("\n3. Customer submits a valid-format UTR");
  // Must differ every run: replay detection is global across orders, so a
  // hardcoded UTR makes this suite pass once and fail on every re-run.
  const utr = String(Date.now()).slice(-12).padStart(12, "1");
  const claim = await claimUtr(intent.id, utr);
  ok("accepted", claim.accepted);
  ok("moves to awaiting_confirmation", claim.intent.status === "awaiting_confirmation");
  ok("does NOT mark paid on a self-reported UTR", claim.intent.status !== "paid");

  console.log("\n4. Same UTR replayed against a different order");
  const other = await createPaymentIntent({
    merchantId: merchant.id, reference: `${ref}-B`, baseAmountPaise: 129900,
  });
  const replay = await claimUtr(other.id, utr);
  ok("replay rejected", !replay.accepted, replay.reason);

  console.log("\n5. Merchant confirms");
  const paid = await markPaid(intent.id, {
    verifiedVia: "manual_approval", utr, actor: `merchant:${merchant.id}`,
  });
  ok("status is paid", paid.status === "paid");
  ok("amount slot released", paid.activeAmountKey === null);
  ok("paidAt set", paid.paidAt !== null);

  console.log("\n6. Webhook queued and signable");
  const deliveries = await prisma.webhookDelivery.findMany({
    where: { paymentIntentId: intent.id },
  });
  ok("exactly one delivery queued", deliveries.length === 1, `got ${deliveries.length}`);
  if (deliveries[0]) {
    const body = deliveries[0].payload;
    const header = signPayload(body, merchant.webhookSecret);
    ok("signature verifies", verifySignature(body, header, merchant.webhookSecret).valid);
    ok("tampered body fails", !verifySignature(body.replace("paid", "xxxx"), header, merchant.webhookSecret).valid);
    const parsed = JSON.parse(body);
    ok("payload carries the merchant's own reference", parsed.reference === ref);
    ok("payload carries both amounts", parsed.baseAmountPaise === 129900 && parsed.chargeAmountPaise === paid.chargeAmountPaise);
  }

  console.log("\n7. Confirming twice does not double-fire");
  await markPaid(intent.id, { verifiedVia: "manual_approval", utr, actor: "merchant:retry" });
  const after = await prisma.webhookDelivery.count({ where: { paymentIntentId: intent.id } });
  ok("still exactly one delivery", after === 1, `got ${after}`);

  console.log("\n8. Slot reuse after settlement");
  const reuse = await createPaymentIntent({
    merchantId: merchant.id, reference: `${ref}-C`, baseAmountPaise: 129900,
  });
  ok("freed amount is available again", reuse.chargeAmountPaise === paid.chargeAmountPaise,
     `freed ${paid.chargeAmountPaise}, got ${reuse.chargeAmountPaise}`);

  console.log("\n9. Expiry releases slots");
  await prisma.paymentIntent.update({
    where: { id: reuse.id }, data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const expired = await expireStaleIntents(merchant.id);
  ok("expired at least one", expired >= 1, `${expired} expired`);
  const check = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: reuse.id } });
  ok("expired intent releases its slot", check.activeAmountKey === null && check.status === "expired");

  console.log("\n10. Audit trail retained");
  const events = await prisma.verificationEvent.findMany({ where: { paymentIntentId: intent.id } });
  ok("rejected and accepted claims both kept", events.length >= 3, `${events.length} events`);
  ok("rejections recorded", events.some((e) => !e.accepted));
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
