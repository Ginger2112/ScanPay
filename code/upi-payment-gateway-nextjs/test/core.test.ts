import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.API_KEY_PEPPER ??= "test-pepper-not-for-production";

import {
  AmountSlotsExhaustedError,
  MAX_PAISE_DELTA,
  candidateChargeAmounts,
  chargeDelta,
  pickChargeAmount,
} from "../src/lib/amount";
import { apiKeysMatch, extractApiKey, generateApiKey, hashApiKey } from "../src/lib/apikey";
import { formatInr, formatPaise, toPaise } from "../src/lib/money";
import {
  buildAppSpecificUri,
  buildUpiUri,
  isValidUtrFormat,
  isValidVpa,
} from "../src/lib/upi";
import { nextAttemptAt, signPayload, verifySignature } from "../src/lib/webhook";

describe("money", () => {
  it("formats paise with exactly two decimals", () => {
    assert.equal(formatPaise(49937), "499.37");
    assert.equal(formatPaise(49900), "499.00");
    assert.equal(formatPaise(5), "0.05");
    assert.equal(formatPaise(0), "0.00");
  });

  it("groups rupees the Indian way", () => {
    assert.equal(formatInr(49937), "₹499.37");
    assert.equal(formatInr(123456789), "₹12,34,567.89");
    assert.equal(formatInr(100000), "₹1,000.00");
  });

  it("round-trips through toPaise", () => {
    for (const value of ["499.37", "0.01", "1", "500000.00"]) {
      assert.equal(formatPaise(toPaise(value)), Number(value).toFixed(2));
    }
  });

  it("refuses amounts it cannot represent exactly", () => {
    assert.throws(() => toPaise("499.371"), /at most 2 decimal/);
    assert.throws(() => toPaise("abc"), /Invalid amount/);
    assert.throws(() => formatPaise(499.37), /integer paise/);
  });
});

describe("unique-paise allocation", () => {
  it("offers the exact amount first so the common case is not overcharged", () => {
    assert.equal(candidateChargeAmounts(49900)[0], 49900);
  });

  it("never undercharges and never exceeds the delta cap", () => {
    const base = 49900;
    for (const candidate of candidateChargeAmounts(base)) {
      assert.ok(candidate >= base, `${candidate} undercharges ${base}`);
      assert.ok(candidate <= base + MAX_PAISE_DELTA, `${candidate} overshoots`);
    }
  });

  it("produces one slot per offset, with no duplicates", () => {
    const candidates = candidateChargeAmounts(49900);
    assert.equal(candidates.length, MAX_PAISE_DELTA + 1);
    assert.equal(new Set(candidates).size, candidates.length);
  });

  it("does not allocate sequentially, which would leak order volume", () => {
    // The exact amount is always first; the tail must not be in order.
    const tail = candidateChargeAmounts(49900).slice(1);
    const sorted = [...tail].sort((a, b) => a - b);
    assert.notDeepEqual(tail, sorted);
  });

  it("skips amounts already held by live intents", () => {
    const taken = new Set([49900, 49901, 49902]);
    const picked = pickChargeAmount(49900, taken);
    assert.ok(!taken.has(picked));
    assert.ok(picked > 49902 || picked > 49900);
  });

  it("throws rather than reusing an amount when every slot is held", () => {
    const taken = new Set(candidateChargeAmounts(49900));
    assert.throws(
      () => pickChargeAmount(49900, taken),
      AmountSlotsExhaustedError,
    );
  });

  it("rejects amounts above the NPCI per-transaction ceiling", () => {
    assert.throws(() => candidateChargeAmounts(500_001 * 100), /ceiling/);
  });

  it("reports the delta added on top of the merchant price", () => {
    assert.equal(chargeDelta(49900, 49937), 37);
  });
});

