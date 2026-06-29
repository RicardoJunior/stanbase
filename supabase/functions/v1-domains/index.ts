// v1-domains — domínio próprio do membership (§23.1.8) via Cloudflare for SaaS.
// Autenticado por API key (x-api-key → api_keys, via resolveAuth).
// Mounted at /functions/v1/v1-domains/*. Rotas (path = pathname após o nome da função):
//   GET    /                 → lista os domínios da org
//   POST   /                 → { host } cria custom_hostname no Cloudflare + grava a linha
//   POST   /{id}/verify      → consulta o status no Cloudflare e atualiza a linha
//   DELETE /{id}             → remove o custom_hostname no Cloudflare + a linha
//
// Secrets esperados (supabase secrets set …):
//   CF_API_TOKEN  — token com permissão SSL and Certificates: Edit na zona
//   CF_ZONE_ID    — zona que serve o app (onde mora o fallback origin)
// Sem esses secrets a função ainda persiste a linha (cf_hostname_id null) para o
// fluxo de demonstração — mas o SSL real só é emitido com o Cloudflare configurado.
//
// Service role bypassa RLS → SEMPRE filtra org_id explicitamente.
import { handlePreflight } from "../_shared/cors.ts";
import { ok, created, error, AppError } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { resolveAuth } from "../_shared/auth.ts";

type DomainStatus = "pending_dns" | "dns_ok" | "ssl_issued" | "active" | "error" | "disabled";

const CF_API = "https://api.cloudflare.com/client/v4";
const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Strips the deployed function name to get the resource path. "" → "/". */
function resourcePath(req: Request): string {
  const { pathname } = new URL(req.url);
  const stripped = pathname.replace(/^\/(functions\/v1\/)?v1-domains/, "").replace(/\/+$/, "");
  return stripped || "/";
}

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError("validation_failed", "JSON inválido", 400);
  }
  if (!isObject(body)) throw new AppError("validation_failed", "corpo deve ser um objeto JSON", 422);
  return body;
}

// ── Cloudflare for SaaS (Custom Hostnames) ───────────────────────────
function cfEnv(): { token: string; zone: string } | null {
  const token = Deno.env.get("CF_API_TOKEN");
  const zone = Deno.env.get("CF_ZONE_ID");
  if (!token || !zone) return null;
  return { token, zone };
}

