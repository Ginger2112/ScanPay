# ScanPay multi-merchant + Tably auto-confirm: changes log

*31 Oct 2026 · built and tested locally only. Nothing deployed, pushed or committed.*

## What it does now

- **Any business can use ScanPay.** Each business is its own merchant with its own UPI ID, API key, signed webhook and paired Android phone. Money always lands in the business's own UPI ID.
- **About 1 click to join.**
  - Any client: an invite link (`/start?invite=…`), then business name + UPI ID, then a pairing QR.
  - Tably restaurants: Owner → Business details → **Connect ScanPay**. The UPI ID is already filled in.
- **Phone pairing.** Scan the QR with the phone's normal camera. The page opens the ScanPay app (or downloads it), and the phone links itself. The QR works once, for 10 minutes.
- **Auto-confirm.** The phone forwards the bank SMS (or a UPI business-app alert). ScanPay matches it to the right payment of the right business, then sends a signed "paid" message. Tably marks the bill **Paid ✓ (auto)**.
- **Fallback.** Manual UTR, cash and card on the Tably counter work exactly as before. iPhone-only businesses use **Mark paid** on the ScanPay merchant app.
- **Arun's original setup** (ChargeOS wallet, Jazz94/Careatic store, Shopify, the existing phone) is merchant `default` and works unchanged.

## Real vs still demo

| Piece | State |
|---|---|
| Multi-merchant, API keys, signed webhooks, strict separation | Real, tested |
| Invite signup, partner connect (Tably), pairing QR | Real, tested locally |
| Android app v0.4 (1-tap pairing, UPI app alerts, heartbeat, retry queue, unlink) | Built, **not yet tested on a real phone** |
| SMS formats AU + IDBI | Real messages, verified |
| SMS formats SBI, HDFC, ICICI, Kotak, Axis, BoB, PNB, Canara, PhonePe/Paytm/GPay Business | **Unverified** (public sample formats). Add each client's first real SMS to `test/parse-bank.test.mjs` |
| iPhone app (ScanPay merchant app on the home screen) | Built. Needs ScanPay deployed to install on a phone |
| Live server | **Not deployed.** Needs `PARTNER_KEYS` and `PUBLIC_URL` on ScanPay, and `SCANOYE_URL` + `SCANOYE_PARTNER_KEY` on Tably |

## Files changed

### ScanPay (`scan-oye/code/gateway`)
Backup taken before any change: `scan-oye/backups/gateway-before-multimerchant-2026-10-31.tgz`.

- **New:**
  - `lib/merchants.js`: merchants, partner keys, pairing, invites, phone status.
  - `lib/parse-bank.js`: multi-bank and UPI-app parser.
  - Pages: `public/start.html`, `merchant.html`, `pair.html`, `phone.html`, `merchants-admin.html`.
  - Shared page code: `public/scanoye.js`, `scanoye.css`.
  - Installable app: `public/manifest.webmanifest`, `sw.js`, `icons/`.
  - Tests: `test/parse-bank.test.mjs`, `test/multi-merchant.test.mjs`.
- **Changed:**
  - `lib/db.js`: merchants, observers, pairings and invites tables; `merchant_id` and `amount_locked` columns.
  - `lib/orders.js`: everything scoped per merchant, plus cancel, the amount-locked rule and SMS/push duplicate handling.
  - `lib/webhook.js`: each merchant's own URL and secret, plus retries.
  - `lib/qr.js`: payee name per merchant.
  - `server.js`: v1 API, partner/signup/pairing/observer routes, new pages, per-merchant alerts.
  - `config.js`: partner keys, public URL, safer defaults.
  - `package.json`: `npm test` runs all 4 suites.
- **Android (`android/`):** 1-tap pairing deep link, UPI business-app alerts, heartbeat, then the QA fixes below. Builds as v0.4. `build-apk.ps1` now sets a short temp folder, which fixes the JDK "Unable to establish loopback connection" error.

### Tably (`tably/app`, branch `web-launch`)
- **New:**
  - `lib/scanoye.js`: client; the key and secret are stored encrypted.
  - `lib/paid.js`: one shared "mark bill paid" for the counter and for auto.
  - `routes/scanoye.js`: connect, pairing, switch-off, the diner's exact amount, the signed webhook.
  - `scripts/scanoye-test.js`: runs the real ScanPay and Tably together.
