// Parse a UPI *credit* alert into { amount, utr, payer, kind, bank }.
// Two kinds of input:
//   bank  – bank SMS / bank-app push / bank email (AU, IDBI, SBI, HDFC, ICICI, Kotak, Axis, BoB, PNB, Canara …)
//   app   – UPI business-app push (PhonePe Business, Paytm for Business, GPay Business, BharatPe …),
//           usually WITHOUT a UTR, so it matches by amount only.
// Anything we can't read returns null: the order then waits for the manual UTR / cash confirm.
//
// VERIFIED against real SMS: AU, IDBI (Arun's own accounts).
// UNVERIFIED (built from public sample formats): every other bank and every UPI app below.
// Add each real message to test/parse-bank.test.mjs the first time a client's bank sends one.
//
// Direction is decided by whether OUR account is credited, not by the word "credited"
// alone: "Acct XX888 debited for Rs 130 ... SUMEET credited" is money leaving.

// "A/cX1234" (SBI) has no space after A/c, so a/c only needs a left boundary.
const ACCT = String.raw`(?:\ba\/c|\bacct\b|\baccount\b|\bac\b)`;

const ACCOUNT_CREDITED = [
  /^\W*credited\b/i,                                                        // AU: "Credited INR ..."
  new RegExp(String.raw`${ACCT}[^.;]{0,40}?\bcredited\b`, 'i'),             // "Acct XX888 is credited", SBI "A/C X1234 credited by"
  new RegExp(String.raw`\bcredited\b.{0,12}\bto\b.{0,30}${ACCT}`, 'i'),     // Axis/BoB/Canara "credited to (your) A/c"
  new RegExp(String.raw`\breceived\b.{0,40}\bin\s+your\b.{0,40}${ACCT}`, 'i'), // HDFC/Kotak "Received Rs.500 in your ... a/c"
  /\bhas a credit\b/i,                                                      // SBI "has a credit by Transfer of Rs"
];
const ACCOUNT_DEBITED = [
  /^\W*debited\b/i,
  new RegExp(String.raw`${ACCT}[^.;]{0,40}?\bdebited\b`, 'i'),
  new RegExp(String.raw`\bdebited\b.{0,12}\bfrom\b.{0,30}${ACCT}`, 'i'),
  /\b(?:money\s+)?sent\b.{0,30}\bfrom\b/i,                                  // HDFC/Kotak "Sent Rs.X From ... A/c"
  /\bhas failed\b/i,
  /\bwill be (?:debited|credited)\b/i,                                      // collect requests, promises
];
const UPI = /\bUPI\b/i;

const NUM = String.raw`([0-9][0-9,]*(?:\.[0-9]{1,2})?)`;
const CUR = String.raw`(?:INR|Rs\.?|₹)`;
const AMOUNT_PATTERNS = [
  new RegExp(String.raw`credited\s+(?:with\s+|for\s+|by\s+)?${CUR}\s*${NUM}`, 'i'), // AU, IDBI, SBI, ICICI, PNB
  new RegExp(String.raw`received\s*[-:]?\s*${CUR}\s*${NUM}`, 'i'),                 // HDFC "Money Received - INR", Kotak
  new RegExp(String.raw`credit by \w+ of ${CUR}\s*${NUM}`, 'i'),                   // SBI "credit by Transfer of Rs"
  new RegExp(String.raw`amount of ${CUR}\s*${NUM}`, 'i'),                          // Canara "An amount of INR"
  new RegExp(String.raw`${CUR}\s*${NUM}`, 'i'),                                    // first amount in the text
];

