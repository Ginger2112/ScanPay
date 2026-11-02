import { PrismaClient } from "@prisma/client";

// Next dev-mode hot reload re-evaluates modules, which would otherwise open a
// new pool on every edit until the database refuses connections.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/** Prisma's unique-constraint violation. */
export const UNIQUE_VIOLATION = "P2002";

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/**
 * Which field(s) a unique violation was raised on.
 *
 * PaymentIntent has three unique constraints that fail for entirely different
 * reasons — a taken charge amount is a retry, a duplicate reference is an
 * already-created order — so the create path has to tell them apart rather
 * than blindly retrying.
 */
export function uniqueViolationTargets(err: unknown): string[] {
  if (!isUniqueViolation(err)) return [];
  const meta = (err as { meta?: { target?: unknown } }).meta;
  const target = meta?.target;
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === "string") {
    // SQLite reports "PaymentIntent.merchantId_activeAmountKey_key".
    return [target];
  }
  return [];
}

export function violationInvolves(err: unknown, field: string): boolean {
  return uniqueViolationTargets(err).some((t) => t.includes(field));
}