- **Changed:**
  - `server.js`: route + raw-body webhook.
  - `routes/counter.js`: pay/confirm uses `markPaid`; tells ScanPay about manual payments; end-of-day lists UPI events.
  - `routes/owner.js`: a UPI change switches ScanPay over at once.
  - `routes/diner.js`: claim after auto-pay.
  - `lib/restaurant.js`: `upiReceived` on the bill.
  - `lib/schema.sql`, `lib/config.js`, `.env.example`.
  - `public/owner.js`: Connect card.
  - `public/diner.js`: exact amount, receipt by itself.
  - `public/counter.js`: Paid ✓ (auto), alerts.
  - `package.json`.

### Skills
`os-studio/.claude/skills/scan-oye`, `.claude/skills/tably` and `tably/.claude/skills/tably` were updated for the 31 Oct decision. `os-studio/CLAUDE.md` still says "Keep ScanPay out of Tably" and needs the same update.

## Bugs found and fixed

QA ran in rounds. In each round, testers played one role each and every finding was checked against the code.

### Found while building
1. **Same bill at two tables.** A round amount (e.g. ₹365.00) was held as "ambiguous". Payments from Tably's UPI links are now "amount-locked", so an exact match wins. Arun's own store keeps the strict rule.
2. **Diner stuck on the pay sheet.** When the bill turned paid by itself, the diner stayed on the pay sheet. The receipt now opens by itself.
3. **Last party's phone.** It could open a pay amount (and set the tip) on the next party's bill. Now refused.
4. **Android build failed.** The JDK loopback error is fixed in `build-apk.ps1`.

### QA round 1: Tably
5. **Old UPI ID after a change (critical).** Diners who reopened the sheet were still sent to the old UPI ID. A UPI change now cancels open amounts and switches ScanPay at once, and a payment is reused only if its UPI ID still matches.
6. **Switch off didn't switch off.** The phone kept sending SMS, and the merchant and its UPI ID stayed locked. Switch off now cancels open amounts, deactivates the merchant and unlinks its phones. If ScanPay can't be reached, the owner is warned.
7. **Changed server secret.** Auto-confirm broke silently. The owner now sees a clear message and a **Reconnect** button.
8. **"Connect another phone".** The QR vanished after 4 seconds with a false "connected" message. It now waits for a *new* phone, and an expired QR says so.
9. **Lost "paid" webhook.** The bill stayed unpaid and the diner could pay twice. ScanPay now retries for about 20 minutes, and Tably settles it when the diner reopens the sheet.
10. **Bill changed after paying.** Money was ignored, or the counter was told to "collect the rest" when the diner had overpaid. Now:
    - Part payments are kept and the next QR asks only for the rest.
    - An overpaid bill is marked paid and the counter is told how much to give back.
    - The counter shows "₹X already received by UPI".
11. **Tip saved too early.** Opening the UPI sheet saved the tip on the bill even if the diner then paid cash. The tip is now saved only when the bill is paid.
12. **False "stray money" alert.** A manual "Mark paid (UPI)" at the counter made the later bank SMS look like stray money. The counter now tells ScanPay the payment is paid, so the SMS links to it. Cash and card cancel the open amount.
13. **Claim vs webhook race.** "I've paid" racing the webhook could push a paid bill back to "paying" (double counting), or show "No open bill". Fixed.
14. **Double tap.** Two taps on Pay could create two live payments for one bill. Requests are now handled one at a time per bill.
15. **Stale amount.** The UPI sheet kept an old amount after another order landed. It now refreshes by itself.
16. **End-of-day gaps.** The day-end report now lists UPI part payments, overpayments, held payments and unmatched money.
17. **Unclear alerts.** Counter and owner alerts were vague ("bill is ₹0", "partner key required"). They are now plain and specific.

