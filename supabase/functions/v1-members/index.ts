// Members API (§21) — authenticated by API key (api_keys table). Mounted at
// /functions/v1/v1-members/*. Provides member CRUD, the 360º profile, tags,
// notes, timeline and entitlements. The service role bypasses RLS, so every
// query filters org_id explicitly (belt + suspenders).
//
// Endpoints (path is relative to /v1-members):
//   GET    /                         → list/filter members (q, status, tierId, limit, offset)
//   POST   /                         → create a member (+ profile, metrics, generated member_id)
//   GET    /{id}                     → 360º profile (member, profile, metrics, tags, notes,
//                                       interactions/timeline, entitlements, subscription)
//   PATCH  /{id}                     → update member fields (status/tierId/source) and/or profile
//   POST   /{id}/notes               → add a note (appears on the timeline)
//   POST   /{id}/tags                → attach tag(s) by tagId or by label (creates the tag if new)
import { handlePreflight } from "../_shared/cors.ts";
import { ok, created, error, AppError } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { resolveAuth } from "../_shared/auth.ts";

// ── public member id (LNLNLNLN, no ambiguous chars) ──────────────
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
function genMemberId(): string {
  const pick = (set: string) => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
  let s = "";
  for (let i = 0; i < 8; i++) s += i % 2 === 0 ? pick(LETTERS) : pick(DIGITS);
  return s;
}

// deno-lint-ignore no-explicit-any
type Db = any;

const MEMBER_STATUSES = ["lead", "active", "past_due", "canceled", "reactivated"];

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
    throw new AppError("validation_failed", "Corpo deve ser um objeto JSON", 422);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("validation_failed", "JSON inválido", 400);
  }
}

/** Generates a member_id, retrying on the (extremely unlikely) unique collision. */
async function createUniqueMember(db: Db, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genMemberId();
    const { data, error: err } = await db
      .from("members")
      .insert({ ...row, member_id: code })
      .select()
      .single();
    if (!err) return data;
    // 23505 = unique_violation (member_id collision) → retry with a new code.
    if (err.code !== "23505") {
      throw new AppError("db_error", err.message ?? "Falha ao criar membro", 500);
    }
  }
  throw new AppError("conflict", "Não foi possível gerar um Member ID único", 409);
}

// ── handlers ─────────────────────────────────────────────────────

/** GET / — list/filter members for the org. */
async function listMembers(req: Request, db: Db, orgId: string): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const status = url.searchParams.get("status")?.trim();
  const tierId = url.searchParams.get("tierId")?.trim();
  const mode = url.searchParams.get("mode")?.trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  let query = db
    .from("members")
    .select(
      "id, member_id, org_id, mode, tier_id, status, joined_at, reactivated_at, source, grace_period_ends_at, member_profiles(name, email, phone, photo_url)",
      { count: "exact" },
    )
    .eq("org_id", orgId)
    .order("joined_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) {
    if (!MEMBER_STATUSES.includes(status)) throw new AppError("validation_failed", `status inválido: ${status}`, 422);
    query = query.eq("status", status);
  }
  if (tierId) query = query.eq("tier_id", tierId);
  if (mode) query = query.eq("mode", mode);

  const { data, error: err, count } = await query;
  if (err) throw new AppError("db_error", err.message, 500);

  // deno-lint-ignore no-explicit-any
  let rows = (data ?? []) as any[];
  // Lightweight free-text filter (member_id / name / email) over the page when q is given.
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter((m) => {
      const p = m.member_profiles ?? {};
      return (
        String(m.member_id).toLowerCase().includes(needle) ||
        String(p.name ?? "").toLowerCase().includes(needle) ||
        String(p.email ?? "").toLowerCase().includes(needle)
      );
    });
  }

  return ok({
    data: rows.map(shapeMemberListItem),
    pagination: { limit, offset, total: count ?? rows.length },
  });
}

