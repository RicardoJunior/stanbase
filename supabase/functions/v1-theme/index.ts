// v1-theme — tema e landing da organização (§24, branding/page-builder).
// Autenticado por API key (x-api-key → api_keys, via resolveAuth).
// Mounted at /functions/v1/v1-theme/*. Rotas (path = pathname após o nome da função):
//   GET    /                 → theme + landing da org
//   GET    /theme            → apenas theme
//   GET    /landing          → apenas landing
//   PUT    /theme            → grava organizations.theme (jsonb)
//   PUT    /landing          → grava organizations.landing (jsonb)
//   POST   /landing/reset    → reseta landing (volta ao default → null)
//
// Service role bypassa RLS → SEMPRE filtra org_id explicitamente.
import { handlePreflight } from "../_shared/cors.ts";
import { ok, error, AppError } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { resolveAuth } from "../_shared/auth.ts";

// ── shapes (espelham app/src/types/domain.ts) ────────────────────────
interface OrgTheme {
  primary?: string;
  accent?: string;
  bgLight?: string;
  bgDark?: string;
  fontDisplay?: string;
  fontBody?: string;
  defaultMode?: "light" | "dark" | "system";
  darkEnabled?: boolean;
  memberCardArt?: string;
}
interface LandingBlock {
  id: string;
  type: string;
  content: Record<string, unknown>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Strips the deployed function name to get the resource path. "" → "/". */
function resourcePath(req: Request): string {
  const { pathname } = new URL(req.url);
  // ex: /v1-theme/theme  ou  /functions/v1/v1-theme/theme
  const stripped = pathname.replace(/^\/(functions\/v1\/)?v1-theme/, "").replace(/\/+$/, "");
  return stripped || "/";
}

/** Reads + validates a JSON body, returning a plain object. */
async function readJsonObject(req: Request, field: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError("validation_failed", "JSON inválido", 400);
  }
  if (!isObject(body)) throw new AppError("validation_failed", `${field} deve ser um objeto JSON`, 422);
  return body;
}

// ── theme validation ─────────────────────────────────────────────────
const STRING_FIELDS = [
  "primary",
  "accent",
  "bgLight",
  "bgDark",
  "fontDisplay",
  "fontBody",
  "memberCardArt",
] as const;

function sanitizeTheme(input: Record<string, unknown>): OrgTheme {
  const theme: OrgTheme = {};
  for (const key of STRING_FIELDS) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new AppError("validation_failed", `theme.${key} deve ser string`, 422);
    (theme as Record<string, unknown>)[key] = v;
  }
  if (input.defaultMode !== undefined) {
    const m = input.defaultMode;
    if (m !== "light" && m !== "dark" && m !== "system") {
      throw new AppError("validation_failed", "theme.defaultMode deve ser light|dark|system", 422);
    }
    theme.defaultMode = m;
  }
  if (input.darkEnabled !== undefined) {
    if (typeof input.darkEnabled !== "boolean") {
      throw new AppError("validation_failed", "theme.darkEnabled deve ser boolean", 422);
    }
    theme.darkEnabled = input.darkEnabled;
  }
  return theme;
}

// ── landing validation ───────────────────────────────────────────────
function sanitizeLanding(input: unknown): LandingBlock[] {
  if (!Array.isArray(input)) {
    throw new AppError("validation_failed", "landing deve ser um array de blocos", 422);
  }
  return input.map((raw, i) => {
    if (!isObject(raw)) throw new AppError("validation_failed", `landing[${i}] deve ser um objeto`, 422);
    if (typeof raw.id !== "string" || !raw.id) {
      throw new AppError("validation_failed", `landing[${i}].id é obrigatório`, 422);
    }
    if (typeof raw.type !== "string" || !raw.type) {
      throw new AppError("validation_failed", `landing[${i}].type é obrigatório`, 422);
    }
    if (raw.content !== undefined && !isObject(raw.content)) {
      throw new AppError("validation_failed", `landing[${i}].content deve ser um objeto`, 422);
    }
    return {
      id: raw.id,
      type: raw.type,
      content: (raw.content as Record<string, unknown>) ?? {},
    };
  });
}

