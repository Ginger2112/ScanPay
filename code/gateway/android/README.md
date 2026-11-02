# Scantopay Observer (Android)

Native Kotlin app that does two jobs:
1. **Payment detector (primary)** — reads incoming **bank SMS** (and bank-app push
   as fallback), parses Axis UPI credit alerts, and reports them to the Scantopay
   server, which confirms the matching order. This is the *main* detector:
   **Axis sends UPI account credits by SMS, not email**, so the Gmail observer
   can't see them — this app can.
2. **Mobile dashboard** — a WebView of the Scantopay CRM (`/dashboard`) plus a
   "Payment received" push whenever a credit is confirmed.

## Build & install (Android Studio)
> This project is source only — it isn't compiled here. Build it on your machine.

1. Open the `android/` folder in **Android Studio** (Giraffe or newer).
2. Let Gradle sync (it downloads the wrapper, SDK bits, dependencies).
3. On your phone: enable **Developer options → USB debugging**, plug in.
4. **Run ▶** to install, or **Build → Build APK** and sideload the APK.

## First run (on the phone)
1. Enter your **Server URL** — your PC's LAN address, e.g. `http://192.168.1.5:6100`
   (phone and PC on the same Wi-Fi). Enter the **observer token** (matches the
   server's `OBSERVER_TOKEN`, default `dev-observer-token`).
2. Tap **Connect** → grant **SMS** and **Notifications** permissions.
3. (Optional) Tap **Enable push access** → turn on Scantopay in the
   notification-access list (lets it read the Axis app's push as a fallback).
4. The CRM dashboard loads; a persistent "observer running" notification appears.

## How detection works
- `SmsReceiver` fires on every incoming SMS → `AxisParser` extracts amount + UTR →
  `CreditReporter` POSTs to `/api/observer/credit` (token header) → server matches
  the awaiting order, confirms it, and the app shows a "Payment received" push.
- `NotificationService` does the same from bank-app push notifications (fallback).
- The server **de-dups on UTR**, so SMS + push can't double-confirm.

## Notes
- `minSdk 26`, `targetSdk 34`, Kotlin. Adaptive launcher icon = the red spark.
- SMS-read permission is fine for a **sideloaded** app (Play Store restricts it).
- Keep the phone on Wi-Fi with the server reachable; battery optimisation off for
  this app helps the background service survive.