// deno-lint-ignore no-explicit-any
function shapeMemberListItem(m: any) {
  const p = m.member_profiles ?? {};
  return {
    id: m.id,
    memberId: m.member_id,
    status: m.status,
    tierId: m.tier_id,
    mode: m.mode,
    joinedAt: m.joined_at,
    source: m.source,
    name: p.name ?? null,
    email: p.email ?? null,
    phone: p.phone ?? null,
    photoUrl: p.photo_url ?? null,
  };
}

/** POST / — create a member with an auto-generated unique member_id. */
async function createMember(req: Request, db: Db, orgId: string): Promise<Response> {
  const body = await readJson(req);
  const profile = (body.profile ?? {}) as Record<string, unknown>;
  const name = (body.name ?? profile.name) as string | undefined;
  const email = (body.email ?? profile.email) as string | undefined;

  if (!name && !email) {
    throw new AppError("validation_failed", "Informe ao menos name ou email", 422);
  }

  const status = (body.status as string) ?? "active";
  if (!MEMBER_STATUSES.includes(status)) throw new AppError("validation_failed", `status inválido: ${status}`, 422);

  const tierId = (body.tierId as string) ?? null;
  if (tierId) {
    const { data: tier } = await db.from("tiers").select("id").eq("id", tierId).eq("org_id", orgId).maybeSingle();
    if (!tier) throw new AppError("not_found", "Tier não encontrado nesta organização", 404);
  }

  const member = await createUniqueMember(db, {
    org_id: orgId,
    mode: (body.mode as string) ?? "live",
    tier_id: tierId,
    status,
    source: (body.source as string) ?? "api",
  });

  await db.from("member_profiles").insert({
    member_id: member.id,
    org_id: orgId,
    name: name ?? null,
    email: email ?? null,
    phone: (profile.phone ?? body.phone) ?? null,
    address: profile.address ?? null,
    social: profile.social ?? {},
    attributes: profile.attributes ?? {},
    consents: profile.consents ?? {},
  });
  await db.from("member_metrics").insert({ member_id: member.id, org_id: orgId });
  await db.from("interactions").insert({
    org_id: orgId,
    member_id: member.id,
    type: "joined",
    title: "Membro criado",
    detail: `Origem: ${(body.source as string) ?? "api"}`,
  });
  await db.from("audit_logs").insert({ org_id: orgId, actor: "api:v1-members", action: "member.created", target: member.id });

  return created({
    id: member.id,
    memberId: member.member_id,
    status: member.status,
    tierId: member.tier_id,
    mode: member.mode,
    joinedAt: member.joined_at,
  });
}