// ── data access (sempre filtra org_id) ───────────────────────────────
async function loadOrg(db: ReturnType<typeof serviceClient>, orgId: string) {
  const { data, error: dbErr } = await db
    .from("organizations")
    .select("id, theme, landing")
    .eq("id", orgId)
    .maybeSingle();
  if (dbErr) throw new AppError("internal_error", "Falha ao carregar organização", 500);
  if (!data) throw new AppError("not_found", "Organização não encontrada", 404);
  return data;
}

Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  try {
    const db = serviceClient();
    const { orgId } = await resolveAuth(req, db);
    const path = resourcePath(req);
    const method = req.method.toUpperCase();

    // ── GET / | /theme | /landing ──────────────────────────────────
    if (method === "GET") {
      const org = await loadOrg(db, orgId);
      if (path === "/theme") return ok({ theme: (org.theme as OrgTheme) ?? {} });
      if (path === "/landing") return ok({ landing: (org.landing as LandingBlock[] | null) ?? null });
      if (path === "/") {
        return ok({
          theme: (org.theme as OrgTheme) ?? {},
          landing: (org.landing as LandingBlock[] | null) ?? null,
        });
      }
      return error("not_found", `Rota ${path} não encontrada`, 404);
    }

    // ── PUT /theme ─────────────────────────────────────────────────
    if (method === "PUT" && path === "/theme") {
      await loadOrg(db, orgId); // garante existência sob o org_id
      const body = await readJsonObject(req, "theme");
      // aceita { theme: {...} } ou o objeto direto
      const raw = isObject(body.theme) ? (body.theme as Record<string, unknown>) : body;
      const theme = sanitizeTheme(raw);
      const { data, error: dbErr } = await db
        .from("organizations")
        .update({ theme })
        .eq("id", orgId)
        .select("theme")
        .single();
      if (dbErr) throw new AppError("internal_error", "Falha ao salvar tema", 500);
      await db.from("audit_logs").insert({ org_id: orgId, actor: "api", action: "theme.updated", target: orgId });
      return ok({ theme: data.theme as OrgTheme });
    }

    // ── PUT /landing ───────────────────────────────────────────────
    if (method === "PUT" && path === "/landing") {
      await loadOrg(db, orgId);
      const body = await readJsonObject(req, "landing");
      const rawLanding = body.landing !== undefined ? body.landing : body.blocks;
      const landing = sanitizeLanding(rawLanding);
      const { data, error: dbErr } = await db
        .from("organizations")
        .update({ landing })
        .eq("id", orgId)
        .select("landing")
        .single();
      if (dbErr) throw new AppError("internal_error", "Falha ao salvar landing", 500);
      await db.from("audit_logs").insert({ org_id: orgId, actor: "api", action: "landing.updated", target: orgId });
      return ok({ landing: data.landing as LandingBlock[] });
    }

    // ── POST /landing/reset ────────────────────────────────────────
    if (method === "POST" && path === "/landing/reset") {
      await loadOrg(db, orgId);
      const { data, error: dbErr } = await db
        .from("organizations")
        .update({ landing: null })
        .eq("id", orgId)
        .select("landing")
        .single();
      if (dbErr) throw new AppError("internal_error", "Falha ao resetar landing", 500);
      await db.from("audit_logs").insert({ org_id: orgId, actor: "api", action: "landing.reset", target: orgId });
      // landing = null → o front renderiza a landing default.
      return ok({ landing: data.landing as null });
    }

    if (method !== "GET" && method !== "PUT" && method !== "POST") {
      return error("method_not_allowed", `Método ${method} não permitido`, 405);
    }
    return error("not_found", `Rota ${method} ${path} não encontrada`, 404);
  } catch (e) {
    if (e instanceof AppError) return error(e.code, e.message, e.status, e.details);
    return error("internal_error", "Erro inesperado", 500);
  }
});
