// All money in this codebase is integer paise. These helpers are the only
// place rupees exist, and they only run at the display / protocol edge.
//
// Rationale: floating point cannot represent 0.1 exactly, and a payment
// gateway that is off by one paise cannot reconcile a bank credit. Integers
// make the unique-paise matching in amount.ts exact by construction.

export const PAISE_PER_RUPEE = 100;

/** Largest amount we will create an intent for: ₹5,00,000 — the NPCI P2M
 *  per-transaction ceiling. Anything above this cannot complete on UPI, so we
 *  reject it at creation rather than let the customer fail at their bank. */
export const MAX_AMOUNT_PAISE = 500_000 * PAISE_PER_RUPEE;

/** Smallest amount UPI will accept. */
export const MIN_AMOUNT_PAISE = 1;

/** "49937" -> "499.37". Always exactly two decimals, which is what the UPI
 *  `am` parameter requires. */
export function formatPaise(paise: number): string {
  assertSafePaise(paise);
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / PAISE_PER_RUPEE);
  const remainder = abs % PAISE_PER_RUPEE;
  return `${sign}${rupees}.${String(remainder).padStart(2, "0")}`;
}

/** Display form with the currency symbol and Indian digit grouping. */
export function formatInr(paise: number): string {
  assertSafePaise(paise);
  const [rupees, decimals] = formatPaise(paise).split(".");
  const negative = rupees.startsWith("-");
  const digits = negative ? rupees.slice(1) : rupees;
  return `${negative ? "-" : ""}₹${groupIndian(digits)}.${decimals}`;
}

/** Indian grouping: last three digits, then pairs. 1234567 -> 12,34,567 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

/** "499.37" | "499" | 499.37 -> 49937. Throws on anything it cannot represent
 *  exactly, rather than silently rounding someone's money. */
export function toPaise(amount: string | number): number {
  const raw = typeof amount === "number" ? amount.toString() : amount.trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) {
    throw new Error(
      `Invalid amount "${raw}": expected rupees with at most 2 decimal places`,
    );
  }
  const [, sign, rupees, decimals = "0"] = match;
  const paise =
    Number(rupees) * PAISE_PER_RUPEE + Number(decimals.padEnd(2, "0"));
  return sign === "-" ? -paise : paise;
}

function assertSafePaise(paise: number): void {
  if (!Number.isInteger(paise)) {
    throw new Error(
      `Money must be integer paise, got ${paise}. Use toPaise() to convert.`,
    );
  }
}