/** GET /{id} — full 360º profile. `id` accepts the internal uuid or the public member_id. */
async function getMember360(db: Db, orgId: string, id: string): Promise<Response> {
  const member = await resolveMember(db, orgId, id);

  const [profileRes, metricsRes, tagsRes, notesRes, timelineRes, entRes, subRes] = await Promise.all([
    db.from("member_profiles").select("*").eq("member_id", member.id).eq("org_id", orgId).maybeSingle(),
    db.from("member_metrics").select("*").eq("member_id", member.id).eq("org_id", orgId).maybeSingle(),
    db.from("member_tags").select("tag_id, tags(id, label, color)").eq("member_id", member.id).eq("org_id", orgId),
    db.from("notes").select("id, author, body, created_at").eq("member_id", member.id).eq("org_id", orgId).order("created_at", { ascending: false }),
    db.from("interactions").select("id, type, title, detail, occurred_at").eq("member_id", member.id).eq("org_id", orgId).order("occurred_at", { ascending: false }).limit(100),
    db.from("entitlements").select("id, perk_id, source, status, expires_at, perks(name, type)").eq("member_id", member.id).eq("org_id", orgId),
    db.from("subscriptions").select("id, tier_id, period, status, current_period_end, installments, auto_renew, method").eq("member_id", member.id).eq("org_id", orgId).order("created_at", { ascending: false }).maybeSingle(),
  ]);

  const p = profileRes.data;
  const mt = metricsRes.data;

  return ok({
    member: {
      id: member.id,
      memberId: member.member_id,
      status: member.status,
      tierId: member.tier_id,
      mode: member.mode,
      joinedAt: member.joined_at,
      reactivatedAt: member.reactivated_at,
      source: member.source,
      gracePeriodEndsAt: member.grace_period_ends_at,
    },
    profile: p
      ? {
          name: p.name,
          email: p.email,
          phone: p.phone,
          photoUrl: p.photo_url,
          address: p.address,
          social: p.social,
          attributes: p.attributes,
          consents: p.consents,
        }
      : null,
    metrics: mt
      ? {
          ltv: Number(mt.ltv),
          totalPaid: Number(mt.total_paid),
          netOrg: Number(mt.net_org),
          mrr: Number(mt.mrr),
          engagementScore: mt.engagement_score,
          churnScore: mt.churn_score,
          rfm: mt.rfm,
          lastActiveAt: mt.last_active_at,
        }
      : null,
    // deno-lint-ignore no-explicit-any
    tags: (tagsRes.data ?? []).map((t: any) => ({ id: t.tags?.id ?? t.tag_id, label: t.tags?.label, color: t.tags?.color })),
    // deno-lint-ignore no-explicit-any
    notes: (notesRes.data ?? []).map((n: any) => ({ id: n.id, author: n.author, body: n.body, createdAt: n.created_at })),
    // deno-lint-ignore no-explicit-any
    timeline: (timelineRes.data ?? []).map((i: any) => ({ id: i.id, type: i.type, title: i.title, detail: i.detail, occurredAt: i.occurred_at })),
    // deno-lint-ignore no-explicit-any
    entitlements: (entRes.data ?? []).map((e: any) => ({ id: e.id, perkId: e.perk_id, perkName: e.perks?.name ?? null, perkType: e.perks?.type ?? null, source: e.source, status: e.status, expiresAt: e.expires_at })),
    subscription: subRes.data
      ? {
          id: subRes.data.id,
          tierId: subRes.data.tier_id,
          period: subRes.data.period,
          status: subRes.data.status,
          currentPeriodEnd: subRes.data.current_period_end,
          installments: subRes.data.installments,
          autoRenew: subRes.data.auto_renew,
          method: subRes.data.method,
        }
      : null,
  });
}

/** PATCH /{id} — update member + profile fields. */
async function patchMember(req: Request, db: Db, orgId: string, id: string): Promise<Response> {
  const member = await resolveMember(db, orgId, id);
  const body = await readJson(req);

  // deno-lint-ignore no-explicit-any
  const memberPatch: Record<string, any> = {};
  if (body.status !== undefined) {
    if (!MEMBER_STATUSES.includes(body.status as string)) throw new AppError("validation_failed", `status inválido: ${body.status}`, 422);
    memberPatch.status = body.status;
    if (body.status === "reactivated") memberPatch.reactivated_at = new Date().toISOString();
  }
  if (body.tierId !== undefined) {
    if (body.tierId) {
      const { data: tier } = await db.from("tiers").select("id").eq("id", body.tierId).eq("org_id", orgId).maybeSingle();
      if (!tier) throw new AppError("not_found", "Tier não encontrado nesta organização", 404);
    }
    memberPatch.tier_id = body.tierId;
  }
  if (body.source !== undefined) memberPatch.source = body.source;
  if (body.gracePeriodEndsAt !== undefined) memberPatch.grace_period_ends_at = body.gracePeriodEndsAt;

  let updated = member;
  if (Object.keys(memberPatch).length > 0) {
    const { data, error: err } = await db.from("members").update(memberPatch).eq("id", member.id).eq("org_id", orgId).select().single();
    if (err) throw new AppError("db_error", err.message, 500);
    updated = data;
  }

  // Profile fields (any subset) → upsert.
  const profile = (body.profile ?? {}) as Record<string, unknown>;
  // deno-lint-ignore no-explicit-any
  const profilePatch: Record<string, any> = {};
  const mapProfile: Record<string, string> = {
    name: "name",
    email: "email",
    phone: "phone",
    photoUrl: "photo_url",
    address: "address",
    social: "social",
    attributes: "attributes",
    consents: "consents",
  };
  for (const [k, col] of Object.entries(mapProfile)) {
    const v = profile[k] ?? body[k];
    if (v !== undefined) profilePatch[col] = v;
  }
  if (Object.keys(profilePatch).length > 0) {
    const { error: err } = await db
      .from("member_profiles")
      .upsert({ member_id: member.id, org_id: orgId, ...profilePatch }, { onConflict: "member_id" });
    if (err) throw new AppError("db_error", err.message, 500);
  }

  await db.from("audit_logs").insert({ org_id: orgId, actor: "api:v1-members", action: "member.updated", target: member.id });

  return ok({
    id: updated.id,
    memberId: updated.member_id,
    status: updated.status,
    tierId: updated.tier_id,
    mode: updated.mode,
    source: updated.source,
  });
}

