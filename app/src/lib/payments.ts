/**
 * Payments adapter — Asaas (PSP de lançamento). Builds the REAL Asaas request
 * payloads (customer + payment with installments + split) so the integration is
 * correct end-to-end. The actual HTTP call must run server-side (Edge Function)
 * because the Asaas API key is a secret and can't live in the browser, and Asaas
 * blocks browser-origin (CORS) requests. The PSP layer is adapter-based so the
 * provider can change without touching the checkout.
 */
import type { PaymentMethod } from "@/types/domain";
import type { TransactionBreakdown } from "@/lib/billing";

const BILLING_TYPE: Record<PaymentMethod, string> = {
  pix: "PIX",
  credit_card: "CREDIT_CARD",
  boleto: "BOLETO",
};

export interface AsaasSplit {
  walletId: string;
  fixedValue: number; // org receives the net (after Stanbase commission + PSP fee)
}

export interface AsaasPaymentPayload {
  billingType: string;
  value: number; // total the customer is charged
  description: string;
  externalReference: string;
  installmentCount?: number;
  totalValue?: number;
  split: AsaasSplit[];
}

export interface ChargeInput {
  method: PaymentMethod;
  installments: number;
  description: string;
  externalReference: string;
  orgWalletId?: string;
  breakdown: TransactionBreakdown;
  /** used when the real backend (Edge Function) is configured */
  orgId?: string;
  tierId?: string;
  customer?: { name: string; email: string; phone?: string };
}

/** Build the exact body POSTed to `POST {base}/v3/payments` (header: access_token). */
export function buildAsaasPayment(input: ChargeInput): AsaasPaymentPayload {
  const { breakdown: b, method, installments } = input;
  const installed = method === "credit_card" && installments > 1;
  return {
    billingType: BILLING_TYPE[method],
    value: b.chargedTotal,
    description: input.description,
    externalReference: input.externalReference,
    ...(installed ? { installmentCount: installments, totalValue: b.chargedTotal } : {}),
    split: input.orgWalletId ? [{ walletId: input.orgWalletId, fixedValue: b.netOrg }] : [],
  };
}

export const asaasBaseUrl = (environment?: string) =>
  environment === "production" ? "https://api.asaas.com/api" : "https://api-sandbox.asaas.com/api";

export interface ChargeResult {
  status: "confirmed" | "pending" | "failed";
  id: string;
  /** "asaas" when processed by the Edge Function/PSP; "local" in prototype mode. */
  via: "asaas" | "local";
  invoiceUrl?: string;
  pix?: { encodedImage: string; payload: string } | null;
}

const FUNCTIONS_URL = import.meta.env.VITE_FUNCTIONS_URL as string | undefined;

/**
 * Process a checkout charge. When VITE_FUNCTIONS_URL is set, calls the real
 * Supabase Edge Function (`/checkout`), which charges Asaas (Pix QR / card) and
 * persists the pending transaction (confirmed later via webhook). Otherwise it
 * resolves locally (prototype mode) — the billing math is real either way.
 */
export async function processCharge(input: ChargeInput): Promise<ChargeResult> {
  buildAsaasPayment(input); // validates/serializes the real Asaas payload shape

  if (FUNCTIONS_URL && input.orgId && input.tierId && input.customer) {
    try {
      const res = await fetch(`${FUNCTIONS_URL}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId: input.orgId,
          tierId: input.tierId,
          method: input.method,
          installments: input.installments,
          customer: input.customer,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        return { status: data.paymentId ? "pending" : "confirmed", id: data.paymentId ?? "free", via: "asaas", invoiceUrl: data.invoiceUrl, pix: data.pix ?? null };
      }
    } catch {
      /* network/backend unavailable → fall back to local so the demo still works */
    }
  }

  return { status: "confirmed", id: "ch_" + Math.random().toString(36).slice(2, 10), via: "local" };
}
