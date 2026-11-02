// Parser assertions against Arun's REAL AU Bank SMS. Run: node test/parse-axis.test.mjs
import assert from 'node:assert';
import { parseAxisCredit, isAxisSender } from '../lib/parse-axis.js';

const cases = [
  { name: 'AU credit 4,700',
    text: 'Credited INR 4,700.00 to A/c X7486 on 05-MAY-2025 Ref UPI/CR/512559647968/APARNA',
    expect: { amount: 4700, utr: '512559647968', payer: 'APARNA' } },
  { name: 'AU credit 50,000',
    text: 'Credited INR 50,000.00 to A/c X7486 on 29-APR-2025 Ref UPI/CR/511901646453/RAVINDER',
    expect: { amount: 50000, utr: '511901646453', payer: 'RAVINDER' } },
  { name: 'AU credit 772',
    text: 'Credited INR 772.00 to A/c X7486 on 06-MAY-2025 Ref UPI/CR/512690654145/RACHANA',
    expect: { amount: 772, utr: '512690654145', payer: 'RACHANA' } },
  { name: 'AU credit with unique paise',
    text: 'Credited INR 899.37 to A/c X7486 on 23-OCT-2026 Ref UPI/CR/629518153311/APARNA ROBIN',
    expect: { amount: 899.37, utr: '629518153311', payer: 'APARNA ROBIN' } },
  // --- IDBI (Careatic account), real messages ---
  { name: 'IDBI UPI credit',
    text: 'Dear Customer, Acct XX888 is credited with Rs 15000.00 on 20-Oct-26 from APARNA ROBIN SA. UPI:629309792612 Avl Bal Rs 33606.27-IDBI Bank',
    expect: { amount: 15000, utr: '629309792612', payer: 'APARNA ROBIN SA' } },
  { name: 'IDBI UPI credit with unique paise',
    text: 'Dear Customer, Acct XX888 is credited with Rs 899.37 on 23-Oct-26 from RAHUL VERMA. UPI:629999000111 Avl Bal Rs 34500.60-IDBI Bank',
    expect: { amount: 899.37, utr: '629999000111', payer: 'RAHUL VERMA' } },
  { name: 'IDBI DEBIT that mentions "credited" -> rejected',
    text: 'IDBI Bank Acct XX888 debited for Rs 130.00 on 21-Oct-26; Bal Rs 32441.23 SUMEET DATTATRA credited. UPI:629456118651-IDBI Bank',
    expect: null },
  { name: 'IDBI debit to a shop -> rejected',
    text: 'IDBI Bank Acct XX888 debited for Rs 1050.00 on 21-Oct-26; Bal Rs 32571.23 U A COLLECTION credited. UPI:666006381892-IDBI Bank',
    expect: null },
  { name: 'IDBI net-banking credit (not UPI) -> rejected',
    text: 'IDBI Bank A/c NN24888 credited for INR 883.95 through Net Banking. Bal INR 34091.23 (incl. of chq in clg) as of 21 OCT 10:33 hrs.',
    expect: null },
  { name: 'IDBI UPI mandate autopay debit -> rejected',
    text: 'Your account has been successfully debited with Rs 398.99 on 20-Oct-26 towards Adobe Systems S for UPI Mandate AutoPay, RRN 104286844016-IDBI Bank',
    expect: null },
  { name: 'AU debit rejected',
    text: 'Debited INR 40.00 from A/c X7486 on 05-MAY-2025',
    expect: null },
  { name: 'AU debit alert rejected',
    text: 'Alert! Your AU Bank A/c No. X7486 has been Debited with INR 2.95 on 06-MAY-2025 for Imps',
    expect: null },
  { name: 'AU UPI failed rejected',
    text: 'UPI payment for Rs 594.00 to EVERSUB INDIA PRIVATE LIMITED has failed. UPI reference : 54',
    expect: null },
];

let pass = 0;
for (const c of cases) {
  const got = parseAxisCredit(c.text);
  assert.deepStrictEqual(got, c.expect, `FAILED: ${c.name} -> ${JSON.stringify(got)}`);
  console.log(`  ok  ${c.name} -> ${JSON.stringify(got)}`);
  pass++;
}
assert.strictEqual(isAxisSender('JK-AUBANK'), true);
assert.strictEqual(isAxisSender('AX-AUBANK'), true);
assert.strictEqual(isAxisSender('IDBIBK-S'), true);
assert.strictEqual(isAxisSender('VM-HDFCBK'), false);
console.log(`\n${pass}/${cases.length} AU + IDBI parser cases passed + sender check ok`);