describe("UPI deep links", () => {
  it("accepts well-formed VPAs and rejects malformed ones", () => {
    for (const vpa of ["arun@okhdfcbank", "test.user-1@ybl", "a1@paytm"]) {
      assert.ok(isValidVpa(vpa), `${vpa} should be valid`);
    }
    for (const vpa of ["noatsign", "@ybl", "user@", "user@@ybl", ""]) {
      assert.ok(!isValidVpa(vpa), `${vpa} should be rejected`);
    }
  });

  it("builds a link addressed to the merchant's own VPA", () => {
    const uri = buildUpiUri({
      vpa: "arun@okhdfcbank",
      payeeName: "Arun Store",
      amountPaise: 49937,
      note: "Order 1042",
      reference: "ORD-1042",
    });
    const query = new URLSearchParams(uri.split("?")[1]);

    assert.ok(uri.startsWith("upi://pay?"));
    assert.equal(query.get("pa"), "arun@okhdfcbank");
    assert.equal(query.get("pn"), "Arun Store");
    assert.equal(query.get("am"), "499.37");
    assert.equal(query.get("cu"), "INR");
    assert.equal(query.get("tr"), "ORD1042");
  });

  it("encodes spaces as %20, not +, which UPI apps render literally", () => {
    const uri = buildUpiUri({
      vpa: "arun@okhdfcbank",
      payeeName: "Arun Store",
      amountPaise: 100,
    });
    assert.ok(uri.includes("Arun%20Store"));
    assert.ok(!uri.includes("+"));
  });

  it("omits the unsigned merchant category code", () => {
    // `mc` without a PSP signature gets links rejected by some apps.
    const uri = buildUpiUri({
      vpa: "arun@okhdfcbank",
      payeeName: "Store",
      amountPaise: 100,
    });
    assert.ok(!uri.includes("mc="));
    assert.ok(!uri.includes("sign="));
  });

  it("reuses the same query for app-specific schemes", () => {
    const params = {
      vpa: "arun@okhdfcbank",
      payeeName: "Store",
      amountPaise: 49937,
    };
    const gpay = buildAppSpecificUri("gpay", params);
    assert.ok(gpay.startsWith("tez://upi/pay?"));
    assert.equal(gpay.split("?")[1], buildUpiUri(params).split("?")[1]);
  });

  it("rejects a malformed VPA at link-build time", () => {
    assert.throws(
      () => buildUpiUri({ vpa: "nope", payeeName: "S", amountPaise: 100 }),
      /not a valid UPI ID/,
    );
  });

  it("checks UTR shape only — a well-formed fake still passes", () => {
    assert.ok(isValidUtrFormat("123456789012"));
    assert.ok(!isValidUtrFormat("12345"));
    assert.ok(!isValidUtrFormat("abcdefghijkl"));
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ event: "payment.paid", id: "pi_1" });

  it("verifies a signature it just produced", () => {
    const header = signPayload(body, secret);
    assert.deepEqual(verifySignature(body, header, secret), { valid: true });
  });

  it("rejects a tampered body", () => {
    const header = signPayload(body, secret);
    const tampered = JSON.stringify({ event: "payment.paid", id: "pi_2" });
    assert.equal(verifySignature(tampered, header, secret).valid, false);
  });

  it("rejects the wrong secret", () => {
    const header = signPayload(body, secret);
    assert.equal(verifySignature(body, header, "whsec_other").valid, false);
  });

  it("rejects a replayed signature outside the tolerance window", () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const header = signPayload(body, secret, old);
    const result = verifySignature(body, header, secret);
    assert.equal(result.valid, false);
    assert.match(result.reason ?? "", /tolerance/);
  });

  it("rejects a malformed header instead of throwing", () => {
    assert.equal(verifySignature(body, "garbage", secret).valid, false);
    assert.equal(verifySignature(body, "t=123", secret).valid, false);
  });

  it("backs off between retries and eventually gives up", () => {
    assert.ok(nextAttemptAt(0) instanceof Date);
    const first = nextAttemptAt(1)!.getTime();
    const second = nextAttemptAt(2)!.getTime();
    assert.ok(second > first, "backoff should increase");
    assert.equal(nextAttemptAt(99), null, "must stop retrying eventually");
  });
});

describe("api keys", () => {
  it("never stores the plaintext and hashes deterministically", () => {
    const key = generateApiKey("live");
    assert.ok(key.plaintext.startsWith("upi_sk_live_"));
    assert.notEqual(key.hash, key.plaintext);
    assert.equal(key.hash, hashApiKey(key.plaintext));
  });

  it("keeps a display prefix that cannot reconstruct the key", () => {
    const key = generateApiKey();
    assert.ok(key.plaintext.startsWith(key.prefix));
    assert.ok(key.prefix.length < key.plaintext.length);
  });

  it("produces a distinct key every time", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey().plaintext));
    assert.equal(keys.size, 50);
  });

  it("compares in constant time without throwing on length mismatch", () => {
    assert.ok(apiKeysMatch("abc", "abc"));
    assert.ok(!apiKeysMatch("abc", "abcd"));
  });

  it("pulls a bearer token out of the Authorization header", () => {
    const headers = new Headers({ authorization: "Bearer upi_sk_live_xyz" });
    assert.equal(extractApiKey(headers), "upi_sk_live_xyz");
    assert.equal(extractApiKey(new Headers()), null);
  });
});
