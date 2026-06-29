// v1-passport — public API for membership passes (§passport), API-key auth.
//   GET  /v1-passport                  → list the org's membership passes
//   GET  /v1-passport/{id}             → one pass (org-scoped)
//   POST /v1-passport/issue            → create or return a membership pass for a member,
//                                         with a signed auth_token (HMAC) and serial = member_id
//
// Service role bypasses RLS → every query filters org_id explicitly.
//
// NOTE: this issues the persistent pass record + a signed auth_token only. The actual
// wallet artifacts — Apple .pkpass (PKCS#7 signed with the Pass Type ID certificate) and
// Google Wallet "save" JWT (RS256 with the service-account key) — require provisioned
// certificates and are the next step; they are not generated here.
import { handlePreflight } from "../_shared/cors.ts";
import { ok, created, error, AppError } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { resolveAuth } from "../_shared/auth.ts";

/** Path relative to the function name, e.g. "/issue" or "/{id}". */
function relativePath(req: Request): string {
  const { pathname } = new URL(req.url);
  return pathname.replace(/^\/v1-passport/, "").replace(/\/+$/, "") || "/";
}

const PASS_TYPE = "membership";

/**
 * Signs an HMAC-SHA256 auth token over a compact payload (org/member/serial/issued-at),
 * using PASSPORT_SECRET. The token is `<base64url(payload)>.<base64url(hmac)>` so the
 * verifier can recompute the MAC without storing the payload separately. No PII inside.
 */
async function signAuthToken(payload: Record<string, string | number>): Promise<string> {
  const secret = Deno.env.get("PASSPORT_SECRET");
  if (!secret) throw new AppError("internal_error", "PASSPORT_SECRET não configurado", 500);

  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

/** URL-safe base64 without padding. */
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Shape returned to the client — no PII, no platform internals. */
function present(pass: Record<string, unknown>) {
  return {
    id: pass.id,
    member_id: pass.member_id,
    type: pass.type,
    platform: pass.platform,
    serial: pass.serial,
    auth_token: pass.auth_token,
    status: pass.status,
    created_at: pass.created_at,
  };
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

  // ── GET /  → list the org's membership passes ────────────────
  if (method === "GET" && path === "/") {
    const { data, error: dbErr } = await db
      .from("passes")
      .select("id, member_id, type, platform, serial, auth_token, status, created_at")
      .eq("org_id", orgId)
      .eq("type", PASS_TYPE)
      .order("created_at", { ascending: false });
    if (dbErr) return error("internal_error", "Falha ao listar passes", 500);
    return ok({ data: (data ?? []).map(present) });
  }

  // ── POST /issue  → create or return a membership pass ─────────
  if (method === "POST" && path === "/issue") {
    let body: { memberId?: string; platform?: string } = {};
    try {
      body = await req.json();
    } catch {
      return error("validation_failed", "JSON inválido", 400);
    }

    const memberId = body?.memberId;
    if (!memberId) return error("validation_failed", "memberId é obrigatório", 422);

    const platform = body?.platform;
    if (platform && platform !== "apple" && platform !== "google") {
      return error("validation_failed", "platform deve ser 'apple' ou 'google'", 422);
    }

    // Member must belong to the caller's org. We need the public member_id for the serial.
    const { data: member } = await db
      .from("members")
      .select("id, member_id, status")
      .eq("id", memberId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!member) return error("not_found", "Membro não encontrado", 404);
    if (member.status === "canceled") {
      return error("conflict", "Membro cancelado não pode emitir passe", 409);
    }

    // Idempotent: return the existing active membership pass for this member if present.
    const { data: existing } = await db
      .from("passes")
      .select("id, member_id, type, platform, serial, auth_token, status, created_at")
      .eq("org_id", orgId)
      .eq("member_id", member.id)
      .eq("type", PASS_TYPE)
      .neq("status", "inactive")
      .maybeSingle();
    if (existing) return ok({ data: present(existing) });

    // serial = member_id (the public 8-char ID); sign a fresh auth_token.
    const serial = member.member_id;
    let authToken: string;
    try {
      authToken = await signAuthToken({
        org: orgId,
        member: member.id,
        serial,
        iat: Math.floor(Date.now() / 1000),
      });
    } catch (e) {
      if (e instanceof AppError) return error(e.code, e.message, e.status, e.details);
      return error("internal_error", "Falha ao assinar o passe", 500);
    }

    const { data: pass, error: insErr } = await db
      .from("passes")
      .insert({
        org_id: orgId,
        member_id: member.id,
        type: PASS_TYPE,
        platform: platform ?? null,
        serial,
        auth_token: authToken,
        status: "active",
      })
      .select("id, member_id, type, platform, serial, auth_token, status, created_at")
      .single();
    if (insErr || !pass) return error("internal_error", "Falha ao emitir o passe", 500);

    await db.from("audit_logs").insert({
      org_id: orgId,
      actor: "api",
      action: "pass.issued",
      target: pass.id,
      payload: { member_id: member.id, type: PASS_TYPE, platform: platform ?? null },
    });

    return created({ data: present(pass) });
  }

  // ── GET /{id}  → one pass (org-scoped) ───────────────────────
  const match = path.match(/^\/([0-9a-fA-F-]{36})$/);
  if (method === "GET" && match) {
    const { data: pass } = await db
      .from("passes")
      .select("id, member_id, type, platform, serial, auth_token, status, created_at")
      .eq("id", match[1])
      .eq("org_id", orgId)
      .eq("type", PASS_TYPE)
      .maybeSingle();
    if (!pass) return error("not_found", "Passe não encontrado", 404);
    return ok({ data: present(pass) });
  }

  if (match || path === "/issue") {
    return error("method_not_allowed", `${method} não permitido em ${path}`, 405);
  }
  return error("not_found", `Rota ${method} ${path} não encontrada`, 404);
});