const UTR_PATTERNS = [
  /UPI\/CR\/([0-9]{9,22})/i,                                  // AU: UPI/CR/512559647968/NAME
  /UPI\s*[:#]\s*([0-9]{9,22})/i,                              // IDBI/ICICI: UPI:629309792612
  /UPI\/(?:[A-Z0-9]+\/)?([0-9]{9,22})/i,                      // Axis UPI/P2A/4123.../NAME, BoB UPI/4123...
  /UPI\s*Ref(?:erence)?\.?\s*(?:no\.?|id|number)?[:\s/-]*([0-9]{9,22})/i, // HDFC/Kotak/PNB/Canara "UPI Ref No", "UPI Ref ID"
  /\(UPI\s+([0-9]{9,22})\)/i,                                 // HDFC "(UPI 430512345678)"
  /\bRef\.?\s*no\.?\s*[:\s]*([0-9]{9,22})/i,                  // SBI "Ref no 4305..." / "Refno"
  /\bUTR\s*(?:no\.?)?[:\s/-]*([0-9]{9,22})/i,
  /\bRRN[:\s/-]*([0-9]{9,22})/i,
];

const PAYER_PATTERNS = [
  /UPI\/CR\/\d{9,22}\/([A-Za-z][A-Za-z .]{0,40})/i,            // AU
  /UPI\/P2[AM]\/\d{9,22}\/([A-Za-z][A-Za-z .]{0,40})/i,        // Axis
  /\bfrom\s+([A-Za-z][A-Za-z .]{0,40}?)\.?\s*UPI\s*[:#\/]/i,   // IDBI/ICICI: "from APARNA ROBIN SA. UPI:"
  /\b(?:VPA|from|by)\s+([a-zA-Z0-9.\-_]{2,64}@[a-zA-Z][a-zA-Z0-9]{1,63})/i, // HDFC/Kotak/BoB: the payer's VPA
];

const BANKS = [
  ['AU', /aubank|au[-\s]?bank|au small/i], ['IDBI', /idbi/i], ['SBI', /\bsbi\b|sbiinb|sbipsg|state bank|-sbi\b/i],
  ['HDFC', /hdfc/i], ['ICICI', /icici/i], ['Kotak', /kotak|kotakb/i], ['Axis', /axis/i],
  ['BoB', /bank of baroda|\bbob\b|barodm|barb/i], ['PNB', /\bpnb\b|punjab national|pnbsms/i],
  ['Canara', /canara|cnrb/i], ['Union', /union bank|unionb/i], ['Yes', /yes ?bank|yesbnk/i], ['IndusInd', /indusind|indusb/i],
];
const bankOf = (s) => (BANKS.find(([, re]) => re.test(s)) || [null])[0];

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}
const money = (raw) => {
  if (!raw) return null;
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
const tidy = (p) => (p ? p.trim().replace(/\s*\.+$/, '') || null : null);

/** Bank alert (SMS / bank app / email). */
export function parseBankCredit(text, sender = '') {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (ACCOUNT_DEBITED.some((re) => re.test(t))) return null;
  if (!ACCOUNT_CREDITED.some((re) => re.test(t))) return null;
  if (!UPI.test(t)) return null; // net-banking / cheque / NEFT credits aren't UPI payments
  const amount = money(firstMatch(t, AMOUNT_PATTERNS));
  if (!amount) return null;
  const utr = firstMatch(t, UTR_PATTERNS);
  return { amount, utr: utr || null, payer: tidy(firstMatch(t, PAYER_PATTERNS)), kind: 'bank', bank: bankOf(sender) || bankOf(t) }; // sender first: the text may name the payer's bank
}

// --- UPI business apps (push notifications) ---
const UPI_APPS = [
  ['PhonePe', /phonepe/i], ['Paytm', /paytm/i], ['GPay', /nbu\.paisa|gpay|google ?pay|tez/i],
  ['BharatPe', /bharatpe/i], ['BHIM', /bhim/i], ['Amazon Pay', /amazon.*pay/i], ['Pine Labs', /pinelabs|pine labs/i],
];
export const upiAppOf = (sender = '') => (UPI_APPS.find(([, re]) => re.test(sender)) || [null])[0];

const APP_NOT_A_CREDIT = /\b(you paid|paid to|sent to|you sent|debited|request(?:ed)?|collect|cashback|reward|scratch|refund|failed|pending|declined|reversed|offer|win|bill due)\b/i;
const APP_AMOUNT = [
  new RegExp(String.raw`paid you\s+${CUR}\s*${NUM}`, 'i'),                              // GPay "Rahul paid you ₹500.00"
  new RegExp(String.raw`(?:received|got)\s+(?:a\s+)?(?:payment\s+of\s+)?${CUR}\s*${NUM}`, 'i'), // "Received ₹500 from Rahul"
  new RegExp(String.raw`payment of\s+${CUR}\s*${NUM}\s+(?:is\s+|has been\s+)?received`, 'i'),   // Paytm
  new RegExp(String.raw`${CUR}\s*${NUM}\s+(?:has been\s+)?received`, 'i'),                // "₹500 received from Rahul"
];
// Push text is "title body", so the name is the run of Capitalised words right before "paid you".
const APP_PAYER = [/([A-Z][A-Za-z.]*(?:\s+[A-Z][A-Za-z.]*){0,4})\s+paid you\b/, /\bfrom\s+([A-Za-z][A-Za-z .]{0,40}?)(?=\s+(?:on|via|to|in|at)\b|[.,!]|$)/i];

/** UPI business-app push, e.g. "Received ₹500 from Rahul Kumar". */
export function parseAppCredit(text, sender = '') {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (APP_NOT_A_CREDIT.test(t)) return null;
  const amount = money(firstMatch(t, APP_AMOUNT));
  if (!amount) return null;
  const utr = firstMatch(t, UTR_PATTERNS);
  return { amount, utr: utr || null, payer: tidy(firstMatch(t, APP_PAYER)), kind: 'app', bank: null, app: upiAppOf(sender) };
}

/**
 * One entry point for everything the phone forwards.
 * @param {string} text    message body (SMS) or "title body" (push)
 * @param {string} sender  SMS sender id (e.g. "VM-HDFCBK") or app package (e.g. "com.phonepe.app.business")
 */
export function parseCredit(text, sender = '') {
  // Real bank SMS come from short headers ("VM-HDFCBK"). An SMS from a plain phone number is
  // someone typing a fake "credited" message, so it's never trusted. Empty sender = Gmail / dev.
  if (isPhoneNumber(sender)) return null;
  const bank = parseBankCredit(text, sender);
  if (bank) return bank;
  // App-style wording is only trusted from a UPI app's own notification, never from a random SMS.
  if (upiAppOf(sender) && /\./.test(sender)) return parseAppCredit(text, sender);
  return null;
}

// "+919876543210", "9876543210", "+91 98765 43210", "098765-43210" -> a person's phone, not a bank.
export function isPhoneNumber(sender = '') {
  return /^\+?\d{10,13}$/.test(String(sender || '').replace(/[\s\-()]/g, ''));
}

// Does this SMS sender / app look like a bank or UPI app? (The phone forwards only those.)
export function isPaymentSender(from = '') {
  return !!(bankOf(from) || upiAppOf(from) || /bank|bnk|upi/i.test(from));
}
