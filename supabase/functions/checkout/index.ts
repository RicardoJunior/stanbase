// POST /checkout — creates an Asaas charge (customer + payment + installments +
// split to the org's subconta) and persists member/subscription/transaction.
// The transaction stays `pending` until the Asaas webhook confirms payment.
import { handlePreflight } from "../_shared/cors.ts";
import { ok, error } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { computeTransaction, type Method, type Period, type BillingSettings } from "../_shared/billing.ts";
import { createCustomer, createPayment, getPixQrCode } from "../_shared/asaas.ts";

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
function memberId(): string {
  const r = (set: string) => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
  let s = "";
  for (let i = 0; i < 8; i++) s += i % 2 === 0 ? r(LETTERS) : r(DIGITS);
  return s;
}
const billingType = (m: Method): "PIX" | "CREDIT_CARD" | "BOLETO" =>
  m === "pix" ? "PIX" : m === "boleto" ? "BOLETO" : "CREDIT_CARD";
const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return error("method_not_allowed", "Use POST", 405);

  let body: any;
  try { body = await req.json(); } catch { return error("validation_failed", "JSON inválido", 400); }
  const { orgId, tierId, method = "pix", installments = 1, customer } = body ?? {};
  if (!orgId || !tierId) return error("validation_failed", "orgId e tierId são obrigatórios", 422);
  if (!customer?.name || !customer?.email) return error("validation_failed", "customer.name e customer.email são obrigatórios", 422);

  const db = serviceClient();

  const { data: tier } = await db.from("tiers").select("*").eq("id", tierId).eq("org_id", orgId).single();
  if (!tier) return error("not_found", "Tier não encontrado", 404);
  const { data: settings } = await db.from("platform_billing_settings").select("*").eq("id", 1).single();
  const { data: conn } = await db.from("connections").select("*").eq("org_id", orgId).eq("provider", "asaas").maybeSingle();

  const b = computeTransaction(Number(tier.price), method as Method, Number(installments), tier.period as Period, settings as BillingSettings);

  // ── find-or-create member ──────────────────────────────────
  let memberRow: any = null;
  const { data: existingProfile } = await db.from("member_profiles").select("member_id").eq("org_id", orgId).eq("email", customer.email).maybeSingle();
  if (existingProfile) {
    const { data } = await db.from("members").update({ tier_id: tierId, status: "active" }).eq("id", existingProfile.member_id).select().single();
    memberRow = data;
  } else {
    const code = memberId();
    const { data } = await db.from("members").insert({ member_id: code, org_id: orgId, tier_id: tierId, status: tier.price > 0 ? "active" : "active", source: "checkout" }).select().single();
    memberRow = data;
    await db.from("member_profiles").insert({ member_id: memberRow.id, org_id: orgId, name: customer.name, email: customer.email, phone: customer.phone ?? null });
    await db.from("member_metrics").insert({ member_id: memberRow.id, org_id: orgId });
  }

  // free tier → no charge
  if (Number(tier.price) <= 0) {
    await db.from("audit_logs").insert({ org_id: orgId, actor: "checkout", action: "member.joined_free", target: memberRow.id });
    return ok({ member: memberRow, free: true });
  }

  // ── subscription + pending transaction ─────────────────────
  const periodDays: Record<string, number> = { monthly: 30, quarterly: 91, semiannual: 182, annual: 365 };
  const { data: sub } = await db.from("subscriptions").insert({
    org_id: orgId, member_id: memberRow.id, tier_id: tierId, period: tier.period, status: "pending",
    installments: b.installments, auto_renew: !(tier.installments_enabled && b.installments > 1), method,
    current_period_end: new Date(Date.now() + (periodDays[tier.period] ?? 30) * 86400000).toISOString(),
  }).select().single();

  // ── Asaas charge ───────────────────────────────────────────
  let payment: { id: string; status: string; invoiceUrl?: string } | null = null;
  let pix: { encodedImage: string; payload: string } | null = null;
  try {
    if (!Deno.env.get("ASAAS_API_KEY")) throw new Error("Asaas não configurado (ASAAS_API_KEY ausente)");
    const cust = await createCustomer({ name: customer.name, email: customer.email, cpfCnpj: customer.cpfCnpj, mobilePhone: customer.phone });
    const walletId = (conn?.credentials as any)?.wallet_id as string | undefined;
    payment = await createPayment({
      customer: cust.id,
      billingType: billingType(method as Method),
      value: b.charged_total,
      dueDate: tomorrow(),
      description: `Assinatura ${tier.name}`,
      externalReference: sub!.id,
      ...(method === "credit_card" && b.installments > 1 ? { installmentCount: b.installments, totalValue: b.charged_total } : {}),
      split: walletId ? [{ walletId, fixedValue: b.net_org }] : [],
    });
    if (method === "pix" && payment) pix = await getPixQrCode(payment.id);
  } catch (e) {
    // Asaas not configured / failed: record the pending transaction so the flow is auditable.
    await db.from("transactions").insert({
      org_id: orgId, member_id: memberRow.id, subscription_id: sub!.id, description: `Assinatura ${tier.name}`,
      method, installments: b.installments, plan_value: b.plan_value, customer_interest: b.customer_interest,
      charged_total: b.charged_total, base_commission: b.base_commission, psp_fee: b.psp_fee,
      psp_anticipation_fee: b.psp_anticipation_fee, financing_spread: b.financing_spread, net_org: b.net_org, status: "pending",
    });
    return error("psp_unavailable", String((e as Error).message), 502, { member: memberRow, breakdown: b });
  }

  await db.from("transactions").insert({
    org_id: orgId, member_id: memberRow.id, subscription_id: sub!.id, description: `Assinatura ${tier.name}`,
    method, installments: b.installments, plan_value: b.plan_value, customer_interest: b.customer_interest,
    charged_total: b.charged_total, base_commission: b.base_commission, psp_fee: b.psp_fee,
    psp_anticipation_fee: b.psp_anticipation_fee, financing_spread: b.financing_spread, net_org: b.net_org,
    status: "pending", psp_ref: payment.id,
  });
  await db.from("subscriptions").update({ psp_ref: payment.id }).eq("id", sub!.id);
  await db.from("audit_logs").insert({ org_id: orgId, actor: "checkout", action: "payment.created", target: payment.id });

  return ok({
    member: memberRow,
    paymentId: payment.id,
    status: payment.status,
    invoiceUrl: payment.invoiceUrl,
    pix,
    breakdown: b,
  });
});
