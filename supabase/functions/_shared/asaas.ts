// Asaas REST client (server-side only — the API key is a secret).
// Docs: https://docs.asaas.com. Auth header: `access_token: <key>`.

const ENV = (Deno.env.get("ASAAS_ENV") ?? "sandbox").toLowerCase();
const BASE = ENV === "production" ? "https://api.asaas.com/v3" : "https://api-sandbox.asaas.com/v3";

function headers(): HeadersInit {
  const key = Deno.env.get("ASAAS_API_KEY");
  if (!key) throw new Error("ASAAS_API_KEY not set");
  return { access_token: key, "Content-Type": "application/json" };
}

async function asaas<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body?.errors?.[0]?.description as string) ?? `Asaas ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export interface AsaasCustomer { id: string; }
export function createCustomer(input: { name: string; email: string; cpfCnpj?: string; mobilePhone?: string }) {
  return asaas<AsaasCustomer>("/customers", { method: "POST", body: JSON.stringify(input) });
}

export interface AsaasSplit { walletId: string; fixedValue?: number; percentualValue?: number; }
export interface CreatePaymentInput {
  customer: string;
  billingType: "PIX" | "CREDIT_CARD" | "BOLETO";
  value: number;
  dueDate: string; // yyyy-mm-dd
  description?: string;
  externalReference?: string;
  installmentCount?: number;
  totalValue?: number;
  split?: AsaasSplit[];
}
export interface AsaasPayment { id: string; status: string; invoiceUrl?: string; }
export function createPayment(input: CreatePaymentInput) {
  return asaas<AsaasPayment>("/payments", { method: "POST", body: JSON.stringify(input) });
}

export interface AsaasPixQr { encodedImage: string; payload: string; expirationDate?: string; }
export function getPixQrCode(paymentId: string) {
  return asaas<AsaasPixQr>(`/payments/${paymentId}/pixQrCode`);
}

export const asaasEnv = ENV;
