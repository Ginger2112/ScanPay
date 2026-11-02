import { formatPaise } from "./money";

// Builds NPCI UPI deep links. This is the entire extent of our involvement in
// a payment: we hand the customer a URI addressed to the *merchant's* VPA.
// The money moves bank to bank and never passes through us.
//
// Spec reference: NPCI UPI Linking Specification, the `upi://pay` intent.
// Parameters we use:
//   pa  payee address (VPA)          required
//   pn  payee name                   required
//   am  amount, exactly 2 decimals   locks the amount in most UPI apps
//   cu  currency                     INR
//   tn  transaction note             shown to the customer, apps truncate it
//   tr  transaction reference        echoed on the customer's receipt
//
// Deliberately omitted: `mc` (merchant category code), `mode`, `orgid` and
// `sign`. Those belong to PSP-signed verified-merchant flows. We are not a PSP
// and cannot sign, and sending an unsigned `mc` gets links rejected by some
// apps.

/** identifier@psp — NPCI's VPA shape. Deliberately permissive on the handle
 *  since PSPs keep adding new ones; we only reject clearly malformed input. */
const VPA_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9.\-_]{0,255})@[a-zA-Z][a-zA-Z0-9.\-]{1,63}$/;

export function isValidVpa(vpa: string): boolean {
  return VPA_REGEX.test(vpa.trim());
}

/** There is no free public VPA-existence check without a PSP relationship, so
 *  format validation is genuinely all we can offer. A typo'd but well-formed
 *  VPA will silently fail at the customer's UPI app, so the merchant
 *  onboarding flow must include a real test payment. */
export function assertValidVpa(vpa: string): string {
  const trimmed = vpa.trim();
  if (!isValidVpa(trimmed)) {
    throw new Error(`"${vpa}" is not a valid UPI ID (expected name@bank)`);
  }
  return trimmed;
}

export interface UpiLinkParams {
  vpa: string;
  payeeName: string;
  amountPaise: number;
  note?: string;
  reference?: string;
}

export function buildUpiUri(params: UpiLinkParams): string {
  const { vpa, payeeName, amountPaise, note, reference } = params;

  const query = new URLSearchParams({
    pa: assertValidVpa(vpa),
    pn: sanitiseText(payeeName, 50),
    am: formatPaise(amountPaise),
    cu: "INR",
  });

  if (note) query.set("tn", sanitiseText(note, 50));
  if (reference) query.set("tr", sanitiseReference(reference));

  // URLSearchParams encodes spaces as "+", which several UPI apps render
  // literally in the payee name. %20 is handled correctly everywhere.
  return `upi://pay?${query.toString().replace(/\+/g, "%20")}`;
}

/** UPI apps that register their own scheme. Offering these as explicit buttons
 *  is more reliable on mobile than the bare `upi://` chooser, which some
 *  in-app browsers swallow without showing anything. */
export const UPI_APPS = [
  { id: "gpay", label: "Google Pay", scheme: "tez://upi/pay" },
  { id: "phonepe", label: "PhonePe", scheme: "phonepe://pay" },
  { id: "paytm", label: "Paytm", scheme: "paytmmp://pay" },
] as const;

export type UpiAppId = (typeof UPI_APPS)[number]["id"];

/** Same query string, app-specific scheme. */
export function buildAppSpecificUri(
  appId: UpiAppId,
  params: UpiLinkParams,
): string {
  const app = UPI_APPS.find((a) => a.id === appId);
  if (!app) throw new Error(`Unknown UPI app: ${appId}`);
  const query = buildUpiUri(params).split("?")[1];
  return `${app.scheme}?${query}`;
}

/** UPI apps mangle or reject punctuation in `pn` and `tn`. Strip to a safe set
 *  and cap length rather than let a store name break the link. */
function sanitiseText(value: string, maxLength: number): string {
  const cleaned = value
    .replace(/[^\w\s.\-&]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, maxLength) || "Merchant";
}

/** `tr` must be alphanumeric for broad app compatibility. */
function sanitiseReference(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9]/g, "");
  return cleaned.slice(0, 35) || "REF";
}

/** UPI reference / UTR as shown in the customer's app: 12 digits.
 *  Format-checking only — we cannot verify a UTR against the banking network
 *  without a PSP, so a well-formed fake passes here and must still be
 *  confirmed by the merchant or by a matched credit alert. */
const UTR_REGEX = /^\d{12}$/;

export function isValidUtrFormat(utr: string): boolean {
  return UTR_REGEX.test(utr.trim());
}
