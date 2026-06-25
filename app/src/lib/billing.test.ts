import { describe, it, expect } from "vitest";
import {
  computeTransaction,
  installmentOptions,
  installmentsAllowed,
  financedTotal,
  monthlyEquivalent,
  DEFAULT_BILLING,
} from "./billing";

describe("installment eligibility (§13.3.2)", () => {
  it("monthly never allows installments", () => {
    expect(installmentsAllowed("monthly")).toBe(false);
  });
  it("quarterly/semiannual/annual allow installments", () => {
    expect(installmentsAllowed("quarterly")).toBe(true);
    expect(installmentsAllowed("semiannual")).toBe(true);
    expect(installmentsAllowed("annual")).toBe(true);
  });
});

describe("Price table surcharges (§13.3.3 table)", () => {
  // Doc table: 2× ≈ 5.3%, 6× ≈ 12.6%, 12× ≈ 24.1%
  const opts = installmentOptions(1000, "annual");
  const pct = (n: number) => opts.find((o) => o.n === n)!.surchargePct;

  it("2× ≈ 5.3%", () => expect(pct(2)).toBeCloseTo(0.053, 2));
  it("6× ≈ 12.6%", () => expect(pct(6)).toBeCloseTo(0.126, 2));
  it("12× ≈ 24.1%", () => expect(pct(12)).toBeCloseTo(0.241, 2));
});

describe("golden example — annual R$600 in 12× (§13.3.3)", () => {
  const t = computeTransaction(600, "credit_card", 12, "annual");

  it("customer total ≈ R$744.7", () => {
    expect(t.chargedTotal).toBeCloseTo(744.7, 0); // within R$0.5
  });
  it("monthly installment ≈ R$62", () => {
    const opt = installmentOptions(600, "annual").find((o) => o.n === 12)!;
    expect(opt.installmentValue).toBeCloseTo(62.06, 1);
  });
  it("base commission = 7.99% of R$600 = R$47.94", () => {
    expect(t.baseCommission).toBe(47.94);
  });
  it("customer interest ≈ R$144.7", () => {
    expect(t.customerInterest).toBeCloseTo(144.7, 0);
  });
  it("conserves money: chargedTotal = planValue + customerInterest", () => {
    expect(t.chargedTotal).toBeCloseTo(t.planValue + t.customerInterest, 2);
  });
  it("conserves: customerInterest = financingSpread + pspAnticipationFee", () => {
    expect(t.customerInterest).toBeCloseTo(t.financingSpread + t.pspAnticipationFee, 2);
  });
  it("conserves: planValue = netOrg + baseCommission + pspFee", () => {
    expect(t.planValue).toBeCloseTo(t.netOrg + t.baseCommission + t.pspFee, 2);
  });
  it("financing spread is positive (premium margin)", () => {
    expect(t.financingSpread).toBeGreaterThan(0);
  });
});

describe("à vista (no financing)", () => {
  it("pix monthly R$19 has zero interest/spread", () => {
    const t = computeTransaction(19, "pix", 1, "monthly");
    expect(t.customerInterest).toBe(0);
    expect(t.financingSpread).toBe(0);
    expect(t.pspAnticipationFee).toBe(0);
    expect(t.chargedTotal).toBe(19);
    expect(t.baseCommission).toBe(1.52); // 7.99% × 19
  });
  it("monthly period forces 1× even if 12 requested", () => {
    const t = computeTransaction(19, "credit_card", 12, "monthly");
    expect(t.customerInterest).toBe(0);
  });
});

describe("MRR normalization", () => {
  it("annual R$600 → R$50/mo", () => expect(monthlyEquivalent(600, "annual")).toBe(50));
  it("quarterly R$60 → R$20/mo", () => expect(monthlyEquivalent(60, "quarterly")).toBe(20));
});

describe("settings", () => {
  it("defaults match platform_billing_settings seed", () => {
    expect(DEFAULT_BILLING.baseCommissionRate).toBe(0.0799);
    expect(DEFAULT_BILLING.installmentInterestRateAm).toBe(0.0349);
    expect(DEFAULT_BILLING.maxInstallments).toBe(12);
  });
  it("financedTotal of 1× equals principal", () => {
    expect(financedTotal(123.45, 0.0349, 1)).toBe(123.45);
  });
});
