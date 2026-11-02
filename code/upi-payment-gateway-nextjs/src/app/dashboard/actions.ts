"use server";

import { revalidatePath } from "next/cache";

import { createUpiAccount } from "@/lib/accounts";
import { prisma } from "@/lib/db";
import { dispatchPendingWebhooks } from "@/lib/dispatch";
import { createPaymentIntent, markPaid, rejectClaim } from "@/lib/intents";
import { toPaise } from "@/lib/money";

/**
 * Merchant confirms the money landed in their bank.
 *
 * This is the only place a payment becomes `paid` from the UI. It is
 * deliberately a human decision: a customer-submitted UTR cannot be checked
 * against the banking network, so a person has to look at their bank first.
 */
export async function confirmPayment(formData: FormData) {
  const id = String(formData.get("id"));

  const claim = await prisma.verificationEvent.findFirst({
    where: { paymentIntentId: id, kind: "utr_claim", accepted: true },
    orderBy: { createdAt: "desc" },
  });

  const paid = await markPaid(id, {
    verifiedVia: "manual_approval",
    utr: claim?.utr ?? null,
    actor: "dashboard",
  });

  // Flush this merchant's queue immediately so the store hears about it now
  // rather than on the next cron tick.
  await dispatchPendingWebhooks(new Date(), { merchantId: paid.merchantId });

  revalidatePath("/dashboard");
}

export async function rejectPayment(formData: FormData) {
  const id = String(formData.get("id"));
  await rejectClaim(id, "dashboard", "money not received");
  revalidatePath("/dashboard");
}

/**
 * Registers a UPI account the merchant already owns.
 *
 * Note this is not an integration with the provider — no UPI app exposes a
 * public API to link an account. The merchant is telling us which VPA to
 * address and which app their confirmation will arrive in.
 */
export async function addUpiAccount(formData: FormData) {
  const merchantId = String(formData.get("merchantId"));
  const provider = String(formData.get("provider"));
  const vpa = String(formData.get("vpa") || "").trim();
  const payeeName = String(formData.get("payeeName") || "").trim();
  const label = String(formData.get("label") || "").trim();
  const dailyLimit = String(formData.get("dailyLimit") || "").trim();

  if (!vpa || !payeeName) return;

  await createUpiAccount({
    merchantId,
    provider,
    vpa,
    payeeName,
    label: label || undefined,
    dailyLimitPaise: dailyLimit ? toPaise(dailyLimit) : undefined,
  });

  revalidatePath("/dashboard");
}

export async function toggleUpiAccount(formData: FormData) {
  const id = String(formData.get("id"));
  const account = await prisma.upiAccount.findUnique({ where: { id } });
  if (!account) return;

  await prisma.upiAccount.update({
    where: { id },
    data: { active: !account.active },
  });

  revalidatePath("/dashboard");
}

/** Creates a payment without needing curl, so the flow can be exercised from
 *  the browser alone. */
export async function createTestPayment(formData: FormData) {
  const merchantId = String(formData.get("merchantId"));
  const rupees = String(formData.get("amount") || "").trim();
  const description = String(formData.get("description") || "").trim();

  if (!rupees) return;

  await createPaymentIntent({
    merchantId,
    reference: `TEST-${Date.now()}`,
    baseAmountPaise: toPaise(rupees),
    description: description || undefined,
  });

  revalidatePath("/dashboard");
}