### QA round 1: ScanPay server
18. **Fake SMS (critical).** An SMS from a personal phone number copying bank wording could confirm a payment. SMS from plain phone numbers are now ignored. Real bank SMS come from headers like "VM-HDFCBK".
19. **Cancel (critical).** A cancelled payment freed its amount at once, so its late SMS could confirm a different order. The amount now stays held for 30 minutes, and the late SMS raises an "unmatched" alert instead.
20. **Mark paid by hand.** An order marked paid by hand freed its amount, so its real SMS later confirmed the next order. The SMS now links to the hand-paid order.
21. **Base-price rule.** It could confirm an amount-locked order that couldn't have sent that round amount. Fixed.
22. **SMS/push duplicates.** Duplicate handling could swallow a genuine second payment of the same amount. It now gives way when an open order has that exact amount.
23. **Public store order API.** Anyone could create orders inside another merchant. It now always uses Arun's default merchant.
24. **Webhook links (SSRF).** Webhook links could point at internal addresses. Private, local and cloud-metadata addresses are refused on the live server, and redirects aren't followed.
25. **Unsafe defaults.** A known partner key and phone token were on by default. Both are off on the live server unless set.
26. **Logs.** Full bank SMS text was written to the server log. Only the amount and UTR are logged now.
27. **Phones couldn't be unlinked.** A lost phone could not be removed. Added "Unlink all phones", a merchant switch-off, and admin "New key" for a lost API key.
28. **Phone health.** The merchant page now warns if SMS permission is off on the phone.
29. **UTR reuse.** Mark paid accepted a UTR already used on another payment, and one bank credit could pay two bills. Both blocked.
30. **Broken checkout link.** The `checkout_url` returned by the API opened "Order not found". Fixed.
31. **Webhook retries.** Webhooks retry at about 10 s, 1 min, 5 min and 15 min.
32. **Guessing.** Pairing and invite codes can no longer be brute-forced (20 tries per 10 min per address), and used codes don't reveal the business name.
33. **Merchant app:**
    - It no longer signs out on a network blip.
    - The auto-refresh no longer closes an open picker.
    - Cancel on the UTR prompt really cancels.
    - Attaching money and changing the UPI ID ask for confirmation.
    - The test payment is ₹2, so it can be repeated.
34. **Pairing page on iPhone.** It no longer shows Android-only buttons.
35. **Revenue totals.** They now count what actually arrived, not the list price.

### QA round 1: Android app (v0.3)
36. **Pairing confirmation.** Pairing now asks "Connect this phone to ScanPay at <server>?". Only https servers (or your own Wi-Fi for testing) are accepted, so a bad link can't redirect the phone's SMS elsewhere.
37. **Rotation.** Turning the phone during or after pairing no longer burns the QR or shows "QR used".
38. **Message filter.** The phone now forwards every message the server can read (SBI "has a credit", "You got ₹", amounts on the next line).
39. **Notification access.** The app now asks for it after pairing, so PhonePe, Paytm and GPay Business alerts work.
40. **Health report.** The phone tells ScanPay whether SMS and notification access are on.
41. **No lost messages.** If the network or server is down, messages wait in a queue on the phone and are re-sent.
42. **Reboot.** The app starts again after a reboot.
43. **Unlinked phones.** An unlinked phone stops, shows "This phone was unlinked", and no longer sends anything.
44. **Pre-filled token removed.** The old test token is no longer filled in. More bank and UPI apps (Federal, IDFC, RBL, Jupiter, Fi, Amazon Pay, MobiKwik and others) are now read.

### QA round 2 (re-test after the fixes)
45. **Re-sent "paid" message (Tably).** It could count a part payment twice, mark a half-paid bill PAID and ask staff to refund money that never came. Each ScanPay payment now counts once per bill.
46. **Leftover QR (Tably).** After a bill was settled by another payment, an old QR stayed payable and extra money vanished silently. Leftover QRs are now cancelled, and a second payment on a paid bill raises an "overpaid, give back" alert.
47. **Unreachable ScanPay (Tably).** If ScanPay couldn't be reached during a cancel, the QR stayed payable while Tably thought it was gone. Tably now keeps it and cancels it again next time.
48. **Bill lowered after a part payment (Tably).** Now it's marked paid by itself, with no new QR.
49. **Day-end and counter after a part payment (Tably).**
    - Day-end splits a bill paid partly by UPI and partly in cash into both columns, and the tamper code covers it.
    - The counter asks for the exact remaining amount.
50. **"I've paid" after auto-pay (Tably).** Tapping it when the bill is already paid now opens the receipt directly.
51. **XSS in the admin dashboard (ScanPay, HIGH).** Anyone could put code in a customer or item name through the public store order and it would run in the admin dashboard; the checkout page had the same hole. Every value is now escaped, and a test fails if one isn't. **The live dashboard still has this hole until the next deploy.**
52. **Phone gave up waiting (ScanPay).** It timed out while the server waited for the merchant's webhook. The phone now gets its answer at once, and the webhook goes out in the background.
53. **Faked IP (ScanPay).** A faked IP header could get round the new limits and the admin login lockout. Forwarded IPs are trusted only from the local proxy, with `TRUST_PROXY=1`.
54. **One payment, two credits (ScanPay).** A push followed by its SMS was stored as two unmatched credits, so one payment could pay two bills. Now one credit.
55. **Smaller credit (ScanPay).** Attaching a smaller credit to a bigger payment now asks for confirmation.
56. **Android v0.4.**
    - Stricter server check: "10.evil.com" is refused.
    - Pairing survives screen changes and dark-mode switches.
    - An old token's 401 can't wipe a new pairing.
    - Reopening from Recents doesn't replay a used QR.

