// GET /v1-dashboard — aggregated org metrics for the admin dashboard (§10.2).
//
// Endpoints (path is taken from new URL(req.url).pathname *after* the function name):
//   GET /                  → full dashboard payload
//   GET /health            → liveness probe
//
// Auth: API key via `x-api-key` (or `Authorization: Bearer …`) → resolveAuth → orgId.
// The service-role client bypasses RLS, so EVERY query filters org_id explicitly.
// No PII is returned (counts/sums only); the platform fee is never surfaced as a
// "platform rate" — only the org's own commission+spread cost is reported.
import { handlePreflight } from "../_shared/cors.ts";
import { ok, error, AppError } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { resolveAuth } from "../_shared/auth.ts";
import { round2, type Period } from "../_shared/billing.ts";

// Mirror of monthlyEquivalent (app/src/lib/billing.ts): months covered per period.
const MONTHS_PER_PERIOD: Record<Period, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
  one_time: 1,
  lifetime: 1,
};
const monthlyEquivalent = (planValue: number, period: string): number =>
  round2(planValue / (MONTHS_PER_PERIOD[(period as Period)] ?? 1));

// Active = counts toward MRR/headcount (matches computeDashboard's `active`).
const ACTIVE_STATUSES = ["active", "reactivated", "past_due"] as const;
const RISK_THRESHOLD = 70; // churn_score >= 70 ⇒ "em risco"

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Start of the current calendar month in UTC (mirrors the front's UTC month filter). */
function monthStartUTC(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

interface MemberRow {
  id: string;
  tier_id: string | null;
  status: string;
  joined_at: string;
}
interface MetricRow {
  member_id: string;
  mrr: number | string;
  churn_score: number;
}
interface TierRow {
  id: string;
  name: string;
  color: string | null;
  price: number | string;
  period: string;
  position: number;
}
interface TxRow {
  charged_total: number | string;
  net_org: number | string;
  base_commission: number | string;
  financing_spread: number | string;
  created_at: string;
}

async function buildDashboard(db: ReturnType<typeof serviceClient>, orgId: string) {
  const monthStart = monthStartUTC();

  // org_id is filtered on every query (service role bypasses RLS).
  const [membersRes, metricsRes, tiersRes, monthTxRes, paidAggRes] = await Promise.all([
    db.from("members").select("id, tier_id, status, joined_at").eq("org_id", orgId),
    db.from("member_metrics").select("member_id, mrr, churn_score").eq("org_id", orgId),
    db.from("tiers").select("id, name, color, price, period, position").eq("org_id", orgId).order("position"),
    // This month's PAID transactions → month revenue / net / fees.
    db.from("transactions")
      .select("charged_total, net_org, base_commission, financing_spread, created_at")
      .eq("org_id", orgId)
      .eq("status", "paid")
      .gte("created_at", monthStart),
    // All-time PAID transactions for avg ticket: sum + count via head/count.
    db.from("transactions")
      .select("charged_total", { count: "exact" })
      .eq("org_id", orgId)
      .eq("status", "paid"),
  ]);

  for (const r of [membersRes, metricsRes, tiersRes, monthTxRes, paidAggRes]) {
    if (r.error) throw new AppError("query_failed", r.error.message, 500);
  }

  const members = (membersRes.data ?? []) as MemberRow[];
  const metrics = (metricsRes.data ?? []) as MetricRow[];
  const tiers = (tiersRes.data ?? []) as TierRow[];
  const monthTx = (monthTxRes.data ?? []) as TxRow[];
  const paidTx = (paidAggRes.data ?? []) as Pick<TxRow, "charged_total">[];

  const metricByMember = new Map(metrics.map((m) => [m.member_id, m]));
  const isActive = (s: string) => (ACTIVE_STATUSES as readonly string[]).includes(s);

  const active = members.filter((m) => isActive(m.status));
  const canceled = members.filter((m) => m.status === "canceled").length;
  const atRisk = members.filter(
    (m) => m.status !== "canceled" && num(metricByMember.get(m.id)?.churn_score) >= RISK_THRESHOLD,
  ).length;

  const mrr = round2(
    active.reduce((s, m) => s + num(metricByMember.get(m.id)?.mrr), 0),
  );

  const monthRevenue = round2(monthTx.reduce((s, t) => s + num(t.charged_total), 0));
  const netOrg = round2(monthTx.reduce((s, t) => s + num(t.net_org), 0));
  // Org's cost to the platform = base commission + financing spread (never labeled as a "rate").
  const stanbaseFees = round2(
    monthTx.reduce((s, t) => s + num(t.base_commission) + num(t.financing_spread), 0),
  );

  const newThisMonth = members.filter((m) => m.joined_at >= monthStart).length;

  const totalEver = members.length;
  const churnRate = totalEver ? round2(canceled / totalEver) : 0;

  const paidCount = paidTx.length;
  const avgTicket = paidCount
    ? round2(paidTx.reduce((s, t) => s + num(t.charged_total), 0) / paidCount)
    : 0;

  const tierDistribution = tiers.map((tier) => {
    const activeInTier = active.filter((m) => m.tier_id === tier.id).length;
    return {
      tierId: tier.id,
      name: tier.name,
      color: tier.color,
      count: members.filter((m) => m.tier_id === tier.id).length,
      activeCount: activeInTier,
      mrr: round2(activeInTier * monthlyEquivalent(num(tier.price), tier.period)),
    };
  });

  return {
    mrr,
    monthRevenue,
    netOrg,
    stanbaseFees,
    activeMembers: active.length,
    newThisMonth,
    canceled,
    atRisk,
    churnRate,
    avgTicket,
    tierDistribution,
    generatedAt: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  // Path *after* the function name, e.g. /functions/v1/v1-dashboard/health → /health
  const path = new URL(req.url).pathname.replace(/^.*\/v1-dashboard/, "").replace(/\/+$/, "") || "/";

  if (path === "/health") {
    return ok({ status: "ok", service: "stanbase-v1-dashboard", time: new Date().toISOString() });
  }

  if (req.method !== "GET") {
    return error("method_not_allowed", "Use GET", 405);
  }

  if (path !== "/") {
    return error("not_found", `Rota ${path} não encontrada`, 404);
  }

  const db = serviceClient();
  try {
    const auth = await resolveAuth(req, db);
    const data = await buildDashboard(db, auth.orgId);
    return ok(data);
  } catch (e) {
    if (e instanceof AppError) return error(e.code, e.message, e.status, e.details);
    return error("internal_error", (e as Error).message ?? "Erro inesperado", 500);
  }
});
