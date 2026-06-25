/**
 * Billing engine — STANBASE.md §13.3 (períodos, parcelamento, comissão progressiva).
 *
 * Decisions baked in:
 *  - Base commission 7.99% on the (discounted) plan value, for Pix / à vista / parcelado (§13.2, Q48).
 *  - Installments only on quarterly/semiannual/annual, up to 12× (monthly never) (§13.3.2).
 *  - Customer pays the interest (pass-through), Price/French table at 3.49% a.m. (§13.3.3).
 *  - Stanbase keeps the financing spread vs. the PSP anticipation cost (~1.25% a.m.).
 *  - LTV = plan value (no financing interest); total_paid (with interest) and net_org separate (Q29).
 *
 * Money conservation (the model the breakdown UI relies on):
 *   chargedTotal = planValue + customerInterest
 *   planValue    = netOrg + baseCommission + pspFee
 *   customerInterest = financingSpread + pspAnticipationFee
 *
 * v0 simplification (REPLAN): the PSP anticipation cost is approximated by the Price
 * formula at the PSP rate. The real Asaas anticipation/MDR comes from the negotiated
 * contract (§13.2.3) and golden cent-parity tests in sandbox (Q38).
 */
import type { PaymentMethod, Period, PlatformBillingSettings } from "@/types/domain";

export const DEFAULT_BILLING: PlatformBillingSettings = {
  baseCommissionRate: 0.0799,
  installmentInterestRateAm: 0.0349,
  maxInstallments: 12,
  pspAnticipationRateAm: 0.0125,
};

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Periods that allow installments (§13.3.2). */
export function installmentsAllowed(period: Period): boolean {
  return period === "quarterly" || period === "semiannual" || period === "annual";
}

/**
 * Price (French amortization) monthly payment for principal P, monthly rate i, n installments.
 *   PMT = P · i / (1 − (1+i)^(−n))
 */
export function pricePayment(principal: number, rateAm: number, n: number): number {
  if (n <= 1 || rateAm <= 0) return principal / Math.max(1, n);
  const factor = rateAm / (1 - Math.pow(1 + rateAm, -n));
  return principal * factor;
}

/** Total the customer pays financing `principal` over `n` installments at `rateAm`. */
export function financedTotal(principal: number, rateAm: number, n: number): number {
  if (n <= 1) return principal;
  return round2(pricePayment(principal, rateAm, n)) * n;
}

export interface InstallmentOption {
  n: number;
  installmentValue: number; // per-month amount (rounded to cents)
  total: number; // total paid by customer
  surcharge: number; // total − principal
  surchargePct: number; // surcharge / principal
}

/** Build the 1×…max× table the checkout shows (juros transparentes — modelo Hotmart). */
export function installmentOptions(
  planValue: number,
  period: Period,
  settings: PlatformBillingSettings = DEFAULT_BILLING
): InstallmentOption[] {
  const max = installmentsAllowed(period) ? settings.maxInstallments : 1;
  const out: InstallmentOption[] = [];
  for (let n = 1; n <= max; n++) {
    const total = financedTotal(planValue, settings.installmentInterestRateAm, n);
    out.push({
      n,
      installmentValue: round2(total / n),
      total: round2(total),
      surcharge: round2(total - planValue),
      surchargePct: round2((total - planValue) / planValue),
    });
  }
  return out;
}

export interface TransactionBreakdown {
  planValue: number;
  customerInterest: number;
  chargedTotal: number;
  baseCommission: number;
  pspFee: number;
  pspAnticipationFee: number;
  financingSpread: number;
  netOrg: number;
  stanbaseTotal: number; // baseCommission + financingSpread
}

/** Per-transaction PSP processing fee on the plan value (simplified benchmark §13.2.1). */
function pspProcessingFee(method: PaymentMethod, planValue: number): number {
  switch (method) {
    case "pix":
      return 1.99; // Asaas Pix fixed (first 100/mo free — simplified)
    case "boleto":
      return 1.99;
    case "credit_card":
    default:
      return round2(planValue * 0.0349); // card MDR ~3.49%
  }
}

/**
 * Full economic breakdown of one transaction. Drives the Revenue module and the
 * checkout disclosure. `installments` of 1 = à vista (no financing).
 */
export function computeTransaction(
  planValue: number,
  method: PaymentMethod,
  installments: number,
  period: Period,
  settings: PlatformBillingSettings = DEFAULT_BILLING
): TransactionBreakdown {
  const n = installmentsAllowed(period) ? Math.min(installments, settings.maxInstallments) : 1;

  const chargedTotal = financedTotal(planValue, settings.installmentInterestRateAm, n);
  const customerInterest = round2(chargedTotal - planValue);

  const baseCommission = round2(planValue * settings.baseCommissionRate);
  const pspFee = pspProcessingFee(method, planValue);

  // Anticipation cost approximated by Price at the PSP rate (REPLAN: real Asaas formula).
  const pspAnticipationFee =
    n > 1 ? round2(financedTotal(planValue, settings.pspAnticipationRateAm, n) - planValue) : 0;

  const financingSpread = round2(customerInterest - pspAnticipationFee);
  const netOrg = round2(planValue - baseCommission - pspFee);
  const stanbaseTotal = round2(baseCommission + financingSpread);

  return {
    planValue: round2(planValue),
    customerInterest,
    chargedTotal: round2(chargedTotal),
    baseCommission,
    pspFee,
    pspAnticipationFee,
    financingSpread,
    netOrg,
    stanbaseTotal,
  };
}

/** Normalized monthly recurring revenue contribution of a plan value at a given period. */
export function monthlyEquivalent(planValue: number, period: Period): number {
  const months: Record<Period, number> = {
    monthly: 1,
    quarterly: 3,
    semiannual: 6,
    annual: 12,
    one_time: 1,
    lifetime: 1,
  };
  return round2(planValue / months[period]);
}

export const BRL = (n: number): string =>
  n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export const PCT = (n: number): string =>
  n.toLocaleString("pt-BR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 2 });
