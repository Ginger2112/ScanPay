import { PAISE_PER_RUPEE } from "./money";

// UPI account providers a merchant might already collect into.
//
// Important framing: we do NOT integrate with any of these. None of them
// exposes a public API to link an account, so a merchant "connecting" an
// account means telling us which VPA to address and which app the payment
// confirmation will appear in. That second part is what matters — verification
// has to know whether it is parsing a PhonePe Business notification, a Paytm
// one, or a plain bank credit alert.
//
// Limits below are DEFAULTS ONLY. Real receiving limits vary by provider,
// merchant category, KYC tier, and NPCI circular, and they change. Every
// account stores its own dailyLimitPaise, which the merchant must set to what
// their bank or PSP actually permits.

export type AccountType = "merchant" | "personal";

export interface UpiProvider {
  id: string;
  label: string;
  accountType: AccountType;
  /** Conservative starting point for a new account, in paise. */
  defaultDailyLimitPaise: number;
  /** Where a payment confirmation shows up. Used by verification later. */
  notificationSource: string;
  /** Typical VPA handles. Informational only — never validated against, since
   *  PSPs add handles regularly and a hard check would reject valid accounts. */
  handleHints: string[];
  /** Shown in the UI when this provider is selected. */
  warning?: string;
}

const RUPEES = PAISE_PER_RUPEE;

/** Conservative default for a business account. Merchants should raise or
 *  lower it to match their actual sanctioned limit. */
const DEFAULT_MERCHANT_LIMIT = 200_000 * RUPEES;

/** The NPCI person-to-person ceiling. A personal VPA is treated as P2P, which
 *  is precisely why it is a poor choice for collecting business payments. */
const P2P_DAILY_CEILING = 100_000 * RUPEES;

export const UPI_PROVIDERS: Record<string, UpiProvider> = {
  phonepe_business: {
    id: "phonepe_business",
    label: "PhonePe Business",
    accountType: "merchant",
    defaultDailyLimitPaise: DEFAULT_MERCHANT_LIMIT,
    notificationSource: "PhonePe Business app",
    handleHints: ["@ybl", "@ibl", "@axl"],
  },
  paytm_business: {
    id: "paytm_business",
    label: "Paytm for Business",
    accountType: "merchant",
    defaultDailyLimitPaise: DEFAULT_MERCHANT_LIMIT,
    notificationSource: "Paytm for Business app",
    handleHints: ["@paytm", "@ptys", "@pthdfc"],
  },
  gpay_business: {
    id: "gpay_business",
    label: "Google Pay for Business",
    accountType: "merchant",
    defaultDailyLimitPaise: DEFAULT_MERCHANT_LIMIT,
    notificationSource: "Google Pay for Business app",
    handleHints: ["@okhdfcbank", "@okaxis", "@okicici", "@oksbi"],
  },
  bharatpe: {
    id: "bharatpe",
    label: "BharatPe",
    accountType: "merchant",
    defaultDailyLimitPaise: DEFAULT_MERCHANT_LIMIT,
    notificationSource: "BharatPe app",
    handleHints: ["@yesbankltd", "@yesbank"],
  },
  hdfc_smarthub: {
    id: "hdfc_smarthub",
    label: "HDFC SmartHub Vyapar",
    accountType: "merchant",
    defaultDailyLimitPaise: DEFAULT_MERCHANT_LIMIT,
    notificationSource: "SmartHub Vyapar app",
    handleHints: ["@hdfcbank", "@payzapp"],
  },
  kotak_upibiz: {
    id: "kotak_upibiz",
    label: "Kotak UPIBiz",
    accountType: "merchant",
    defaultDailyLimitPaise: DEFAULT_MERCHANT_LIMIT,
    notificationSource: "Kotak UPIBiz app",
    handleHints: ["@kotak", "@kmbl"],
  },
  bank_current: {
    id: "bank_current",
    label: "Bank current account VPA",
    accountType: "merchant",
    defaultDailyLimitPaise: DEFAULT_MERCHANT_LIMIT,
    notificationSource: "Bank SMS or email credit alert",
    handleHints: [],
  },
  personal: {
    id: "personal",
    label: "Personal UPI ID",
    accountType: "personal",
    defaultDailyLimitPaise: P2P_DAILY_CEILING,
    notificationSource: "Bank SMS or email credit alert",
    handleHints: [],
    warning:
      "A personal UPI ID is treated as person-to-person: it caps at ₹1 lakh " +
      "per day, and banks routinely flag or freeze savings accounts used for " +
      "business inflow. Use a business UPI account for anything beyond testing.",
  },
};

export const PROVIDER_IDS = Object.keys(UPI_PROVIDERS);

export function getProvider(id: string): UpiProvider {
  const provider = UPI_PROVIDERS[id];
  if (!provider) {
    throw new Error(
      `Unknown UPI provider "${id}". Expected one of: ${PROVIDER_IDS.join(", ")}`,
    );
  }
  return provider;
}

export function isKnownProvider(id: string): boolean {
  return id in UPI_PROVIDERS;
}

/** Providers a merchant should be choosing from, business ones first. */
export function listProviders(): UpiProvider[] {
  return PROVIDER_IDS.map((id) => UPI_PROVIDERS[id]).sort((a, b) => {
    if (a.accountType !== b.accountType) {
      return a.accountType === "merchant" ? -1 : 1;
    }
    return a.label.localeCompare(b.label);
  });
}

/**
 * A non-blocking advisory when a VPA's handle doesn't look like the chosen
 * provider's. Merchants mistype these constantly, and a wrong VPA fails
 * silently at the customer's UPI app — but handles change often enough that
 * this must never be a hard rejection.
 */
export function handleMismatchHint(
  providerId: string,
  vpa: string,
): string | null {
  const provider = getProvider(providerId);
  if (provider.handleHints.length === 0) return null;

  const handle = vpa.slice(vpa.indexOf("@")).toLowerCase();
  if (provider.handleHints.some((hint) => handle === hint.toLowerCase())) {
    return null;
  }
  return (
    `"${vpa}" doesn't use a handle we usually see with ${provider.label} ` +
    `(${provider.handleHints.join(", ")}). Double-check it, then send a ₹1 ` +
    `test payment before going live.`
  );
}
