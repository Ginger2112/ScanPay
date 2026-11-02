// Multi-bank + UPI-app parser. Run: node test/parse-bank.test.mjs
// AU and IDBI cases are REAL messages. Every other bank / app case is built from public
// sample formats and is marked unverified until a real client message is added here.
import assert from 'node:assert';
import { parseCredit, parseBankCredit, isPaymentSender } from '../lib/parse-bank.js';
import { parseAxisCredit } from '../lib/parse-axis.js';

const pick = (r) => (r ? { amount: r.amount, utr: r.utr, payer: r.payer } : null);
const cases = [
  // --- real (verified) ---
  { name: 'AU credit (real)', sender: 'JK-AUBANK', text: 'Credited INR 4,700.00 to A/c X7486 on 05-MAY-2025 Ref UPI/CR/512559647968/APARNA',
    expect: { amount: 4700, utr: '512559647968', payer: 'APARNA' }, bank: 'AU' },
  { name: 'IDBI credit (real)', sender: 'IDBIBK-S', text: 'Dear Customer, Acct XX888 is credited with Rs 15000.00 on 20-Oct-26 from APARNA ROBIN SA. UPI:629309792612 Avl Bal Rs 33606.27-IDBI Bank',
    expect: { amount: 15000, utr: '629309792612', payer: 'APARNA ROBIN SA' }, bank: 'IDBI' },
  { name: 'IDBI debit mentioning "credited" (real)', sender: 'IDBIBK-S', text: 'IDBI Bank Acct XX888 debited for Rs 130.00 on 21-Oct-26; Bal Rs 32441.23 SUMEET DATTATRA credited. UPI:629456118651-IDBI Bank', expect: null },

  // --- unverified sample formats ---
  { name: 'SBI credit', sender: 'VM-SBIUPI', text: 'Dear UPI user A/C X1234 credited by Rs500 on 31Oct26 by RAHUL KUMAR (Ref no 430512345678) -SBI',
    expect: { amount: 500, utr: '430512345678', payer: null }, bank: 'SBI' },
  { name: 'SBI credit with balance after', sender: 'AD-SBIINB', text: 'Dear SBI UPI User, ur A/cX1234 credited by Rs1240.50 on 31Oct26 by (Ref no 430512345679). Avl Bal Rs 88210.00 -SBI',
    expect: { amount: 1240.5, utr: '430512345679', payer: null }, bank: 'SBI' },
  { name: 'HDFC Money Received', sender: 'VM-HDFCBK', text: 'Money Received - INR 500.00 in your HDFC Bank A/c xx1234 on 31-10-26 by A/c linked to VPA rahul@okicici (UPI Ref No 430512345680).',
    expect: { amount: 500, utr: '430512345680', payer: 'rahul@okicici' }, bank: 'HDFC' },
  { name: 'HDFC credited to', sender: 'AD-HDFCBK', text: 'Rs.1,239.63 credited to HDFC Bank A/c XX1234 on 31-10-26 from VPA priya@ybl (UPI 430512345681)',
    expect: { amount: 1239.63, utr: '430512345681', payer: 'priya@ybl' }, bank: 'HDFC' },
  { name: 'HDFC Sent (debit) rejected', sender: 'VM-HDFCBK', text: 'Sent Rs.500.00 From HDFC Bank A/C x1234 To RAHUL On 31/10/26 Ref 430512345682 Not You? Call 18002586161', expect: null },
  { name: 'ICICI credit', sender: 'VK-ICICIB', text: 'Dear Customer, Acct XX123 is credited with Rs 750.00 on 31-Oct-26 from MEERA NAIR. UPI:430512345683-ICICI Bank.',
    expect: { amount: 750, utr: '430512345683', payer: 'MEERA NAIR' }, bank: 'ICICI' },
  { name: 'ICICI debit rejected', sender: 'VK-ICICIB', text: 'ICICI Bank Acct XX123 debited for Rs 120.00 on 31-Oct-26; CHAI POINT credited. UPI:430512345684. Call 18002662 for dispute.', expect: null },
  { name: 'Kotak received', sender: 'BZ-KOTAKB', text: 'Received Rs.899.00 in your Kotak Bank a/c X1234 from dev@paytm on 31-10-26.UPI Ref:430512345685.',
    expect: { amount: 899, utr: '430512345685', payer: 'dev@paytm' }, bank: 'Kotak' },
  { name: 'Kotak sent rejected', sender: 'BZ-KOTAKB', text: 'Sent Rs.250.00 from Kotak Bank AC X1234 to shop@ybl on 31-10-26.UPI Ref 430512345686. Not you, https://kotak.com/fraud', expect: null },
  { name: 'Axis credit', sender: 'AX-AXISBK', text: 'INR 650.00 credited to A/c no. XX1234 on 31-10-26 at 10:20:11 IST. Info- UPI/P2A/430512345687/AISHA KHAN/HDFC BANK - Axis Bank',
    expect: { amount: 650, utr: '430512345687', payer: 'AISHA KHAN' }, bank: 'Axis' },
  { name: 'BoB credit', sender: 'BP-BOBTXN', text: 'Rs.320.00 Credited to A/c ...1234 thru UPI/430512345688 by ravi@ybl. Total Bal:Rs.5320.00CR. Avlbl Amt:Rs.5320.00(31-10-2026 10:20:11) - Bank of Baroda',
    expect: { amount: 320, utr: '430512345688', payer: 'ravi@ybl' }, bank: 'BoB' },
  { name: 'PNB credit', sender: 'VM-PNBSMS', text: 'Your A/c XX1234 is credited for Rs 1499.00 on 31-10-2026 10:20:11 through UPI. Avl Bal Rs 20000.00 (UPI Ref ID 430512345689) -PNB',
    expect: { amount: 1499, utr: '430512345689', payer: null }, bank: 'PNB' },
  { name: 'Canara credit', sender: 'VM-CANBNK', text: 'An amount of INR 210.00 has been CREDITED to your account XXX123 on 31/10/2026 towards UPI. UPI Ref no 430512345690. Total Avail.bal INR 9,999.00 - Canara Bank',
    expect: { amount: 210, utr: '430512345690', payer: null }, bank: 'Canara' },
  { name: 'NEFT credit (not UPI) rejected', sender: 'VM-HDFCBK', text: 'Rs.5000.00 credited to HDFC Bank A/c XX1234 on 31-10-26 by NEFT from ACME PVT LTD', expect: null },
  { name: 'Collect request rejected', sender: 'VM-HDFCBK', text: 'shop@ybl has requested money from you on UPI. On approving, Rs 500.00 will be debited from your A/c', expect: null },
  { name: 'OTP SMS rejected', sender: 'VM-HDFCBK', text: 'OTP for UPI transaction of Rs 500.00 is 123456. Do not share it with anyone.', expect: null },

  // --- UPI business-app push notifications (unverified) ---
  { name: 'PhonePe Business received', sender: 'com.phonepe.app.business', text: '₹500 received Received ₹500 from Rahul Kumar',
    expect: { amount: 500, utr: null, payer: 'Rahul Kumar' } },
  { name: 'GPay Business paid you', sender: 'com.google.android.apps.nbu.paisa.merchant', text: 'Payment received Meera Nair paid you ₹1,239.63',
    expect: { amount: 1239.63, utr: null, payer: 'Meera Nair' } },
  { name: 'Paytm Business received', sender: 'com.paytm.business', text: 'Payment of ₹750 received from Dev Patel via UPI',
    expect: { amount: 750, utr: null, payer: 'Dev Patel' } },
  { name: 'PhonePe personal "you paid" rejected', sender: 'com.phonepe.app', text: 'You paid ₹200 to Chai Point', expect: null },
  { name: 'Cashback push rejected', sender: 'com.phonepe.app', text: 'You received ₹25 cashback on your payment', expect: null },
  { name: 'App wording in a random SMS is NOT trusted', sender: 'VM-PROMO', text: 'Received ₹5000 from Lucky Draw! Claim now', expect: null },

  // --- fake "bank" SMS typed by a person: a phone-number sender is never trusted ---
  { name: 'Fake HDFC SMS from +91 number rejected', sender: '+919876543210', text: 'Rs.500.00 credited to HDFC Bank A/c XX1234 on 31-10-26 from VPA dev@ybl (UPI 430512345691)', expect: null },
  { name: 'Fake AU SMS from 10-digit number rejected', sender: '9876543210', text: 'Credited INR 899.00 to A/c X7486 on 31-OCT-2026 Ref UPI/CR/430512345692/ARUN', expect: null },
  { name: 'Fake SMS from spaced number rejected', sender: '+91 98765 43210', text: 'Dear Customer, Acct XX123 is credited with Rs 750.00 on 31-Oct-26 from MEERA NAIR. UPI:430512345693-ICICI Bank.', expect: null },
  { name: 'Same text from a bank header still accepted', sender: 'AX-SBIUPI', text: 'Rs.500.00 credited to HDFC Bank A/c XX1234 on 31-10-26 from VPA dev@ybl (UPI 430512345691)',
    expect: { amount: 500, utr: '430512345691', payer: 'dev@ybl' } },
  { name: 'Empty sender (Gmail / dev) still accepted', sender: '', text: 'Credited INR 899.00 to A/c X7486 on 31-OCT-2026 Ref UPI/CR/430512345692/ARUN',
    expect: { amount: 899, utr: '430512345692', payer: 'ARUN' } },
];

let pass = 0;
for (const c of cases) {
  const r = parseCredit(c.text, c.sender);
  assert.deepStrictEqual(pick(r), c.expect, `FAILED: ${c.name} -> ${JSON.stringify(r)}`);
  if (c.bank) assert.strictEqual(r.bank, c.bank, `FAILED bank: ${c.name} -> ${r.bank}`);
  console.log(`  ok  ${c.name}`);
  pass++;
}

// The old AU/IDBI parser and the new one agree on every real message.
for (const c of cases.filter((x) => /\(real\)/.test(x.name))) {
  assert.deepStrictEqual(pick(parseBankCredit(c.text, c.sender)), parseAxisCredit(c.text));
}
assert.ok(isPaymentSender('VM-HDFCBK') && isPaymentSender('com.phonepe.app.business') && !isPaymentSender('VM-AMAZON'));
console.log(`\n${pass}/${cases.length} multi-bank + UPI-app parser cases passed`);
