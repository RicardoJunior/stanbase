// v1-tiers — tiers + perks resource API (§12). Mounted at /functions/v1-tiers/*.
//
//   Tiers
//     GET    /tiers                       → list (ordered by position)
//     POST   /tiers                       → create (position defaults to next slot)
//     PATCH  /tiers/{id}                  → update (price, period, color, position-reorder, perk_ids…)
//     POST   /tiers/{id}/archive          → archive (status='archived')
//     POST   /tiers/reorder               → bulk reorder via [{id, position}]
//     POST   /tiers/{id}/perks            → attach/detach perks (perk_ids[] replaces the set)
//
//   Perks
//     GET    /perks                       → list
//     POST   /perks                       → create (perk-type catalog lives in the front; we only persist)
//     PATCH  /perks/{id}                  → update (name, config, status)
//     POST   /perks/{id}/archive          → archive
//
// Auth: x-api-key → resolveAuth → orgId. Service role bypasses RLS, so EVERY query
// filters org_id explicitly. Errors use the shared { error: { code, message, details } } envelope.
import { handlePreflight } from "../_shared/cors.ts";
import { ok, created, error, AppError } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { resolveAuth } from "../_shared/auth.ts";

const PERIODS = ["monthly", "quarterly", "semiannual", "annual", "one_time", "lifetime"];

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return (b && typeof b === "object") ? b as Record<string, unknown> : {};
  } catch {
    throw new AppError("validation_failed", "JSON inválido", 400);
  }
}

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** Validate a uuid[] payload and confirm every perk belongs to the org. */
async function validatePerkIds(
  db: ReturnType<typeof serviceClient>,
  orgId: string,
  raw: unknown,
): Promise<string[]> {
  if (!Array.isArray(raw)) throw new AppError("validation_failed", "perk_ids deve ser um array", 422);
  const ids = [...new Set(raw.filter((x): x is string => typeof x === "string" && x.trim() !== ""))];
  if (ids.length === 0) return [];
  const { data, error: e } = await db
    .from("perks")
    .select("id")
    .eq("org_id", orgId)
    .in("id", ids);
  if (e) throw new AppError("db_error", e.message, 500);
  const found = new Set((data ?? []).map((r: { id: string }) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AppError("validation_failed", "perk_ids contém perks inexistentes neste org", 422, { missing });
  }
  return ids;
}

Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  const db = serviceClient();

  try {
    const { orgId } = await resolveAuth(req, db);

    // Path after the function name; strip trailing slashes.
    const path =
      new URL(req.url).pathname.replace(/^\/v1-tiers/, "").replace(/\/+$/, "") || "/";
    const method = req.method;
    const segs = path.split("/").filter(Boolean); // e.g. ["tiers", "{id}", "archive"]

    // ──────────────────────────── TIERS ────────────────────────────
    if (segs[0] === "tiers") {
      // POST /tiers/reorder  → bulk reorder
      if (method === "POST" && segs[1] === "reorder" && segs.length === 2) {
        const body = await parseBody(req);
        const items = body.items;
        if (!Array.isArray(items) || items.length === 0) {
          throw new AppError("validation_failed", "items deve ser um array não vazio de { id, position }", 422);
        }
        const updates = items.map((it) => {
          const id = asString((it as Record<string, unknown>)?.id);
          const position = (it as Record<string, unknown>)?.position;
          if (!id || typeof position !== "number" || !Number.isFinite(position)) {
            throw new AppError("validation_failed", "cada item precisa de { id, position:number }", 422);
          }
          return { id, position };
        });
        const out = [];
        for (const u of updates) {
          const { data, error: e } = await db
            .from("tiers")
            .update({ position: u.position })
            .eq("id", u.id)
            .eq("org_id", orgId)
            .select("id, position")
            .maybeSingle();
          if (e) throw new AppError("db_error", e.message, 500);
          if (data) out.push(data);
        }
        return ok({ tiers: out });
      }

      // Collection: GET /tiers, POST /tiers
      if (segs.length === 1) {
        if (method === "GET") {
          const { data, error: e } = await db
            .from("tiers")
            .select("*")
            .eq("org_id", orgId)
            .order("position", { ascending: true })
            .order("created_at", { ascending: true });
          if (e) throw new AppError("db_error", e.message, 500);
          return ok({ tiers: data ?? [] });
        }

        if (method === "POST") {
          const body = await parseBody(req);
          const name = asString(body.name);
          if (!name) throw new AppError("validation_failed", "name é obrigatório", 422);
          const period = asString(body.period) ?? "monthly";
          if (!PERIODS.includes(period)) {
            throw new AppError("validation_failed", `period inválido (use: ${PERIODS.join(", ")})`, 422);
          }

          const perkIds = body.perk_ids === undefined ? [] : await validatePerkIds(db, orgId, body.perk_ids);

          // Default position = next free slot for the org.
          let position: number;
          if (typeof body.position === "number" && Number.isFinite(body.position)) {
            position = body.position;
          } else {
            const { data: last } = await db
              .from("tiers")
              .select("position")
              .eq("org_id", orgId)
              .order("position", { ascending: false })
              .limit(1)
              .maybeSingle();
            position = (last?.position ?? -1) + 1;
          }

          const insert: Record<string, unknown> = {
            org_id: orgId,
            name,
            period,
            position,
            perk_ids: perkIds,
            description: asString(body.description) ?? "",
            price: typeof body.price === "number" ? body.price : 0,
            currency: asString(body.currency) ?? "BRL",
            installments_enabled: body.installments_enabled === true,
          };
          if (asString(body.mode)) insert.mode = body.mode;
          if (asString(body.color)) insert.color = body.color;
          if (typeof body.capacity === "number") insert.capacity = body.capacity;

          const { data, error: e } = await db.from("tiers").insert(insert).select("*").single();
          if (e) throw new AppError("db_error", e.message, 500);
          return created({ tier: data });
        }

        return error("method_not_allowed", `Método ${method} não permitido em /tiers`, 405);
      }

      // Item routes: /tiers/{id}[/archive|/perks]
      const tierId = segs[1];

      // PATCH /tiers/{id}
      if (method === "PATCH" && segs.length === 2) {
        const body = await parseBody(req);
        const patch: Record<string, unknown> = {};
        if (asString(body.name) !== undefined) patch.name = asString(body.name);
        if (body.description !== undefined) patch.description = String(body.description ?? "");
        if (typeof body.price === "number") patch.price = body.price;
        if (asString(body.currency) !== undefined) patch.currency = asString(body.currency);
        if (asString(body.period) !== undefined) {
          const period = asString(body.period)!;
          if (!PERIODS.includes(period)) {
            throw new AppError("validation_failed", `period inválido (use: ${PERIODS.join(", ")})`, 422);
          }
          patch.period = period;
        }
        if (typeof body.position === "number" && Number.isFinite(body.position)) patch.position = body.position;
        if (body.color !== undefined) patch.color = body.color === null ? null : asString(body.color) ?? null;
        if (body.capacity !== undefined) patch.capacity = typeof body.capacity === "number" ? body.capacity : null;
        if (body.installments_enabled !== undefined) patch.installments_enabled = body.installments_enabled === true;
        if (asString(body.status) !== undefined) patch.status = asString(body.status);
        if (body.perk_ids !== undefined) patch.perk_ids = await validatePerkIds(db, orgId, body.perk_ids);

        if (Object.keys(patch).length === 0) {
          throw new AppError("validation_failed", "nenhum campo para atualizar", 422);
        }

        const { data, error: e } = await db
          .from("tiers")
          .update(patch)
          .eq("id", tierId)
          .eq("org_id", orgId)
          .select("*")
          .maybeSingle();
        if (e) throw new AppError("db_error", e.message, 500);
        if (!data) return error("not_found", "Tier não encontrado", 404);
        return ok({ tier: data });
      }

      // POST /tiers/{id}/archive
      if (method === "POST" && segs[2] === "archive" && segs.length === 3) {
        const { data, error: e } = await db
          .from("tiers")
          .update({ status: "archived" })
          .eq("id", tierId)
          .eq("org_id", orgId)
          .select("*")
          .maybeSingle();
        if (e) throw new AppError("db_error", e.message, 500);
        if (!data) return error("not_found", "Tier não encontrado", 404);
        return ok({ tier: data });
      }

      // POST /tiers/{id}/perks  → replace the attached perk set with perk_ids[]
      if (method === "POST" && segs[2] === "perks" && segs.length === 3) {
        const body = await parseBody(req);
        if (body.perk_ids === undefined) {
          throw new AppError("validation_failed", "perk_ids é obrigatório", 422);
        }
        const perkIds = await validatePerkIds(db, orgId, body.perk_ids);
        const { data, error: e } = await db
          .from("tiers")
          .update({ perk_ids: perkIds })
          .eq("id", tierId)
          .eq("org_id", orgId)
          .select("*")
          .maybeSingle();
        if (e) throw new AppError("db_error", e.message, 500);
        if (!data) return error("not_found", "Tier não encontrado", 404);
        return ok({ tier: data });
      }

      return error("not_found", `Rota ${method} ${path} não encontrada`, 404);
    }

    // ──────────────────────────── PERKS ────────────────────────────
    if (segs[0] === "perks") {
      // Collection: GET /perks, POST /perks
      if (segs.length === 1) {
        if (method === "GET") {
          const { data, error: e } = await db
            .from("perks")
            .select("*")
            .eq("org_id", orgId)
            .order("created_at", { ascending: true });
          if (e) throw new AppError("db_error", e.message, 500);
          return ok({ perks: data ?? [] });
        }

        if (method === "POST") {
          const body = await parseBody(req);
          const type = asString(body.type);
          const name = asString(body.name);
          if (!type) throw new AppError("validation_failed", "type é obrigatório", 422);
          if (!name) throw new AppError("validation_failed", "name é obrigatório", 422);
          const config = (body.config && typeof body.config === "object" && !Array.isArray(body.config))
            ? body.config
            : {};
          const insert: Record<string, unknown> = { org_id: orgId, type, name, config };
          if (asString(body.mode)) insert.mode = body.mode;
          if (asString(body.status)) insert.status = body.status;
          const { data, error: e } = await db.from("perks").insert(insert).select("*").single();
          if (e) throw new AppError("db_error", e.message, 500);
          return created({ perk: data });
        }

        return error("method_not_allowed", `Método ${method} não permitido em /perks`, 405);
      }

      const perkId = segs[1];

      // PATCH /perks/{id}
      if (method === "PATCH" && segs.length === 2) {
        const body = await parseBody(req);
        const patch: Record<string, unknown> = {};
        if (asString(body.name) !== undefined) patch.name = asString(body.name);
        if (asString(body.type) !== undefined) patch.type = asString(body.type);
        if (body.config !== undefined) {
          if (!body.config || typeof body.config !== "object" || Array.isArray(body.config)) {
            throw new AppError("validation_failed", "config deve ser um objeto", 422);
          }
          patch.config = body.config;
        }
        if (asString(body.status) !== undefined) patch.status = asString(body.status);
        if (Object.keys(patch).length === 0) {
          throw new AppError("validation_failed", "nenhum campo para atualizar", 422);
        }
        const { data, error: e } = await db
          .from("perks")
          .update(patch)
          .eq("id", perkId)
          .eq("org_id", orgId)
          .select("*")
          .maybeSingle();
        if (e) throw new AppError("db_error", e.message, 500);
        if (!data) return error("not_found", "Perk não encontrado", 404);
        return ok({ perk: data });
      }

      // POST /perks/{id}/archive
      if (method === "POST" && segs[2] === "archive" && segs.length === 3) {
        const { data, error: e } = await db
          .from("perks")
          .update({ status: "archived" })
          .eq("id", perkId)
          .eq("org_id", orgId)
          .select("*")
          .maybeSingle();
        if (e) throw new AppError("db_error", e.message, 500);
        if (!data) return error("not_found", "Perk não encontrado", 404);
        return ok({ perk: data });
      }

      return error("not_found", `Rota ${method} ${path} não encontrada`, 404);
    }

    return error("not_found", `Rota ${path} não encontrada`, 404);
  } catch (e) {
    if (e instanceof AppError) return error(e.code, e.message, e.status, e.details);
    return error("internal_error", (e as Error).message ?? "Erro inesperado", 500);
  }
});