Known limit, not fixed: webhook-link checks look at the hostname, not the IP it resolves to (DNS rebinding). Closing that needs DNS pinning.

## Tests (final, all passing)
- ScanPay `npm test`: AU/IDBI parser 13, multi-bank parser 30, auto-confirm 22, multi-merchant 59, security 4. **Total 128.**
- Tably `npm test`: smoke test 147 + ScanPay-in-Tably end to end 47 (runs both real servers). **Total 194.**
- Browser check (local preview, phone size):
  - Owner connects in 1 click, and the phone pairs within 4 s.
  - The diner pays ₹207.50 (bill + tip) and the receipt opens by itself: "Confirmed by ScanPay (auto)".
  - A merchant signs up from an invite link.
  - Merchant app: ₹2 test payment, then Mark paid with UTR.
- Android: v0.4 builds (5.6 MB). **Not yet tested on a real phone.**

## Deploy checklist (needs Arun's OK, not done)
0. Live `public/dashboard.html` and `public/app.css` already carry the iPhone home-screen polish from the ChargeOS session (deployed 31 Oct 04:14, backup `/opt/scantopay/public.bak-20261031-041458`). The same edits are in the local copies, so deploying local `public/` keeps them. Diff against live first anyway. QA left 6 unpaid ₹50 ChargeOS test top-ups and possibly one ₹1 "QA iPhone test" order on live ScanPay (no money moved).
1. ScanPay on the droplet:
   - Upload the code (excluding `data.db`).
   - Set `PARTNER_KEYS=tably:<long random secret>`, `PUBLIC_URL=https://pay.arunsamanta.com`, `DEMO_MODE=off`, `TRUST_PROXY=1`, and keep the existing `OBSERVER_TOKEN`.
   - If the site is not behind Cloudflare, add `header_up -Cf-Connecting-Ip` to Caddy's `reverse_proxy` block.
   - Then `npm ci` and `systemctl restart scantopay`.
2. Tably on the droplet: set `SCANOYE_URL=https://pay.arunsamanta.com` and `SCANOYE_PARTNER_KEY=<same secret>`, then `sh deploy/deploy.sh app`.
3. Real test: pair a real Android phone, send ₹1, and add that bank's real SMS to the parser tests.
4. iPhone: open `https://pay.arunsamanta.com/merchant` in Safari, then Share → Add to Home Screen.

## Deploy log
**Stage A: ScanPay deployed to pay.arunsamanta.com (31 Oct 2026, ~05:05 IST, with Arun's OK)**
- Backup:
  - `/opt/scantopay.bak-20261030-233434`: code, `data.db`, `.env`.
  - `/etc/caddy/Caddyfile.bak-20261031-scanoye`.
- Code: everything except `data.db`, `.env`, `node_modules`, `android/`; then `npm ci`. The live `dashboard.html` keeps the ChargeOS iPhone edits plus the XSS escaping.
- `.env` added `PARTNER_KEYS` (secret made on the server; root-only copy in `/root/scanoye-tably-partner-key` for Tably), `PUBLIC_URL`, `TRUST_PROXY=1`. `DEMO_MODE=off` and `OBSERVER_TOKEN` are unchanged.
- Caddy: `header_up -Cf-Connecting-Ip` on pay.arunsamanta.com, validated and reloaded.
- Checked live:
  - All pages and the APK v0.4 are served; the dashboard escapes server values (XSS closed).
  - The partner API refuses no key or the old dev key, and accepts the real one. Dev routes are locked, and the old test phone token is refused.
  - Arun's real phone token still works; all 9 existing orders are intact as merchant `default`.
- Rollback: `systemctl stop scantopay`, copy the backup folder back over `/opt/scantopay`, restore the Caddyfile backup, then `systemctl reload caddy && systemctl start scantopay`.

**Stage B (Tably):** the code is already live (deployed by the Tably session). Still to do: add `SCANOYE_URL=https://pay.arunsamanta.com` and `SCANOYE_PARTNER_KEY=<from /root/scanoye-tably-partner-key>` to `/opt/tably/.env`, then restart tably.
