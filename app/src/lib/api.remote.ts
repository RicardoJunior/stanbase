/**
 * Remote API — reference implementations of the lib/api.ts facade against the
 * REAL backend (supabase-js + RLS for reads, Edge `/v1-*` functions for the
 * financial/secret writes). This is the migration target for lib/api.ts.
 *
 * Why a separate module (not a rewrite of api.ts):
 *  - The localStorage prototype must keep working untouched when the envs are
 *    absent (see lib/supabase.ts → hasBackend()).
 *  - The local selectors are SYNCHRONOUS and take `db` (the in-memory snapshot)
 *    so they compose inside useStore(). Over the network there is no snapshot,
 *    and every call is async. So the remote twins keep the same *name + logical
 *    parameters* (orgId, ids) but:
 *      • drop the leading `db: DBSnapshot` arg (data comes from the wire), and
 *      • return Promise<T> instead of T.
 *    The returned domain shapes are IDENTICAL to api.ts, so screens migrate by
 *    swapping `useStore(db => listMembers(db, orgId))` for
 *    `await listMembers(orgId)` behind a small async hook.
 *
 * Contract (from MEMORY): reads go through supabase-js with RLS; writes that
 * touch money or secrets go through the Edge `/v1-*` functions (service role,
 * org_id filtered server-side). The platform fee (7,99%) is NEVER surfaced to a
 * member — dashboard only reports the org's own commission+spread cost.
 */
import type {
  Member,
  MemberMetrics,
  MemberProfile,
  Tier,
  Note,
  Interaction,
  Tag,
  Subscription,
  Entitlement,
} from "@/types/domain";
import type { CheckoutInput, CheckoutResult, Dashboard } from "@/lib/api";
import { requireClient, FUNCTIONS_URL } from "@/lib/supabase";
import { processCharge } from "@/lib/payments";

// ── shaping helpers (snake_case rows → camelCase domain) ─────────────
// deno-style escape hatch: supabase-js rows are loosely typed PostgREST shapes.
type Row = Record<string, any>;
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function shapeMember(r: Row): Member {
  return {
    id: r.id,
    memberId: r.member_id,
    orgId: r.org_id,
    mode: r.mode,
    userId: r.user_id ?? null,
    tierId: r.tier_id ?? null,
    status: r.status,
    joinedAt: r.joined_at,
    reactivatedAt: r.reactivated_at ?? null,
    source: r.source,
    gracePeriodEndsAt: r.grace_period_ends_at ?? null,
  };
}

function shapeTier(r: Row): Tier {
  return {
    id: r.id,
    orgId: r.org_id,
    mode: r.mode,
    name: r.name,
    description: r.description ?? "",
    price: num(r.price),
    currency: r.currency ?? "BRL",
    period: r.period,
    position: r.position,
    color: r.color ?? "#6d28d9",
    capacity: r.capacity ?? null,
    installmentsEnabled: !!r.installments_enabled,
    perkIds: r.perk_ids ?? [],
    status: r.status,
  };
}

function shapeProfile(r: Row): MemberProfile {
  return {
    memberId: r.member_id,
    name: r.name,
    photoUrl: r.photo_url ?? null,
    email: r.email ?? null,
    phone: r.phone ?? null,
    address: r.address ?? null,
    social: r.social ?? {},
    attributes: r.attributes ?? {},
    consents: r.consents ?? { email: false, whatsapp: false, push: false, photoPublic: false },
  };
}

function shapeMetrics(r: Row): MemberMetrics {
  return {
    memberId: r.member_id,
    ltv: num(r.ltv),
    totalPaid: num(r.total_paid),
    netOrg: num(r.net_org),
    mrr: num(r.mrr),
    engagementScore: num(r.engagement_score),
    churnScore: num(r.churn_score),
    rfm: r.rfm ?? { r: 0, f: 0, m: 0 },
    lastActiveAt: r.last_active_at,
  };
}

// ── reads (supabase-js + RLS) ────────────────────────────────────────

