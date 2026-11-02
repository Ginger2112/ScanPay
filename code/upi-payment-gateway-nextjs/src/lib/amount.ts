import { MAX_AMOUNT_PAISE, MIN_AMOUNT_PAISE } from "./money";

// Unique-paise allocation.
//
// The problem: we are outside the money flow, so when a rupee amount lands in
// the merchant's bank there is nothing in the credit alert that identifies
// *which order* it belongs to. Two customers both paying ₹499 are
// indistinguishable.
//
// The fix: give every live intent a distinct payable amount by adding a small
// paise offset. ₹499.00 becomes ₹499.37, and a ₹499.37 credit then maps to
// exactly one order. This turns reconciliation from fuzzy matching into an
// exact lookup, and it is what makes automatic confirmation possible at all
// without a bank integration.
//
// Two invariants, both of which matter:
//
//   1. The offset is always ADDED, never subtracted. Undercharging a merchant
//      to make our bookkeeping easier would be taking their money.
//
//   2. Uniqueness is enforced by the database, not by this module. These are
//      only *candidates*; the unique index on (merchantId, activeAmountKey)
//      is the actual guarantee, so two concurrent requests cannot both win.

/** Maximum paise added on top of the merchant's price. Caps the customer's
 *  overpayment at 99 paise and gives us 100 concurrent slots per price point. */
export const MAX_PAISE_DELTA = 99;

/** How many live intents can share one base price before allocation fails. */
export const SLOTS_PER_BASE_AMOUNT = MAX_PAISE_DELTA + 1;

export class AmountSlotsExhaustedError extends Error {
  constructor(baseAmountPaise: number) {
    super(
      `No free charge amount for base ${baseAmountPaise} paise: all ` +
        `${SLOTS_PER_BASE_AMOUNT} slots are held by live payment intents. ` +
        `Retry after an existing intent is paid or expires.`,
    );
    this.name = "AmountSlotsExhaustedError";
  }
}

/**
 * Candidate charge amounts for a base price, in the order we should try them.
 *
 * The exact amount comes first so the common case (no concurrent order at the
 * same price) charges precisely what the merchant asked for. The rest are
 * shuffled rather than sequential: sequential allocation would make a store's
 * order volume trivially observable to any customer who watched their own
 * offset climb.
 */
export function candidateChargeAmounts(
  baseAmountPaise: number,
  options: { random?: () => number } = {},
): number[] {
  assertValidBase(baseAmountPaise);
  const random = options.random ?? Math.random;

  const offsets: number[] = [];
  for (let delta = 1; delta <= MAX_PAISE_DELTA; delta++) offsets.push(delta);
  shuffleInPlace(offsets, random);

  return [baseAmountPaise, ...offsets.map((d) => baseAmountPaise + d)].filter(
    (amount) => amount <= MAX_AMOUNT_PAISE,
  );
}

/**
 * Picks the first candidate not already held by a live intent.
 *
 * `taken` comes from the caller's transaction. This is an optimisation to
 * avoid burning retries, NOT the uniqueness guarantee — the database index is.
 * Always be prepared to catch a unique violation and call this again.
 */
export function pickChargeAmount(
  baseAmountPaise: number,
  taken: Iterable<number>,
  options: { random?: () => number } = {},
): number {
  const takenSet = taken instanceof Set ? taken : new Set(taken);
  for (const candidate of candidateChargeAmounts(baseAmountPaise, options)) {
    if (!takenSet.has(candidate)) return candidate;
  }
  throw new AmountSlotsExhaustedError(baseAmountPaise);
}

/** Paise added on top of the merchant's price, for display to the customer. */
export function chargeDelta(
  baseAmountPaise: number,
  chargeAmountPaise: number,
): number {
  return chargeAmountPaise - baseAmountPaise;
}

function assertValidBase(baseAmountPaise: number): void {
  if (!Number.isInteger(baseAmountPaise)) {
    throw new Error(`Base amount must be integer paise, got ${baseAmountPaise}`);
  }
  if (baseAmountPaise < MIN_AMOUNT_PAISE) {
    throw new Error(`Base amount must be at least ${MIN_AMOUNT_PAISE} paise`);
  }
  if (baseAmountPaise > MAX_AMOUNT_PAISE) {
    throw new Error(
      `Base amount ${baseAmountPaise} paise exceeds the NPCI per-transaction ` +
        `ceiling of ${MAX_AMOUNT_PAISE} paise`,
    );
  }
}

/** Fisher-Yates. Not cryptographic — offsets only need to be unpredictable
 *  enough to hide order volume, not to resist an attacker. */
function shuffleInPlace(items: number[], random: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}
