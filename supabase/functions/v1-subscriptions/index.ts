// v1-subscriptions — public API for subscription lifecycle (§21), API-key auth.
//   GET  /v1-subscriptions                       → list the org's subscriptions
//   GET  /v1-subscriptions/{id}                  → one subscription (org-scoped)
//   POST /v1-subscriptions/{id}/cancel           → status canceled + passes inactive + member canceled
//   POST /v1-subscriptions/{id}/change-tier      → simple proration: swap tier, keep the cycle
//
// Service role bypasses RLS → every query filters org_id explicitly.
// Does NOT recreate a charge (that is the checkout's job).
import { handlePreflight } from "../_shared/cors.ts";
import { ok, error } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { resolveAuth } from "../_shared/auth.ts";
import { AppError } from "../_shared/response.ts";
import {
  computeTransaction,
  type Method,
  type Period,
  type BillingSettings,
} from "../_shared/billing.ts";

/** Path relative to the function name, e.g. "/{id}/cancel". */
function relativePath(req: Request): string {
  const { pathname } = new URL(req.url);
  return pathname.replace(/^\/v1-subscriptions/, "").replace(/\/+$/, "") || "/";
}

Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  const db = serviceClient();

  // ── auth (org from x-api-key) ────────────────────────────────
  let orgId: string;
  try {
    ({ orgId } = await resolveAuth(req, db));
  } catch (e) {
    if (e instanceof AppError) return error(e.code, e.message, e.status, e.details);
    return error("unauthorized", "Falha na autenticação", 401);
  }

  const path = relativePath(req);
  const method = req.method;

  // ── GET /  → list ────────────────────────────────────────────
  if (method === "GET" && path === "/") {
    const { data, error: dbErr } = await db
      .from("subscriptions")
      .select(
        "id, member_id, tier_id, period, status, current_period_end, installments, auto_renew, method, created_at",
      )
      .eq("org_id", orgId)
      .order("created_at", { ascending: false });
    if (dbErr) return error("internal_error", "Falha ao listar assinaturas", 500);
    return ok({ data: data ?? [] });
  }

  // Routes below operate on a single subscription: /{id}, /{id}/cancel, /{id}/change-tier
  const match = path.match(/^\/([0-9a-fA-F-]{36})(\/(cancel|change-tier))?$/);
  if (!match) return error("not_found", `Rota ${method} ${path} não encontrada`, 404);
  const subId = match[1];
  const action = match[3]; // undefined | "cancel" | "change-tier"

  // Load + authorize the subscription (org-scoped).
  const { data: sub } = await db
    .from("subscriptions")
    .select("*")
    .eq("id", subId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!sub) return error("not_found", "Assinatura não encontrada", 404);

  // ── GET /{id} ────────────────────────────────────────────────
  if (method === "GET" && !action) {
    return ok({
      data: {
        id: sub.id,
        member_id: sub.member_id,
        tier_id: sub.tier_id,
        period: sub.period,
        status: sub.status,
        current_period_end: sub.current_period_end,
        installments: sub.installments,
        auto_renew: sub.auto_renew,
        method: sub.method,
        created_at: sub.created_at,
      },
    });
  }

  // ── POST /{id}/cancel ────────────────────────────────────────
  if (method === "POST" && action === "cancel") {
    if (sub.status === "canceled") {
      return error("conflict", "Assinatura já está cancelada", 409);
    }

    const { data: updatedSub, error: subErr } = await db
      .from("subscriptions")
      .update({ status: "canceled", auto_renew: false })
      .eq("id", subId)
      .eq("org_id", orgId)
      .select("id, member_id, tier_id, status, current_period_end")
      .single();
    if (subErr || !updatedSub) return error("internal_error", "Falha ao cancelar assinatura", 500);

    // Passes inactive (org-scoped, this member's passes).
    await db
      .from("passes")
      .update({ status: "inactive" })
      .eq("org_id", orgId)
      .eq("member_id", sub.member_id);

    // Member canceled.
    await db
      .from("members")
      .update({ status: "canceled" })
      .eq("id", sub.member_id)
      .eq("org_id", orgId);

    await db.from("audit_logs").insert({
      org_id: orgId,
      actor: "api",
      action: "subscription.canceled",
      target: subId,
    });

    return ok({ data: updatedSub });
  }

  // ── POST /{id}/change-tier ───────────────────────────────────
  if (method === "POST" && action === "change-tier") {
    if (sub.status === "canceled") {
      return error("conflict", "Assinatura cancelada não pode trocar de tier", 409);
    }

    let body: { tierId?: string } = {};
    try {
      body = await req.json();
    } catch {
      return error("validation_failed", "JSON inválido", 400);
    }
    const tierId = body?.tierId;
    if (!tierId) return error("validation_failed", "tierId é obrigatório", 422);
    if (tierId === sub.tier_id) {
      return error("validation_failed", "Assinatura já está neste tier", 422);
    }

    // New tier must belong to the same org.
    const { data: tier } = await db
      .from("tiers")
      .select("id, name, price, period")
      .eq("id", tierId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!tier) return error("not_found", "Tier não encontrado", 404);

    const { data: settings } = await db
      .from("platform_billing_settings")
      .select("*")
      .eq("id", 1)
      .single();

    // Simple proration: keep the current cycle (no new charge, no period reset).
    // We recompute the server-authoritative breakdown for the new tier value so
    // the next renewal bills the correct amount. current_period_end is preserved.
    const breakdown = computeTransaction(
      Number(tier.price),
      (sub.method ?? "pix") as Method,
      Number(sub.installments) || 1,
      (tier.period ?? sub.period) as Period,
      settings as BillingSettings,
    );

    const { data: updatedSub, error: subErr } = await db
      .from("subscriptions")
      .update({
        tier_id: tierId,
        period: tier.period,
        installments: breakdown.installments,
        // current_period_end intentionally unchanged — keep the cycle.
      })
      .eq("id", subId)
      .eq("org_id", orgId)
      .select(
        "id, member_id, tier_id, period, status, current_period_end, installments, auto_renew, method",
      )
      .single();
    if (subErr || !updatedSub) return error("internal_error", "Falha ao trocar de tier", 500);

    // Keep the member's tier in sync.
    await db
      .from("members")
      .update({ tier_id: tierId })
      .eq("id", sub.member_id)
      .eq("org_id", orgId);

    await db.from("audit_logs").insert({
      org_id: orgId,
      actor: "api",
      action: "subscription.tier_changed",
      target: subId,
      payload: { from_tier: sub.tier_id, to_tier: tierId },
    });

    return ok({ data: updatedSub, breakdown });
  }

  return error("method_not_allowed", `${method} não permitido em ${path}`, 405);
});
