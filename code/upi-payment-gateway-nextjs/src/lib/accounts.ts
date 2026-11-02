import type { UpiAccount } from "@prisma/client";

import { prisma } from "./db";
import { formatInr } from "./money";
import { getProvider } from "./providers";
import { assertValidVpa } from "./upi";

// Choosing which of a merchant's UPI accounts a payment should be addressed to.
//
// Two independent reasons a merchant runs more than one account:
//
//   1. Capacity at a price point. Charge amounts are unique per ACCOUNT, so a
//      second account doubles how many concurrent orders can sit at ₹499.
//   2. Daily receiving limits. Every UPI account has a ceiling; spreading
//      across accounts raises what the merchant can collect in a day.

/**
 * Usage is measured over a rolling 24 hours rather than a calendar day.
 *
 * Bank and PSP limits are usually stated per calendar day, but the reset hour
 * differs between them and is not something we can observe. A rolling window is
 * strictly more conservative: it can never let a merchant exceed a per-day
 * ceiling, at the cost of occasionally being stricter than necessary.
 */
const USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

export class NoAccountAvailableError extends Error {
  constructor(
    readonly merchantId: string,
    readonly reason: "none_configured" | "all_at_limit",
    message: string,
  ) {
    super(message);
    this.name = "NoAccountAvailableError";
  }
}

export interface AccountUsage {
  account: UpiAccount;
  /** Already received in the window, in paise. */
  receivedPaise: number;
  /** Live intents that could still land, in paise. */
  reservedPaise: number;
  /** received + reserved — what we treat as consumed when routing. */
  committedPaise: number;
  remainingPaise: number;
}

/**
 * What each of a merchant's accounts has committed in the current window.
 *
 * Live (unpaid) intents count against the limit as well as paid ones. They
 * represent money that may still arrive, and ignoring them would let a burst of
 * pending orders collectively blow through a ceiling the moment they all pay.
 */
export async function accountUsage(
  merchantId: string,
  now = new Date(),
): Promise<AccountUsage[]> {
  const accounts = await prisma.upiAccount.findMany({
    where: { merchantId, active: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  if (accounts.length === 0) return [];

  const windowStart = new Date(now.getTime() - USAGE_WINDOW_MS);
  const ids = accounts.map((a) => a.id);

  const [received, reserved] = await Promise.all([
    prisma.paymentIntent.groupBy({
      by: ["upiAccountId"],
      where: {
        upiAccountId: { in: ids },
        status: "paid",
        paidAt: { gte: windowStart },
      },
      _sum: { chargeAmountPaise: true },
    }),
    prisma.paymentIntent.groupBy({
      by: ["upiAccountId"],
      where: {
        upiAccountId: { in: ids },
        status: { in: ["pending", "awaiting_confirmation"] },
        expiresAt: { gt: now },
      },
      _sum: { chargeAmountPaise: true },
    }),
  ]);

  const receivedBy = new Map(
    received.map((r) => [r.upiAccountId, r._sum.chargeAmountPaise ?? 0]),
  );
  const reservedBy = new Map(
    reserved.map((r) => [r.upiAccountId, r._sum.chargeAmountPaise ?? 0]),
  );

  return accounts.map((account) => {
    const receivedPaise = receivedBy.get(account.id) ?? 0;
    const reservedPaise = reservedBy.get(account.id) ?? 0;
    const committedPaise = receivedPaise + reservedPaise;
    return {
      account,
      receivedPaise,
      reservedPaise,
      committedPaise,
      remainingPaise: Math.max(0, account.dailyLimitPaise - committedPaise),
    };
  });
}

/**
 * Picks the account a new payment of `amountPaise` should be addressed to.
 *
 * Among accounts with enough headroom, prefers lower `priority`, then the one
 * with the most room left. Spreading rather than filling keeps every account
 * clear of its ceiling, which matters because hitting a UPI limit mid-day fails
 * the customer's payment at their bank with an error we never see.
 */
export async function selectAccountForAmount(
  merchantId: string,
  amountPaise: number,
  now = new Date(),
): Promise<UpiAccount> {
  const usage = await accountUsage(merchantId, now);

  if (usage.length === 0) {
    throw new NoAccountAvailableError(
      merchantId,
      "none_configured",
      "This merchant has no active UPI account. Add one before creating payments.",
    );
  }

  const eligible = usage.filter((u) => u.remainingPaise >= amountPaise);

  if (eligible.length === 0) {
    const best = usage.reduce((a, b) =>
      a.remainingPaise >= b.remainingPaise ? a : b,
    );
    throw new NoAccountAvailableError(
      merchantId,
      "all_at_limit",
      `No UPI account has room for ${formatInr(amountPaise)} in the next 24 hours. ` +
        `The account with the most headroom has ${formatInr(best.remainingPaise)} left. ` +
        `Add another UPI account or raise the configured daily limit.`,
    );
  }

  eligible.sort((a, b) => {
    if (a.account.priority !== b.account.priority) {
      return a.account.priority - b.account.priority;
    }
    return b.remainingPaise - a.remainingPaise;
  });

  return eligible[0].account;
}

export interface CreateUpiAccountInput {
  merchantId: string;
  provider: string;
  vpa: string;
  payeeName: string;
  label?: string;
  /** Overrides the provider default. */
  dailyLimitPaise?: number;
  priority?: number;
}

export async function createUpiAccount(
  input: CreateUpiAccountInput,
): Promise<UpiAccount> {
  const provider = getProvider(input.provider);
  const vpa = assertValidVpa(input.vpa);

  return prisma.upiAccount.create({
    data: {
      merchantId: input.merchantId,
      provider: provider.id,
      vpa,
      payeeName: input.payeeName.trim(),
      label: input.label?.trim() || null,
      accountType: provider.accountType,
      dailyLimitPaise: input.dailyLimitPaise ?? provider.defaultDailyLimitPaise,
      priority: input.priority ?? 0,
    },
  });
}
