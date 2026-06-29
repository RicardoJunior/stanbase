// v1-events — API pública de eventos (autenticada por x-api-key, §21).
// Montada em /functions/v1/v1-events/*. Roteia por método + path (pathname
// após o nome da função). Service role → SEMPRE filtra org_id explicitamente.
//
// Endpoints:
//   GET    /events                      lista eventos da org
//   POST   /events                      cria evento
//   GET    /events/{id}                 detalhe do evento
//   PATCH  /events/{id}                 atualiza evento
//   DELETE /events/{id}                 remove evento
//   POST   /events/{id}/tickets         emite ticket (+ pass) para um membro
//   POST   /events/{id}/checkin         valida + registra check-in por member_id
import { handlePreflight } from "../_shared/cors.ts";
import { ok, created, error, AppError } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { resolveAuth } from "../_shared/auth.ts";
import {
  computeTransaction,
  type BillingSettings,
  type Method,
  type Period,
} from "../_shared/billing.ts";

const UUID = /^[0-9a-fA-F-]{36}$/;

// Campos do evento que a API aceita escrever (whitelist anti-mass-assignment).
const EVENT_WRITABLE = [
  "name",
  "starts_at",
  "venue",
  "capacity",
  "min_tier_id",
  "price",
  "mode",
] as const;

function pickEvent(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of EVENT_WRITABLE) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

// Serial curto e legível para o pass (sem PII).
function serial(): string {
  const SET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  const r = crypto.getRandomValues(new Uint32Array(8));
  for (let i = 0; i < 8; i++) s += SET[r[i] % SET.length];
  return s;
}

async function parseJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (b && typeof b === "object") return b as Record<string, unknown>;
  } catch { /* fallthrough */ }
  throw new AppError("validation_failed", "JSON inválido", 400);
}

