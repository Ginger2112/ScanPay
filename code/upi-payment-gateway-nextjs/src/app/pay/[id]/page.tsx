import { notFound } from "next/navigation";
import QRCode from "qrcode";

import { prisma } from "@/lib/db";
import { buildCheckout, getPaymentIntent } from "@/lib/intents";
import { buildAppSpecificUri } from "@/lib/upi";

import { Checkout } from "./checkout";

export const dynamic = "force-dynamic";

export default async function PayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const intent = await getPaymentIntent(id);
  if (!intent) notFound();

  // Addressed to the account this intent routed to, not the merchant — a
  // merchant may collect into several.
  const account = await prisma.upiAccount.findUnique({
    where: { id: intent.upiAccountId },
  });
  if (!account) notFound();

  const checkout = buildCheckout(intent, account);

  // Rendered server-side so the client never needs a QR library, and the image
  // is ready on first paint rather than after a hydration round-trip.
  const qrDataUrl = await QRCode.toDataURL(checkout.upiUri, {
    width: 440,
    margin: 0,
    errorCorrectionLevel: "M",
  });

  const linkParams = {
    vpa: account.vpa,
    payeeName: account.payeeName,
    amountPaise: intent.chargeAmountPaise,
    note: intent.description ?? `Order ${intent.reference}`,
    reference: intent.reference,
  };

  return (
    <Checkout
      checkout={checkout}
      qrDataUrl={qrDataUrl}
      appLinks={{
        gpay: buildAppSpecificUri("gpay", linkParams),
        phonepe: buildAppSpecificUri("phonepe", linkParams),
        paytm: buildAppSpecificUri("paytm", linkParams),
      }}
    />
  );
}
