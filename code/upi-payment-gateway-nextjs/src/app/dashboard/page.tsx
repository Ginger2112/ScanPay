import { accountUsage } from "@/lib/accounts";
import { prisma } from "@/lib/db";
import { expireStaleIntents } from "@/lib/intents";
import { formatInr } from "@/lib/money";
import { getProvider, listProviders } from "@/lib/providers";

import {
  addUpiAccount,
  confirmPayment,
  createTestPayment,
  rejectPayment,
  toggleUpiAccount,
} from "./actions";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for payment",
  awaiting_confirmation: "Needs your review",
  paid: "Paid",
  expired: "Expired",
  cancelled: "Cancelled",
};

export default async function Dashboard() {
  // This portal has NO authentication. It is a development tool. Before this
  // ships, it needs merchant login — otherwise anyone who reaches the URL can
  // mark orders paid.
  if (process.env.NODE_ENV === "production" && !process.env.ALLOW_OPEN_DASHBOARD) {
    return (
      <main className="page">
        <div className="card">
          <h1 className="h1">Dashboard disabled</h1>
          <p className="note">
            This dashboard has no authentication and is blocked in production.
            Add merchant login before enabling it.
          </p>
        </div>
      </main>
    );
  }

  await expireStaleIntents();

  const merchant = await prisma.merchant.findFirst({
    orderBy: { createdAt: "asc" },
  });

  if (!merchant) {
    return (
      <main className="page">
        <div className="card">
          <h1 className="h1">No merchant yet</h1>
          <p className="note">
            Run <code>npm run db:seed</code> in the project folder, then reload
            this page.
          </p>
        </div>
      </main>
    );
  }

  const [intents, usage, allAccounts] = await Promise.all([
    prisma.paymentIntent.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: {
        upiAccount: true,
        verificationEvents: {
          where: { kind: "utr_claim", accepted: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    }),
    accountUsage(merchant.id),
    prisma.upiAccount.findMany({
      where: { merchantId: merchant.id },
      orderBy: [{ active: "desc" }, { priority: "asc" }],
    }),
  ]);

  const needsReview = intents.filter((i) => i.status === "awaiting_confirmation");
  const paidCount = intents.filter((i) => i.status === "paid").length;

  return (
    <main className="page dashboard">
      <div className="wide">
        <header className="dash-head">
          <div>
            <h1 className="h1">{merchant.name}</h1>
            <p className="note">
              Collecting into {allAccounts.filter((a) => a.active).length} UPI
              account{allAccounts.filter((a) => a.active).length === 1 ? "" : "s"}{" "}
              · money goes straight to them, never through us
            </p>
          </div>
        </header>

        <div className="stats">
          <div className="stat">
            <span className="stat-num">{needsReview.length}</span>
            <span className="stat-label">Need review</span>
          </div>
          <div className="stat">
            <span className="stat-num">{paidCount}</span>
            <span className="stat-label">Paid</span>
          </div>
          <div className="stat">
            <span className="stat-num">{intents.length}</span>
            <span className="stat-label">Recent</span>
          </div>
        </div>

        <section className="panel">
          <h2 className="h2">UPI accounts</h2>
          <p className="note" style={{ marginTop: -6, marginBottom: 12 }}>
            Payments are routed to whichever account has headroom. Each account
            is its own pool of charge amounts, so adding one raises how many
            concurrent orders can share a price.
          </p>

          {usage.length === 0 ? (
            <p className="note">No active accounts. Add one below.</p>
          ) : (
            <div className="rows" style={{ marginBottom: 14 }}>
              {usage.map(({ account, committedPaise, remainingPaise }) => {
                const provider = getProvider(account.provider);
                const pct = Math.min(
                  100,
                  Math.round((committedPaise / account.dailyLimitPaise) * 100),
                );
                return (
                  <div key={account.id} className="row">
                    <div className="row-main">
                      <div className="row-top">
                        <span className="row-amount mono-sm">{account.vpa}</span>
                        <span className="pill">{provider.label}</span>
                        {account.accountType === "personal" && (
                          <span className="pill expired">Personal</span>
                        )}
                      </div>
                      <div className="row-sub">
                        {account.label ? `${account.label} · ` : ""}
                        {formatInr(remainingPaise)} of{" "}
                        {formatInr(account.dailyLimitPaise)} left today
                      </div>
                      <div className="meter" aria-hidden="true">
                        <div
                          className={`meter-fill ${pct > 85 ? "hot" : ""}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {allAccounts.filter((a) => !a.active).length > 0 && (
            <p className="note" style={{ marginBottom: 12 }}>
              {allAccounts.filter((a) => !a.active).length} inactive account(s)
              hidden from routing.
            </p>
          )}

          <details>
            <summary className="link-btn" style={{ marginBottom: 10 }}>
              Add a UPI account
            </summary>
            <form action={addUpiAccount} className="inline-form">
              <input type="hidden" name="merchantId" value={merchant.id} />
              <select className="field flex" name="provider" defaultValue="phonepe_business">
                {listProviders().map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.accountType === "personal" ? " (not recommended)" : ""}
                  </option>
                ))}
              </select>
              <input className="field flex" name="vpa" placeholder="yourstore@ybl" required />
              <input className="field flex" name="payeeName" placeholder="Payee name" required />
              <input className="field flex" name="label" placeholder="Label (optional)" />
              <input
                className="field flex"
                name="dailyLimit"
                placeholder="Daily limit in ₹ (optional)"
                inputMode="decimal"
              />
              <button type="submit" className="btn primary auto">
                Add
              </button>
            </form>
            <p className="note">
              We don&apos;t connect to the provider — no UPI app offers a public
              API for that. You&apos;re telling us which VPA to address and
              which app your confirmation will appear in. Send a ₹1 test payment
              before going live; a mistyped VPA fails silently.
            </p>
          </details>
        </section>

        <section className="panel">
          <h2 className="h2">Create a test payment</h2>
          <form action={createTestPayment} className="inline-form">
            <input type="hidden" name="merchantId" value={merchant.id} />
            <input
              className="field flex"
              name="amount"
              placeholder="Amount in ₹ (e.g. 499)"
              inputMode="decimal"
              required
            />
            <input
              className="field flex"
              name="description"
              placeholder="Description (optional)"
            />
            <button type="submit" className="btn primary auto">
              Create
            </button>
          </form>
        </section>

        <section className="panel">
          <h2 className="h2">Payments</h2>

          {intents.length === 0 ? (
            <p className="note">
              No payments yet. Create one above to see the flow.
            </p>
          ) : (
            <div className="rows">
              {intents.map((intent) => {
                const utr = intent.verificationEvents[0]?.utr;
                const review = intent.status === "awaiting_confirmation";
                return (
                  <div key={intent.id} className={`row ${review ? "review" : ""}`}>
                    <div className="row-main">
                      <div className="row-top">
                        <span className="row-amount">
                          {formatInr(intent.chargeAmountPaise)}
                        </span>
                        <span className={`pill ${intent.status}`}>
                          {STATUS_LABEL[intent.status] ?? intent.status}
                        </span>
                      </div>
                      <div className="row-sub">
                        {intent.reference}
                        {intent.description ? ` · ${intent.description}` : ""}
                        {" · "}
                        <span title={getProvider(intent.upiAccount.provider).label}>
                          {intent.upiAccount.vpa}
                        </span>
                        {intent.chargeAmountPaise !== intent.baseAmountPaise && (
                          <>
                            {" · "}
                            <span title="Unique paise offset so this payment can be matched automatically">
                              {formatInr(intent.baseAmountPaise)} +{" "}
                              {intent.chargeAmountPaise - intent.baseAmountPaise}p
                            </span>
                          </>
                        )}
                      </div>
                      {utr && (
                        <div className="row-sub mono">
                          Customer says UTR {utr}
                        </div>
                      )}
                    </div>

                    <div className="row-actions">
                      {review ? (
                        <>
                          <form action={confirmPayment}>
                            <input type="hidden" name="id" value={intent.id} />
                            <button type="submit" className="btn primary small">
                              Confirm
                            </button>
                          </form>
                          <form action={rejectPayment}>
                            <input type="hidden" name="id" value={intent.id} />
                            <button type="submit" className="btn small">
                              Not received
                            </button>
                          </form>
                        </>
                      ) : (
                        (intent.status === "pending" ||
                          intent.status === "awaiting_confirmation") && (
                          <a
                            className="btn small"
                            href={`/pay/${intent.id}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open checkout
                          </a>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {needsReview.length > 0 && (
          <p className="warn-note">
            Before confirming, check the exact amount actually arrived in your
            bank. A UTR is typed in by the customer and cannot be verified
            against the banking network.
          </p>
        )}

        <p className="footer">
          Development dashboard — no login. Add merchant authentication before
          deploying.
        </p>
      </div>
    </main>
  );
}
