// Server-authoritative billing math (mirror of app/src/lib/billing.ts, §13.3).
// The server recomputes from platform_billing_settings — never trusts client totals.

export interface BillingSettings {
  base_commission_rate: number;
  installment_interest_rate_am: number;
  max_installments: number;
  psp_anticipation_rate_am: number;
}

export type Method = "pix" | "credit_card" | "boleto";
export type Period = "monthly" | "quarterly" | "semiannual" | "annual" | "one_time" | "lifetime";

export const round2 = (n: number) => Math.round(n * 100) / 100;

export const installmentsAllowed = (p: Period) =>
  p === "quarterly" || p === "semiannual" || p === "annual";

export function pricePayment(principal: number, rateAm: number, n: number): number {
  if (n <= 1 || rateAm <= 0) return principal / Math.max(1, n);
  const factor = rateAm / (1 - Math.pow(1 + rateAm, -n));
  return principal * factor;
}

export function financedTotal(principal: number, rateAm: number, n: number): number {
  if (n <= 1) return principal;
  return round2(pricePayment(principal, rateAm, n)) * n;
}

function pspProcessingFee(method: Method, planValue: number): number {
  if (method === "pix" || method === "boleto") return 1.99;
  return round2(planValue * 0.0349); // card MDR ~3.49%
}

export interface Breakdown {
  plan_value: number;
  customer_interest: number;
  charged_total: number;
  base_commission: number;
  psp_fee: number;
  psp_anticipation_fee: number;
  financing_spread: number;
  net_org: number;
  installments: number;
}

export function computeTransaction(
  planValue: number,
  method: Method,
  installments: number,
  period: Period,
  s: BillingSettings,
): Breakdown {
  const n = installmentsAllowed(period) ? Math.min(installments, s.max_installments) : 1;
  const chargedTotal = financedTotal(planValue, s.installment_interest_rate_am, n);
  const customerInterest = round2(chargedTotal - planValue);
  const baseCommission = round2(planValue * s.base_commission_rate);
  const pspFee = pspProcessingFee(method, planValue);
  const pspAnticipationFee =
    n > 1 ? round2(financedTotal(planValue, s.psp_anticipation_rate_am, n) - planValue) : 0;
  return {
    plan_value: round2(planValue),
    customer_interest: customerInterest,
    charged_total: round2(chargedTotal),
    base_commission: baseCommission,
    psp_fee: pspFee,
    psp_anticipation_fee: pspAnticipationFee,
    financing_spread: round2(customerInterest - pspAnticipationFee),
    net_org: round2(planValue - baseCommission - pspFee),
    installments: n,
  };
}
