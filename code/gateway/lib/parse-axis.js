// Parse a bank UPI *credit* alert (SMS or email) into { amount, utr, payer }.
//
// Pinned to the real formats of Arun's accounts:
//   AU   "Credited INR 4,700.00 to A/c X7486 on 05-MAY-2025 Ref UPI/CR/512559647968/APARNA"
//   IDBI "Dear Customer, Acct XX888 is credited with Rs 15000.00 on 20-Oct-26 from
//         APARNA ROBIN SA. UPI:629309792612 Avl Bal Rs 33606.27-IDBI Bank"
//
// Direction is decided by whether OUR account is credited, not by the word "credited"
// alone — IDBI debit alerts say "Acct XX888 debited for Rs 130 ... SUMEET credited",
// which is money leaving the account. Only UPI credits count (no UTR = no match).

// Our account is the one credited
const ACCOUNT_CREDITED = [
  /^\W*credited\b/i,                                                    // AU: "Credited INR ..."
  /\b(?:a\/c|acct|account)\b[^.;]{0,40}?\bcredited\b/i,                 // IDBI: "Acct XX888 is credited"
  /\bcredited\b.{0,12}\bto\b.{0,25}\b(?:a\/c|acct|account)\b/i,         // "INR 899 credited to your A/c"
];
// Our account is the one debited (overrides any "credited" later in the text)
const ACCOUNT_DEBITED = [
  /^\W*debited\b/i,                                                     // AU: "Debited INR 40.00 from A/c"
  /\b(?:a\/c|acct|account)\b[^.;]{0,40}?\bdebited\b/i,                  // "Acct XX888 debited for", "account has been ... debited"
  /\bdebited\b.{0,12}\bfrom\b.{0,25}\b(?:a\/c|acct|account)\b/i,
  /\bhas failed\b/i,
];
const UPI = /\bUPI\b/i;

const AMOUNT_PATTERNS = [
  /credited\s+(?:with\s+|for\s+|by\s+)?(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*\.[0-9]{2})/i,  // AU + IDBI
  /(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*\.[0-9]{2})/i,
  /(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*)/i,
];

const UTR_PATTERNS = [
  /UPI\/CR\/([0-9]{9,22})/i,                        // AU: UPI/CR/512559647968/NAME
  /UPI\s*[:#]\s*([0-9]{9,22})/i,                    // IDBI: UPI:629309792612
  /UPI\/(?:[A-Z0-9]+\/)?([0-9]{9,22})/i,            // Axis etc: UPI/P2A/41234.../NAME
  /UPI\s*Ref(?:erence)?\s*(?:no\.?)?[:\s/-]*([0-9]{9,22})/i,
  /\bUTR[:\s/-]*([0-9]{9,22})/i,
  /\bRRN[:\s/-]*([0-9]{9,22})/i,
];

const PAYER_PATTERNS = [
  /UPI\/CR\/\d{9,22}\/([A-Za-z][A-Za-z .]{0,40})/i,         // AU: after the UTR
  /\bfrom\s+([A-Za-z][A-Za-z .]{0,40}?)\.?\s*UPI\s*[:#\/]/i,  // IDBI: "from APARNA ROBIN SA. UPI:"
];

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * @param {string} text  plain-text SMS or (stripped) email body
 * @returns {{amount:number, utr:(string|null), payer:(string|null)}|null}
 */
export function parseAxisCredit(text) {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ').trim();

  if (ACCOUNT_DEBITED.some((re) => re.test(t))) return null;
  if (!ACCOUNT_CREDITED.some((re) => re.test(t))) return null;
  if (!UPI.test(t)) return null; // net-banking / cheque credits aren't UPI payments

  const rawAmount = firstMatch(t, AMOUNT_PATTERNS);
  if (!rawAmount) return null;
  const amount = Number(rawAmount.replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const utr = firstMatch(t, UTR_PATTERNS);
  const p = firstMatch(t, PAYER_PATTERNS);
  const payer = p ? p.trim().replace(/\s*\.+$/, '') || null : null;
  return { amount, utr: utr || null, payer };
}

// Is this SMS sender / email from a bank's alert system?
// AU senders look like "JK-AUBANK", IDBI like "IDBIBK-S"; add other banks here.
export function isAxisSender(from = '') {
  return /aubank|au[-\s]?bank|axisbank|idbibk|idbi/i.test(from);
}
