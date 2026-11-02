import type { Merchant } from "@prisma/client";

import { extractApiKey, hashApiKey } from "./apikey";
import { prisma } from "./db";

/**
 * Resolves the merchant behind an API request.
 *
 * The lookup is by hash, not by a scan-and-compare, so an invalid key costs one
 * indexed miss and leaks nothing through timing.
 */
export async function authenticateMerchant(
  request: Request,
): Promise<Merchant | null> {
  const key = extractApiKey(request.headers);
  if (!key) return null;

  return prisma.merchant.findUnique({
    where: { apiKeyHash: hashApiKey(key) },
  });
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return Response.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status },
  );
}

export function unauthorized(): Response {
  return jsonError(
    401,
    "unauthorized",
    "Provide your API key as `Authorization: Bearer <key>`.",
  );
}
