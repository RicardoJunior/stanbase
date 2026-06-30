// POST /asaas-webhook — receives Asaas payment events and updates the
// transaction/subscription/member status. Configure the URL + auth token in
// Asaas → Integrações → Webhooks (the token is checked against ASAAS_WEBHOOK_TOKEN).
import { ok, error } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { enqueueForMemberTier } from "../_shared/provision.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return error("method_not_allowed", "Use POST", 405);

  const expected = Deno.env.get("ASAAS_WEBHOOK_TOKEN");
  if (expected && req.headers.get("asaas-access-token") !== expected) {
    return error("unauthorized", "Token de webhook inválido", 401);
  }

  let body: any;
  try { body = await req.json(); } catch { return error("validation_failed", "JSON inválido", 400); }

  const event: string = body?.event ?? "";
  const payment = body?.payment;
  if (!payment?.id) return ok({ ignored: true });

  const db = serviceClient();
  const { data: tx } = await db.from("transactions").select("*").eq("psp_ref", payment.id).maybeSingle();
  if (!tx) return ok({ ignored: true, reason: "transação não encontrada" });

  const setTx = (status: string) => db.from("transactions").update({ status }).eq("id", tx.id);
  const setSub = (status: string) => tx.subscription_id && db.from("subscriptions").update({ status }).eq("id", tx.subscription_id);
  const setMember = (status: string) => tx.member_id && db.from("members").update({ status }).eq("id", tx.member_id);

  switch (event) {
    case "PAYMENT_CONFIRMED":
    case "PAYMENT_RECEIVED":
      await setTx("paid");
      await setSub("active");
      await setMember("active");
      if (tx.member_id) {
        // bump LTV/total_paid (authoritative recompute would re-aggregate all paid tx)
        const { data: m } = await db.from("member_metrics").select("*").eq("member_id", tx.member_id).maybeSingle();
        if (m) {
          await db.from("member_metrics").update({
            ltv: Number(m.ltv) + Number(tx.plan_value),
            total_paid: Number(m.total_paid) + Number(tx.charged_total),
            net_org: Number(m.net_org) + Number(tx.net_org),
            last_active_at: new Date().toISOString(),
          }).eq("member_id", tx.member_id);
        }
        // Payment confirmed → member is active: provision the tier's perks via the
        // integration adapters. Best-effort — never fail the webhook on provisioning.
        try {
          const { data: mem } = await db.from("members").select("tier_id").eq("id", tx.member_id).maybeSingle();
          if (mem?.tier_id) {
            await enqueueForMemberTier(db, { orgId: tx.org_id, memberId: tx.member_id, tierId: mem.tier_id, action: "grant" });
          }
        } catch (_) { /* ignore */ }
      }
      break;
    case "PAYMENT_OVERDUE":
      await setSub("past_due");
      await setMember("past_due");
      break;
    case "PAYMENT_REFUNDED":
    case "PAYMENT_CHARGEBACK_REQUESTED":
      await setTx("refunded");
      break;
    case "PAYMENT_DELETED":
      await setTx("failed");
      break;
  }

  await db.from("audit_logs").insert({ org_id: tx.org_id, actor: "asaas-webhook", action: event, target: payment.id });
  return ok({ received: true, event });
});
