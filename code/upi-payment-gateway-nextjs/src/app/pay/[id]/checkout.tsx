"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface CheckoutData {
  id: string;
  status: string;
  reference: string;
  payeeName: string;
  vpa: string;
  baseAmountPaise: number;
  chargeAmountPaise: number;
  deltaPaise: number;
  displayAmount: string;
  upiUri: string;
  expiresAt: string;
}

interface Props {
  checkout: CheckoutData;
  qrDataUrl: string;
  appLinks: Record<"gpay" | "phonepe" | "paytm", string>;
}

const POLL_INTERVAL_MS = 4000;
const TERMINAL = new Set(["paid", "expired", "cancelled"]);

export function Checkout({ checkout, qrDataUrl, appLinks }: Props) {
  const [status, setStatus] = useState(checkout.status);
  const [utr, setUtr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Poll until the payment reaches a terminal state. The merchant confirms out
  // of band (or a matched credit alert does it), so the page has no way to
  // know locally that money arrived — asking the server is the only signal.
  useEffect(() => {
    if (TERMINAL.has(status)) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/public/intents/${checkout.id}/status`, {
          cache: "no-store",
        });
        if (res.ok && !cancelled) {
          const data = (await res.json()) as { status: string };
          setStatus(data.status);
          if (TERMINAL.has(data.status)) return;
        }
      } catch {
        // Offline or a blip — keep polling rather than stranding the customer.
      }
      if (!cancelled) pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
    };

    pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [checkout.id, status]);

  const copyVpa = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(checkout.vpa);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy — please select and copy the UPI ID manually.");
    }
  }, [checkout.vpa]);

  const submitUtr = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);
      setSubmitting(true);
      try {
        const res = await fetch(`/api/v1/payment-intents/${checkout.id}/claim`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ utr: utr.trim() }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data?.error?.message ?? "Couldn't submit that reference.");
          return;
        }
        setStatus(data.status);
        setUtr("");
      } catch {
        setError("Network problem — please try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [checkout.id, utr],
  );

  if (status === "paid") {
    return (
      <Shell>
        <div className="status paid">
          <span aria-hidden="true">✓</span>
          Payment confirmed
        </div>
        <p className="note">
          Your payment of {checkout.displayAmount} to {checkout.payeeName} is
          confirmed. You can close this page.
        </p>
      </Shell>
    );
  }

  if (status === "expired" || status === "cancelled") {
    return (
      <Shell>
        <div className="status dead">
          <span aria-hidden="true">✕</span>
          This payment link has {status === "expired" ? "expired" : "been cancelled"}
        </div>
        <p className="note">
          {status === "expired"
            ? "Payment links are valid for a limited time. Please go back to the store and start again."
            : "The seller cancelled this order. Please contact them if this is unexpected."}
          {" "}
          If money already left your account, contact the seller with your UPI
          reference — it has not been lost.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="payee">Paying {checkout.payeeName}</p>
      <p className="amount">{checkout.displayAmount}</p>

      {checkout.deltaPaise > 0 && (
        <p className="note">
          Please pay this exact amount. The extra {checkout.deltaPaise} paise
          lets us match your payment to your order automatically.
        </p>
      )}

      <hr className="divider" />

      {/* Mobile: the shopper is holding the phone, so hand off to their UPI
          app. They cannot scan their own screen. */}
      <div className="mobile-only">
        <p className="label">Pay using</p>
        <div className="apps">
          <a className="app-btn primary" href={checkout.upiUri}>
            Open any UPI app
          </a>
          <a className="app-btn" href={appLinks.gpay}>
            Google Pay
          </a>
          <a className="app-btn" href={appLinks.phonepe}>
            PhonePe
          </a>
          <a className="app-btn" href={appLinks.paytm}>
            Paytm
          </a>
        </div>
      </div>

      {/* Desktop: shopper scans with a separate phone. */}
      <div className="desktop-only">
        <p className="label">Scan to pay</p>
        <div className="qr-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="qr"
            src={qrDataUrl}
            alt={`UPI QR code to pay ${checkout.displayAmount} to ${checkout.payeeName}`}
            width={220}
            height={220}
          />
        </div>
      </div>

      <hr className="divider" />

      <p className="label">Or pay to this UPI ID</p>
      <div className="vpa-row">
        <code>{checkout.vpa}</code>
        <button type="button" className="link-btn" onClick={copyVpa}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <hr className="divider" />

      <div className="status pending">
        <span className="spinner" aria-hidden="true" />
        {status === "awaiting_confirmation"
          ? "Reference received — waiting for the seller to confirm"
          : "Waiting for your payment"}
      </div>

      {status === "pending" && (
        <form onSubmit={submitUtr} style={{ marginTop: 16 }}>
          <p className="label">Already paid? Enter your UPI reference</p>
          <input
            className="field"
            inputMode="numeric"
            autoComplete="off"
            placeholder="12-digit UTR"
            value={utr}
            onChange={(e) => setUtr(e.target.value.replace(/\D/g, "").slice(0, 12))}
            aria-label="12-digit UPI transaction reference"
          />
          <button
            type="submit"
            className="btn primary"
            style={{ marginTop: 10 }}
            disabled={utr.length !== 12 || submitting}
          >
            {submitting ? "Submitting…" : "Submit reference"}
          </button>
          {error && <p className="error">{error}</p>}
          <p className="note">
            Find it in your UPI app under transaction details. The seller checks
            this against their bank before confirming.
          </p>
        </form>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="page">
      <div className="card">
        {children}
        <p className="footer">
          Money goes directly to the seller&apos;s bank account over UPI.
        </p>
      </div>
    </main>
  );
}