async function cfFetch(cf: { token: string; zone: string }, path: string, init?: RequestInit) {
  const res = await fetch(`${CF_API}/zones/${cf.zone}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cf.token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.success === false) {
    const msg = payload?.errors?.[0]?.message ?? `Cloudflare respondeu ${res.status}`;
    throw new AppError("cloudflare_error", msg, 502, payload?.errors);
  }
  return payload.result;
}

/** Maps the Cloudflare custom_hostname status + ssl status into our state machine. */
function mapCfStatus(result: { status?: string; ssl?: { status?: string } }): DomainStatus {
  const host = result?.status;
  const ssl = result?.ssl?.status;
  if (host === "active" && ssl === "active") return "active";
  if (ssl === "active") return "ssl_issued";
  if (host === "active") return "dns_ok";
  return "pending_dns";
}

async function cfCreateHostname(cf: { token: string; zone: string }, host: string) {
  return await cfFetch(cf, "/custom_hostnames", {
    method: "POST",
    body: JSON.stringify({
      hostname: host,
      ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
    }),
  });
}

// ── data access (sempre filtra org_id) ───────────────────────────────
const SELECT = "id, org_id, host, target, status, cf_hostname_id, created_at";

const shape = (row: Record<string, unknown>) => ({
  id: row.id,
  orgId: row.org_id,
  host: row.host,
  target: row.target,
  status: row.status,
  cfHostnameId: row.cf_hostname_id,
  createdAt: row.created_at,
});

async function loadDomain(db: ReturnType<typeof serviceClient>, orgId: string, id: string) {
  const { data, error: dbErr } = await db
    .from("custom_domains")
    .select(SELECT)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (dbErr) throw new AppError("internal_error", "Falha ao carregar domínio", 500);
  if (!data) throw new AppError("not_found", "Domínio não encontrado", 404);
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

    // ── GET / ──────────────────────────────────────────────────────
    if (method === "GET" && path === "/") {
      const { data, error: dbErr } = await db
        .from("custom_domains")
        .select(SELECT)
        .eq("org_id", orgId)
        .order("created_at", { ascending: true });
      if (dbErr) throw new AppError("internal_error", "Falha ao listar domínios", 500);
      return ok({ domains: (data ?? []).map(shape) });
    }

    // ── POST / (adicionar domínio) ─────────────────────────────────
    if (method === "POST" && path === "/") {
      const body = await readJsonObject(req);
      const host = String(body.host ?? "").trim().toLowerCase();
      if (!HOST_RE.test(host)) {
        throw new AppError("validation_failed", "host inválido (ex.: membros.suacomunidade.com)", 422);
      }

      const cf = cfEnv();
      let cfHostnameId: string | null = null;
      let status: DomainStatus = "pending_dns";
      if (cf) {
        const result = await cfCreateHostname(cf, host);
        cfHostnameId = result?.id ?? null;
        status = mapCfStatus(result);
      }

      const { data, error: dbErr } = await db
        .from("custom_domains")
        .insert({ org_id: orgId, host, target: "member", status, cf_hostname_id: cfHostnameId })
        .select(SELECT)
        .single();
      if (dbErr) {
        if ((dbErr as { code?: string }).code === "23505") {
          throw new AppError("conflict", "Esse domínio já está em uso", 409);
        }
        throw new AppError("internal_error", "Falha ao gravar domínio", 500);
      }
      await db.from("audit_logs").insert({ org_id: orgId, actor: "api", action: "domain.added", target: host });
      return created(shape(data));
    }

    // ── POST /{id}/verify ──────────────────────────────────────────
    const verifyMatch = path.match(/^\/([0-9a-f-]{36})\/verify$/i);
    if (method === "POST" && verifyMatch) {
      const row = await loadDomain(db, orgId, verifyMatch[1]);
      const cf = cfEnv();

      let status: DomainStatus;
      let cfHostnameId = row.cf_hostname_id as string | null;
      let lastError: string | null = null;

      if (!cf) {
        // Sem Cloudflare configurado: avança a máquina de estados para demonstração.
        const order: DomainStatus[] = ["pending_dns", "dns_ok", "ssl_issued", "active"];
        const idx = order.indexOf(row.status as DomainStatus);
        status = order[Math.min(idx + 1, order.length - 1)] ?? "active";
        if (!cfHostnameId) cfHostnameId = `cf_local_${verifyMatch[1].slice(0, 8)}`;
      } else if (!cfHostnameId) {
        // Linha sem hostname no CF (criada offline) → cria agora.
        try {
          const result = await cfCreateHostname(cf, row.host as string);
          cfHostnameId = result?.id ?? null;
          status = mapCfStatus(result);
        } catch (e) {
          status = "error";
          lastError = e instanceof AppError ? e.message : "Falha ao criar hostname";
        }
      } else {
        try {
          const result = await cfFetch(cf, `/custom_hostnames/${cfHostnameId}`);
          status = mapCfStatus(result);
        } catch (e) {
          status = "error";
          lastError = e instanceof AppError ? e.message : "Falha ao consultar hostname";
        }
      }

      const { data, error: dbErr } = await db
        .from("custom_domains")
        .update({
          status,
          cf_hostname_id: cfHostnameId,
          dns_checked_at: new Date().toISOString(),
          last_error: lastError,
        })
        .eq("id", row.id)
        .eq("org_id", orgId)
        .select(SELECT)
        .single();
      if (dbErr) throw new AppError("internal_error", "Falha ao atualizar domínio", 500);
      return ok(shape(data));
    }

    // ── DELETE /{id} ───────────────────────────────────────────────
    const idMatch = path.match(/^\/([0-9a-f-]{36})$/i);
    if (method === "DELETE" && idMatch) {
      const row = await loadDomain(db, orgId, idMatch[1]);
      const cf = cfEnv();
      if (cf && row.cf_hostname_id) {
        // best-effort: não bloqueia a remoção local se o CF já não tem o hostname.
        try {
          await cfFetch(cf, `/custom_hostnames/${row.cf_hostname_id}`, { method: "DELETE" });
        } catch {
          /* ignore — segue removendo a linha */
        }
      }
      const { error: dbErr } = await db.from("custom_domains").delete().eq("id", row.id).eq("org_id", orgId);
      if (dbErr) throw new AppError("internal_error", "Falha ao remover domínio", 500);
      await db.from("audit_logs").insert({ org_id: orgId, actor: "api", action: "domain.removed", target: row.host });
      return ok({ id: row.id, removed: true });
    }

    if (!["GET", "POST", "DELETE"].includes(method)) {
      return error("method_not_allowed", `Método ${method} não permitido`, 405);
    }
    return error("not_found", `Rota ${method} ${path} não encontrada`, 404);
  } catch (e) {
    if (e instanceof AppError) return error(e.code, e.message, e.status, e.details);
    return error("internal_error", "Erro inesperado", 500);
  }
});
