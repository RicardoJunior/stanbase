// v1-team — team management API (org_users), authenticated by API key (§21).
// Mounted at /functions/v1-team/*. The org is resolved from the x-api-key header
// (resolveAuth → api_keys.org_id); the service role bypasses RLS, so every query
// filters org_id explicitly (belt + suspenders).
//
// Endpoints:
//   GET    /                  → list the org's team members
//   POST   /                  → invite a member (status `invited`, preset perms)
//   PATCH  /{orgUserId}        → change role (resets permissions to the preset)
//   DELETE /{orgUserId}        → remove a member (refuses the last owner)
import { handlePreflight } from "../_shared/cors.ts";
import { ok, created, error, AppError } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { resolveAuth } from "../_shared/auth.ts";

type Role = "owner" | "admin" | "operator";

// Permission presets per role — mirror of app/src/lib/api.ts ROLE_PRESETS.
const ROLE_PRESETS: Record<Role, string[]> = {
  owner: ["*"],
  admin: [
    "dashboard",
    "crm.read",
    "crm.write",
    "tiers.write",
    "page.write",
    "revenue.read",
    "events.write",
    "integrations.write",
    "communication.write",
    "theme.write",
  ],
  operator: ["checkin", "validation"],
};

const ROLES: Role[] = ["owner", "admin", "operator"];
const isRole = (v: unknown): v is Role => typeof v === "string" && ROLES.includes(v as Role);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Columns returned to the caller — no PII beyond what team management needs
// (user_id is an internal auth reference and is intentionally omitted).
const PUBLIC_COLUMNS = "id, org_id, name, email, role, permissions, status, created_at";

/** Path after the function name, e.g. "/" or "/{orgUserId}". */
function resourcePath(req: Request): string {
  const { pathname } = new URL(req.url);
  return pathname.replace(/^\/v1-team/, "").replace(/\/+$/, "") || "/";
}

Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  const db = serviceClient();
  const path = resourcePath(req);

  try {
    const { orgId } = await resolveAuth(req, db);

    // ── GET / → list the org's members ───────────────────────────
    if (req.method === "GET" && path === "/") {
      const { data, error: dbErr } = await db
        .from("org_users")
        .select(PUBLIC_COLUMNS)
        .eq("org_id", orgId)
        .order("created_at", { ascending: true });
      if (dbErr) throw new AppError("internal_error", "Falha ao listar a equipe", 500);
      return ok({ data: data ?? [] });
    }

    // ── POST / → invite a member ─────────────────────────────────
    if (req.method === "POST" && path === "/") {
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return error("validation_failed", "JSON inválido", 400);
      }

      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const role = body.role;
      const rawName = typeof body.name === "string" ? body.name.trim() : "";

      if (!email || !EMAIL_RE.test(email)) {
        return error("validation_failed", "email válido é obrigatório", 422);
      }
      if (!isRole(role)) {
        return error("validation_failed", "role deve ser owner, admin ou operator", 422);
      }

      // One membership per email within the org.
      const { data: dup } = await db
        .from("org_users")
        .select("id")
        .eq("org_id", orgId)
        .eq("email", email)
        .maybeSingle();
      if (dup) return error("conflict", "Já existe um membro com este e-mail", 409);

      const name = rawName || email.split("@")[0];
      const { data, error: dbErr } = await db
        .from("org_users")
        .insert({
          org_id: orgId,
          name,
          email,
          role,
          permissions: [...ROLE_PRESETS[role]],
          status: "invited",
        })
        .select(PUBLIC_COLUMNS)
        .single();
      if (dbErr || !data) throw new AppError("internal_error", "Falha ao convidar o membro", 500);

      await db
        .from("audit_logs")
        .insert({ org_id: orgId, actor: "v1-team", action: "org_user.invited", target: data.id });

      return created({ data });
    }

    // ── routes that target a single member: /{orgUserId} ─────────
    const orgUserId = path.startsWith("/") ? path.slice(1) : "";

    // ── PATCH /{orgUserId} → change role (reset perms to preset) ──
    if (req.method === "PATCH") {
      if (!orgUserId) return error("validation_failed", "orgUserId é obrigatório no path", 422);

      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return error("validation_failed", "JSON inválido", 400);
      }
      const role = body.role;
      if (!isRole(role)) {
        return error("validation_failed", "role deve ser owner, admin ou operator", 422);
      }

      const { data: target } = await db
        .from("org_users")
        .select("id, role")
        .eq("org_id", orgId)
        .eq("id", orgUserId)
        .maybeSingle();
      if (!target) return error("not_found", "Membro não encontrado", 404);

      // Demoting the last owner would lock the org out of billing/team/deletion.
      if (target.role === "owner" && role !== "owner") {
        const { count } = await db
          .from("org_users")
          .select("id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .eq("role", "owner");
        if ((count ?? 0) <= 1) {
          return error(
            "conflict",
            "Não dá para rebaixar o único owner. Transfira a posse antes.",
            409,
          );
        }
      }

      const { data, error: dbErr } = await db
        .from("org_users")
        .update({ role, permissions: [...ROLE_PRESETS[role]] })
        .eq("org_id", orgId)
        .eq("id", orgUserId)
        .select(PUBLIC_COLUMNS)
        .single();
      if (dbErr || !data) throw new AppError("internal_error", "Falha ao atualizar o papel", 500);

      await db
        .from("audit_logs")
        .insert({ org_id: orgId, actor: "v1-team", action: "org_user.role_changed", target: data.id });

      return ok({ data });
    }

    // ── DELETE /{orgUserId} → remove (refuses the last owner) ─────
    if (req.method === "DELETE") {
      if (!orgUserId) return error("validation_failed", "orgUserId é obrigatório no path", 422);

      const { data: target } = await db
        .from("org_users")
        .select("id, role")
        .eq("org_id", orgId)
        .eq("id", orgUserId)
        .maybeSingle();
      if (!target) return error("not_found", "Membro não encontrado", 404);

      if (target.role === "owner") {
        const { count } = await db
          .from("org_users")
          .select("id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .eq("role", "owner");
        if ((count ?? 0) <= 1) {
          return error(
            "conflict",
            "Não dá para remover o único owner. Transfira a posse antes.",
            409,
          );
        }
      }

      const { error: dbErr } = await db
        .from("org_users")
        .delete()
        .eq("org_id", orgId)
        .eq("id", orgUserId);
      if (dbErr) throw new AppError("internal_error", "Falha ao remover o membro", 500);

      await db
        .from("audit_logs")
        .insert({ org_id: orgId, actor: "v1-team", action: "org_user.removed", target: orgUserId });

      return ok({ data: { id: orgUserId, removed: true } });
    }

    return error("not_found", `Rota ${req.method} ${path} não encontrada`, 404);
  } catch (e) {
    if (e instanceof AppError) return error(e.code, e.message, e.status, e.details);
    return error("internal_error", "Erro inesperado", 500);
  }
});
