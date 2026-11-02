import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Merchant API keys.
//
// Keys are stored only as an HMAC digest, peppered with a server-side secret,
// so a database leak alone does not yield usable credentials. HMAC rather than
// bcrypt/argon2 is the right call here specifically because these are
// high-entropy random keys, not user-chosen passwords: there is nothing to
// brute-force, and we need the lookup to be a single indexed query on every
// API request.

const KEY_PREFIX_LIVE = "upi_sk_live_";
const KEY_PREFIX_TEST = "upi_sk_test_";

/** Bytes of randomness in the secret portion. 32 bytes = 256 bits. */
const KEY_BYTES = 32;

/** Stored alongside the hash so merchants can tell keys apart in the UI
 *  without us ever being able to show the key again. */
const DISPLAY_PREFIX_LENGTH = 16;

export interface GeneratedApiKey {
  /** Shown to the merchant exactly once, at creation. Never recoverable. */
  plaintext: string;
  /** Safe to display and store in cleartext, e.g. "upi_sk_live_a3f9". */
  prefix: string;
  /** What goes in Merchant.apiKeyHash. */
  hash: string;
}

export function generateApiKey(
  mode: "live" | "test" = "live",
): GeneratedApiKey {
  const prefix = mode === "live" ? KEY_PREFIX_LIVE : KEY_PREFIX_TEST;
  const plaintext = prefix + randomBytes(KEY_BYTES).toString("base64url");
  return {
    plaintext,
    prefix: plaintext.slice(0, DISPLAY_PREFIX_LENGTH),
    hash: hashApiKey(plaintext),
  };
}

export function hashApiKey(plaintext: string): string {
  return createHmac("sha256", getPepper()).update(plaintext).digest("hex");
}

/** Constant-time comparison. Used where we compare digests directly rather
 *  than looking them up by index. */
export function apiKeysMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Pulls the bearer token out of an Authorization header, if present. */
export function extractApiKey(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  return match ? match[1] : null;
}

function getPepper(): string {
  const pepper = process.env.API_KEY_PEPPER;
  if (!pepper) {
    throw new Error(
      "API_KEY_PEPPER is not set. Every stored API key hash is derived from " +
        "it, so it must be set before the server accepts requests.",
    );
  }
  if (
    process.env.NODE_ENV === "production" &&
    pepper === "change-me-in-production"
  ) {
    throw new Error(
      "API_KEY_PEPPER is still the placeholder from .env.example. Generate a " +
        "real one before deploying.",
    );
  }
  return pepper;
}