/** Mirror of api.ts `listMembers(db, orgId)`. RLS already scopes to the org;
 * we still pass `orgId` to keep the call-site identical and to filter when a
 * session legitimately spans orgs. */
export async function listMembers(orgId: string): Promise<Member[]> {
  const { data, error } = await requireClient()
    .from("members")
    .select("*")
    .eq("org_id", orgId)
    .order("joined_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(shapeMember);
}

/** Mirror of api.ts `listTiers(db, orgId)` — active tiers, ordered by position. */
export async function listTiers(orgId: string): Promise<Tier[]> {
  const { data, error } = await requireClient()
    .from("tiers")
    .select("*")
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("position", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map(shapeTier);
}

/** 360º profile returned by api.ts `getMember(db, id)` extended with the
 * related rows the member surface needs in one round-trip. Returns null when
 * the member is not visible under RLS. */
export interface RemoteMember360 {
  member: Member;
  profile: MemberProfile | null;
  metrics: MemberMetrics | null;
  tags: Tag[];
  notes: Note[];
  timeline: Interaction[];
  entitlements: Entitlement[];
  subscription: Subscription | null;
}

/** Mirror of api.ts `getMember(db, id)`. `id` is the internal uuid. */
export async function getMember(id: string): Promise<RemoteMember360 | null> {
  const db = requireClient();
  const { data: member, error } = await db.from("members").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!member) return null;

  const [profileRes, metricsRes, tagsRes, notesRes, timelineRes, entRes, subRes] = await Promise.all([
    db.from("member_profiles").select("*").eq("member_id", id).maybeSingle(),
    db.from("member_metrics").select("*").eq("member_id", id).maybeSingle(),
    db.from("member_tags").select("tag_id, tags(id, org_id, label, color)").eq("member_id", id),
    db.from("notes").select("*").eq("member_id", id).order("created_at", { ascending: false }),
    db.from("interactions").select("*").eq("member_id", id).order("occurred_at", { ascending: false }).limit(100),
    db.from("entitlements").select("*").eq("member_id", id),
    db.from("subscriptions").select("*").eq("member_id", id).neq("status", "canceled").order("created_at", { ascending: false }).maybeSingle(),
  ]);

  return {
    member: shapeMember(member),
    profile: profileRes.data ? shapeProfile(profileRes.data) : null,
    metrics: metricsRes.data ? shapeMetrics(metricsRes.data) : null,
    tags: (tagsRes.data ?? []).map((t: Row) => ({
      id: t.tags?.id ?? t.tag_id,
      orgId: t.tags?.org_id,
      label: t.tags?.label,
      color: t.tags?.color,
    })),
    notes: (notesRes.data ?? []).map((n: Row) => ({
      id: n.id, orgId: n.org_id, memberId: n.member_id, author: n.author, body: n.body, createdAt: n.created_at,
    })),
    timeline: (timelineRes.data ?? []).map((i: Row) => ({
      id: i.id, orgId: i.org_id, memberId: i.member_id, type: i.type, title: i.title, detail: i.detail, occurredAt: i.occurred_at,
    })),
    entitlements: (entRes.data ?? []).map((e: Row) => ({
      id: e.id, orgId: e.org_id, memberId: e.member_id, perkId: e.perk_id, source: e.source, status: e.status, expiresAt: e.expires_at ?? null,
    })),
    subscription: subRes.data
      ? {
          id: subRes.data.id, orgId: subRes.data.org_id, mode: subRes.data.mode, memberId: subRes.data.member_id,
          tierId: subRes.data.tier_id, period: subRes.data.period, status: subRes.data.status,
          currentPeriodEnd: subRes.data.current_period_end, installments: subRes.data.installments,
          autoRenew: subRes.data.auto_renew, method: subRes.data.method, createdAt: subRes.data.created_at,
        }
      : null,
  };
}

/**
 * Mirror of api.ts `computeDashboard(db, orgId)`. The aggregation matches the
 * Edge `/v1-dashboard` payload exactly (same active-status set, same UTC month
 * window, same fee math). We read the function instead of re-summing client-side
 * so the heavy aggregation stays server-side and the platform fee is never
 * computed in the browser. Returns the api.ts `Dashboard` shape.
 */
export async function computeDashboard(orgId: string): Promise<Dashboard> {
  const res = await callFunction(`v1-dashboard`, { method: "GET" });
  // /v1-dashboard returns tierDistribution as { tierId, name, color, count, mrr },
  // while api.ts wants { tier, count, mrr }. Hydrate `tier` from listTiers.
  const tiers = await listTiers(orgId);
  const tierById = new Map(tiers.map((t) => [t.id, t]));
  return {
    mrr: num(res.mrr),
    monthRevenue: num(res.monthRevenue),
    netOrg: num(res.netOrg),
    stanbaseFees: num(res.stanbaseFees),
    activeMembers: num(res.activeMembers),
    newThisMonth: num(res.newThisMonth),
    canceled: num(res.canceled),
    atRisk: num(res.atRisk),
    churnRate: num(res.churnRate),
    avgTicket: num(res.avgTicket),
    tierDistribution: (res.tierDistribution ?? [])
      .map((d: Row) => {
        const tier = tierById.get(d.tierId);
        return tier ? { tier, count: num(d.count), mrr: num(d.mrr) } : null;
      })
      .filter((x: unknown): x is Dashboard["tierDistribution"][number] => x !== null),
  };
}

// ── writes (Edge `/v1-*` functions — money/secrets, service role) ────

/**
 * Mirror of api.ts `checkout(input)`. The financial write runs server-side: the
 * Asaas charge (Pix QR / card with split) + the pending transaction are created
 * by the `/checkout` Edge Function (see lib/payments.ts → processCharge), then
 * confirmed by the asaas-webhook. We never compute commission or call the PSP in
 * the browser. Returns the api.ts `CheckoutResult` shape; the transaction starts
 * `pending` (paid tiers) until the webhook confirms.
 */
export async function checkout(input: CheckoutInput): Promise<CheckoutResult> {
  const charge = await processCharge({
    method: input.method,
    installments: input.installments,
    description: `Assinatura ${input.tierId}`,
    externalReference: input.memberId ?? input.email ?? input.name,
    // Server recomputes the breakdown from platform_billing_settings; we only
    // pass routing info. A zero breakdown is fine — the Edge Function owns the math.
    breakdown: {
      planValue: 0, customerInterest: 0, chargedTotal: 0, baseCommission: 0,
      pspFee: 0, pspAnticipationFee: 0, financingSpread: 0, netOrg: 0, stanbaseTotal: 0,
    },
    orgId: input.orgId,
    tierId: input.tierId,
    customer: { name: input.name, email: input.email ?? "", phone: undefined },
  });

  // After the charge, read back the member the function provisioned (RLS-scoped).
  // The webhook will flip the transaction to `paid`; the screen polls getMember.
  let member: Member | null = null;
  if (input.memberId) {
    const m = await getMember(input.memberId);
    member = m?.member ?? null;
  }
  if (!member) {
    // Fall back to the newest member of the org (just-created via checkout).
    const list = await listMembers(input.orgId);
    member = list[0] ?? null;
  }
  if (!member) throw new Error(`Checkout falhou (status=${charge.status}).`);

  // transaction is created+confirmed server-side; the surface reads it via getMember.
  return { member, transaction: null };
}

// ── tiny fetch helper for the Edge functions ─────────────────────────
interface FnOptions {
  method?: string;
  body?: unknown;
  /** API key for the `/v1-*` resource functions (x-api-key). */
  apiKey?: string;
}

/** POST/GET an Edge `/v1-*` function and return the parsed JSON (throws on error). */
export async function callFunction(name: string, opts: FnOptions = {}): Promise<Row> {
  if (!FUNCTIONS_URL) throw new Error("VITE_FUNCTIONS_URL não configurado.");
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: opts.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.apiKey ? { "x-api-key": opts.apiKey } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message ?? `Falha em ${name} (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return data;
}