/** POST /{id}/notes — add a CRM note (mirrored as a timeline interaction). */
async function addNote(req: Request, db: Db, orgId: string, id: string): Promise<Response> {
  const member = await resolveMember(db, orgId, id);
  const body = await readJson(req);
  const text = (body.body ?? body.text) as string | undefined;
  if (!text || !text.trim()) throw new AppError("validation_failed", "body é obrigatório", 422);

  const { data: note, error: err } = await db
    .from("notes")
    .insert({ org_id: orgId, member_id: member.id, author: (body.author as string) ?? "api", body: text.trim() })
    .select("id, author, body, created_at")
    .single();
  if (err) throw new AppError("db_error", err.message, 500);

  await db.from("interactions").insert({
    org_id: orgId,
    member_id: member.id,
    type: "note_added",
    title: "Nota adicionada",
    detail: text.trim().slice(0, 280),
  });

  return created({ id: note.id, author: note.author, body: note.body, createdAt: note.created_at });
}

/** POST /{id}/tags — attach tag(s) by tagId or by label (creating the tag on demand). */
async function addTags(req: Request, db: Db, orgId: string, id: string): Promise<Response> {
  const member = await resolveMember(db, orgId, id);
  const body = await readJson(req);

  // Accept { tagId } | { tagIds: [] } | { label, color } | { labels: [] }.
  const tagIds = new Set<string>();
  if (typeof body.tagId === "string") tagIds.add(body.tagId);
  if (Array.isArray(body.tagIds)) for (const t of body.tagIds) if (typeof t === "string") tagIds.add(t);

  const labels: { label: string; color?: string }[] = [];
  if (typeof body.label === "string" && body.label.trim()) labels.push({ label: body.label.trim(), color: body.color as string | undefined });
  if (Array.isArray(body.labels)) {
    for (const l of body.labels) {
      if (typeof l === "string" && l.trim()) labels.push({ label: l.trim() });
      else if (l && typeof l === "object" && typeof l.label === "string") labels.push({ label: l.label.trim(), color: l.color });
    }
  }

  if (tagIds.size === 0 && labels.length === 0) {
    throw new AppError("validation_failed", "Informe tagId(s) ou label(s)", 422);
  }

  // Validate provided tagIds belong to the org.
  for (const tagId of tagIds) {
    const { data: tag } = await db.from("tags").select("id").eq("id", tagId).eq("org_id", orgId).maybeSingle();
    if (!tag) throw new AppError("not_found", `Tag ${tagId} não encontrada nesta organização`, 404);
  }

  // Find-or-create label tags.
  for (const { label, color } of labels) {
    const { data: existing } = await db.from("tags").select("id").eq("org_id", orgId).eq("label", label).maybeSingle();
    if (existing) {
      tagIds.add(existing.id);
    } else {
      const { data: createdTag, error: err } = await db.from("tags").insert({ org_id: orgId, label, color: color ?? null }).select("id").single();
      if (err) throw new AppError("db_error", err.message, 500);
      tagIds.add(createdTag.id);
    }
  }

  const rows = Array.from(tagIds).map((tag_id) => ({ org_id: orgId, member_id: member.id, tag_id }));
  const { error: linkErr } = await db.from("member_tags").upsert(rows, { onConflict: "member_id,tag_id", ignoreDuplicates: true });
  if (linkErr) throw new AppError("db_error", linkErr.message, 500);

  const { data: tags } = await db
    .from("member_tags")
    .select("tag_id, tags(id, label, color)")
    .eq("member_id", member.id)
    .eq("org_id", orgId);

  return created({
    // deno-lint-ignore no-explicit-any
    tags: (tags ?? []).map((t: any) => ({ id: t.tags?.id ?? t.tag_id, label: t.tags?.label, color: t.tags?.color })),
  });
}