// Resolve um membro da org por member_id público (8 chars) ou por uuid interno.
async function findMember(
  db: ReturnType<typeof serviceClient>,
  orgId: string,
  ref: string,
) {
  let q = db
    .from("members")
    .select("id, member_id, org_id, tier_id, status, grace_period_ends_at")
    .eq("org_id", orgId);
  q = UUID.test(ref) ? q.eq("id", ref) : q.eq("member_id", ref.toUpperCase());
  const { data } = await q.maybeSingle();
  return data;
}

Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  const db = serviceClient();

  // Auth: orgId a partir do x-api-key. Tudo abaixo filtra por esse org_id.
  let orgId: string;
  try {
    ({ orgId } = await resolveAuth(req, db));
  } catch (e) {
    if (e instanceof AppError) return error(e.code, e.message, e.status, e.details);
    return error("unauthorized", "Falha de autenticação", 401);
  }

  // path = pathname após o nome da função.
  const path =
    new URL(req.url).pathname
      .replace(/^\/functions\/v1/, "")
      .replace(/^\/v1-events/, "")
      .replace(/\/+$/, "") || "/";

  try {
    // ── /events ────────────────────────────────────────────────
    if (path === "/events" || path === "/") {
      if (req.method === "GET") {
        const { data, error: e } = await db
          .from("events")
          .select("id, name, starts_at, venue, capacity, min_tier_id, price, mode, created_at")
          .eq("org_id", orgId)
          .order("starts_at", { ascending: true });
        if (e) throw new AppError("db_error", e.message, 500);
        return ok({ events: data ?? [] });
      }
      if (req.method === "POST") {
        const body = await parseJson(req);
        const fields = pickEvent(body);
        if (!fields.name || typeof fields.name !== "string") {
          return error("validation_failed", "name é obrigatório", 422);
        }
        const { data, error: e } = await db
          .from("events")
          .insert({ ...fields, org_id: orgId })
          .select("id, name, starts_at, venue, capacity, min_tier_id, price, mode, created_at")
          .single();
        if (e) throw new AppError("db_error", e.message, 500);
        await db.from("audit_logs").insert({
          org_id: orgId, actor: "api:v1-events", action: "event.created", target: data!.id,
        });
        return created({ event: data });
      }
      return error("method_not_allowed", "Use GET ou POST", 405);
    }

    // ── /events/{id} (+ subrecursos) ───────────────────────────
    const evMatch = path.match(/^\/events\/([^/]+)(\/tickets|\/checkin)?$/);
    if (evMatch) {
      const eventId = evMatch[1];
      const sub = evMatch[2];
      if (!UUID.test(eventId)) return error("validation_failed", "id de evento inválido", 422);

      // O evento precisa existir DENTRO da org (filtra org_id sempre).
      const { data: event } = await db
        .from("events")
        .select("id, name, starts_at, venue, capacity, min_tier_id, price, mode, created_at")
        .eq("id", eventId)
        .eq("org_id", orgId)
        .maybeSingle();
      if (!event) return error("not_found", "Evento não encontrado", 404);

      // /events/{id}
      if (!sub) {
        if (req.method === "GET") return ok({ event });
        if (req.method === "PATCH") {
          const body = await parseJson(req);
          const fields = pickEvent(body);
          if (Object.keys(fields).length === 0) {
            return error("validation_failed", "Nenhum campo atualizável enviado", 422);
          }
          const { data, error: e } = await db
            .from("events")
            .update(fields)
            .eq("id", eventId)
            .eq("org_id", orgId)
            .select("id, name, starts_at, venue, capacity, min_tier_id, price, mode, created_at")
            .single();
          if (e) throw new AppError("db_error", e.message, 500);
          await db.from("audit_logs").insert({
            org_id: orgId, actor: "api:v1-events", action: "event.updated", target: eventId,
          });
          return ok({ event: data });
        }
        if (req.method === "DELETE") {
          const { error: e } = await db
            .from("events").delete().eq("id", eventId).eq("org_id", orgId);
          if (e) throw new AppError("db_error", e.message, 500);
          await db.from("audit_logs").insert({
            org_id: orgId, actor: "api:v1-events", action: "event.deleted", target: eventId,
          });
          return ok({ deleted: true, id: eventId });
        }
        return error("method_not_allowed", "Use GET, PATCH ou DELETE", 405);
      }

      // ── POST /events/{id}/tickets ────────────────────────────
      if (sub === "/tickets") {
        if (req.method !== "POST") return error("method_not_allowed", "Use POST", 405);
        const body = await parseJson(req);
        const ref = (body.member_id ?? body.memberId) as string | undefined;
        if (!ref) return error("validation_failed", "member_id é obrigatório", 422);

        const member = await findMember(db, orgId, ref);
        if (!member) return error("not_found", "Membro não encontrado", 404);

        // Capacidade: bloqueia se já atingiu o limite de tickets do evento.
        if (event.capacity != null) {
          const { count } = await db
            .from("tickets")
            .select("id", { count: "exact", head: true })
            .eq("org_id", orgId)
            .eq("event_id", eventId);
          if ((count ?? 0) >= Number(event.capacity)) {
            return error("capacity_reached", "Evento lotado", 409);
          }
        }

        // Billing: para eventos pagos, recomputa o breakdown server-side
        // (nunca confia em total do cliente). Eventos gratuitos → sem cobrança.
        let breakdown = null;
        const price = Number(event.price ?? 0);
        if (price > 0) {
          const method = (body.method as Method) ?? "pix";
          const installments = Number(body.installments ?? 1);
          const { data: settings } = await db
            .from("platform_billing_settings").select("*").eq("id", 1).single();
          breakdown = computeTransaction(
            price, method, installments, "one_time" as Period, settings as BillingSettings,
          );
        }

        // Gera o pass (type=ticket) e o ticket associado.
        const { data: pass, error: pe } = await db
          .from("passes")
          .insert({
            org_id: orgId, member_id: member.id, type: "ticket",
            serial: serial(), status: "active",
          })
          .select("id, serial, status")
          .single();
        if (pe) throw new AppError("db_error", pe.message, 500);

        const { data: ticket, error: te } = await db
          .from("tickets")
          .insert({
            org_id: orgId, event_id: eventId, member_id: member.id,
            status: "valid", pass_id: pass!.id,
          })
          .select("id, event_id, member_id, status, pass_id, created_at")
          .single();
        if (te) throw new AppError("db_error", te.message, 500);

        await db.from("interactions").insert({
          org_id: orgId, member_id: member.id, type: "event_ticket",
          title: "Ingresso emitido", detail: event.name,
        });
        await db.from("audit_logs").insert({
          org_id: orgId, actor: "api:v1-events", action: "ticket.issued", target: ticket!.id,
        });

        return created({ ticket, pass, breakdown });
      }

      // ── POST /events/{id}/checkin ────────────────────────────
      if (sub === "/checkin") {
        if (req.method !== "POST") return error("method_not_allowed", "Use POST", 405);
        const body = await parseJson(req);
        const ref = (body.member_id ?? body.memberId) as string | undefined;
        if (!ref) return error("validation_failed", "member_id é obrigatório", 422);
        const operator = (body.operator as string | undefined) ?? "api";

        const member = await findMember(db, orgId, ref);

        // Helper: registra o check-in (sempre, mesmo negado, para auditoria).
        const record = (result: string, ticketId: string | null) =>
          db.from("checkins").insert({
            org_id: orgId, event_id: eventId, member_id: member?.id ?? null,
            ticket_id: ticketId, operator, result,
          });

        if (!member) {
          await record("denied_member_not_found", null);
          return error("not_found", "Membro não encontrado", 404);
        }

        // Membro cancelado → vermelho (acesso negado).
        if (member.status === "canceled") {
          await record("denied_canceled", null);
          return error("access_denied", "Acesso negado: associação cancelada", 403, {
            color: "red", status: member.status,
          });
        }

        // Localiza um ticket do membro para este evento.
        const { data: tickets } = await db
          .from("tickets")
          .select("id, status, pass_id, created_at")
          .eq("org_id", orgId)
          .eq("event_id", eventId)
          .eq("member_id", member.id)
          .order("created_at", { ascending: false });

        const valid = (tickets ?? []).find((t) => t.status === "valid");
        const used = (tickets ?? []).find((t) => t.status === "used");

        // Anti-reuso: ticket já usado e nenhum válido restante → vermelho.
        if (!valid) {
          if (used) {
            await record("denied_ticket_used", used.id);
            return error("ticket_used", "Ingresso já utilizado", 409, {
              color: "red", ticket_id: used.id,
            });
          }
          await record("denied_no_ticket", null);
          return error("no_ticket", "Membro não possui ingresso para este evento", 403, {
            color: "red",
          });
        }

        // Consome o ticket (anti-reuso): valid → used + pass usado.
        await db.from("tickets").update({ status: "used" }).eq("id", valid.id).eq("org_id", orgId);
        if (valid.pass_id) {
          await db.from("passes").update({ status: "used" })
            .eq("id", valid.pass_id).eq("org_id", orgId);
        }

        // Grace: past_due passa com aviso (amarelo); ativo/reativado → verde.
        const isGrace =
          member.status === "past_due" ||
          (member.grace_period_ends_at != null &&
            new Date(member.grace_period_ends_at).getTime() >= Date.now());
        const result = isGrace ? "ok_grace" : "ok";
        const color = isGrace ? "yellow" : "green";

        await record(result, valid.id);
        await db.from("interactions").insert({
          org_id: orgId, member_id: member.id, type: "event_checkin",
          title: isGrace ? "Check-in (carência)" : "Check-in", detail: event.name,
        });
        await db.from("member_metrics")
          .update({ last_active_at: new Date().toISOString() })
          .eq("member_id", member.id).eq("org_id", orgId);
        await db.from("audit_logs").insert({
          org_id: orgId, actor: "api:v1-events", action: "checkin", target: valid.id,
        });

        return ok({
          checked_in: true,
          color,
          result,
          grace: isGrace,
          member_id: member.member_id,
          status: member.status,
          ticket_id: valid.id,
          event: { id: event.id, name: event.name },
        });
      }
    }

    return error("not_found", `Rota ${path} não encontrada`, 404);
  } catch (e) {
    if (e instanceof AppError) return error(e.code, e.message, e.status, e.details);
    return error("internal_error", "Erro interno", 500);
  }
});
