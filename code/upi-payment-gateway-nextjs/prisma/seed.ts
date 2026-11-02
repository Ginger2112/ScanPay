import { PrismaClient } from "@prisma/client";

import { createUpiAccount } from "../src/lib/accounts";
import { generateApiKey } from "../src/lib/apikey";
import { formatInr } from "../src/lib/money";
import { getProvider } from "../src/lib/providers";
import { generateWebhookSecret } from "../src/lib/webhook";

const prisma = new PrismaClient();

async function main() {
  const apiKey = generateApiKey("test");

  const merchant = await prisma.merchant.upsert({
    where: { email: "demo@example.com" },
    // Rotate the key on every seed run. An empty update here would leave the
    // stored hash untouched while we print a fresh key, so the key we hand the
    // user would authenticate against nothing.
    update: {
      apiKeyHash: apiKey.hash,
      apiKeyPrefix: apiKey.prefix,
    },
    create: {
      name: "Demo Store",
      email: "demo@example.com",
      apiKeyHash: apiKey.hash,
      apiKeyPrefix: apiKey.prefix,
      webhookSecret: generateWebhookSecret(),
    },
  });

  // Two accounts so the demo exercises routing. Replace both with real business
  // VPAs before taking a live payment.
  const existing = await prisma.upiAccount.count({
    where: { merchantId: merchant.id },
  });
  if (existing === 0) {
    await createUpiAccount({
      merchantId: merchant.id,
      provider: "gpay_business",
      vpa: "demo@okhdfcbank",
      payeeName: "Demo Store",
      label: "Google Pay – main",
    });
    await createUpiAccount({
      merchantId: merchant.id,
      provider: "phonepe_business",
      vpa: "demostore@ybl",
      payeeName: "Demo Store",
      label: "PhonePe – overflow",
      priority: 1,
    });
  }

  const accounts = await prisma.upiAccount.findMany({
    where: { merchantId: merchant.id },
    orderBy: { priority: "asc" },
  });

  console.log("\nSeeded merchant:", merchant.name);
  console.log("Merchant id:     ", merchant.id);
  console.log("UPI accounts:");
  for (const a of accounts) {
    console.log(
      `  ${a.vpa.padEnd(24)} ${getProvider(a.provider).label}` +
        `  limit ${formatInr(a.dailyLimitPaise)}/day`,
    );
  }
  console.log(
    "\nAPI key (rotated by this run; stored only as a hash, so copy it now):",
  );
  console.log("  " + apiKey.plaintext);
  console.log("\nCreate a payment intent:\n");
  console.log(
    `  curl -s localhost:3000/api/v1/payment-intents \\\n` +
      `    -H "Authorization: Bearer ${apiKey.plaintext}" \\\n` +
      `    -H "Content-Type: application/json" \\\n` +
      `    -d '{"reference":"ORD-1001","amountPaise":49900,"description":"Test order"}'\n`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