/** Resolves a member by internal uuid or public member_id, scoped to the org. */
async function resolveMember(db: Db, orgId: string, id: string): Promise<Record<string, unknown>> {
  // member_id is exactly 8 chars from the LNLNLNLN alphabet; everything else is treated as a uuid.
  const looksLikePublic = /^[A-Z0-9]{8}$/i.test(id) && !id.includes("-");
  const column = looksLikePublic ? "member_id" : "id";
  const value = looksLikePublic ? id.toUpperCase() : id;
  const { data, error: err } = await db
    .from("members")
    .select("id, member_id, org_id, mode, tier_id, status, joined_at, reactivated_at, source, grace_period_ends_at")
    .eq(column, value)
    .eq("org_id", orgId)
    .maybeSingle();
  if (err) throw new AppError("db_error", err.message, 500);
  if (!data) throw new AppError("not_found", "Membro não encontrado", 404);
  return data;
}

// ── router ───────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  try {
    const db = serviceClient();
    const { orgId } = await resolveAuth(req, db);

    // Strip everything up to and including the function name so routing is
    // independent of the mount prefix (/functions/v1/v1-members/...).
    const raw = new URL(req.url).pathname;
    const path = raw.replace(/^.*\/v1-members/, "").replace(/\/+$/, "") || "/";
    const segments = path.split("/").filter(Boolean); // [] | [id] | [id, "notes"|"tags"]
    const method = req.method;

    // /  (collection)
    if (segments.length === 0) {
      if (method === "GET") return await listMembers(req, db, orgId);
      if (method === "POST") return await createMember(req, db, orgId);
      throw new AppError("method_not_allowed", `Método ${method} não suportado em /`, 405);
    }

    const memberId = segments[0];

    // /{id}
    if (segments.length === 1) {
      if (method === "GET") return await getMember360(db, orgId, memberId);
      if (method === "PATCH") return await patchMember(req, db, orgId, memberId);
      throw new AppError("method_not_allowed", `Método ${method} não suportado em /{id}`, 405);
    }

    // /{id}/notes | /{id}/tags
    if (segments.length === 2) {
      const sub = segments[1];
      if (sub === "notes" && method === "POST") return await addNote(req, db, orgId, memberId);
      if (sub === "tags" && method === "POST") return await addTags(req, db, orgId, memberId);
      throw new AppError("not_found", `Rota /${memberId}/${sub} não encontrada para ${method}`, 404);
    }

    throw new AppError("not_found", `Rota ${path} não encontrada`, 404);
  } catch (e) {
    if (e instanceof AppError) return error(e.code, e.message, e.status, e.details);
    console.error("v1-members unexpected error", e);
    return error("internal_error", "Erro interno", 500);
  }
});
