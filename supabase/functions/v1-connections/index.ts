// v1-connections — integrations / plug-in catalog (§20.1).
// Authenticated by API key (x-api-key → resolveAuth → orgId). The connections
// table is org-scoped; we run with the service role so EVERY query filters
// org_id explicitly. Secrets in `credentials` are never returned raw — they are
// masked on the way out.
//
// Routing is by method + path. The path is taken from new URL(req.url).pathname
// with the function name (`/v1-connections`) stripped.
//
//   GET  /connections                          → list org connections (masked)
//   POST /connect                              → connect a provider (provider + credentials)
//   POST /disconnect                           → disconnect a provider
//   POST /mapping                              → upsert/remove a tier→resource mapping
//   GET  /oauth/{provider}/callback            → OAuth callback stub (records connection only)
import { handlePreflight } from "../_shared/cors.ts";
import { ok, error, AppError } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { resolveAuth, type AuthContext } from "../_shared/auth.ts";
import { type SupabaseClient } from "@supabase/supabase-js";
import { getAdapter } from "../_shared/connectors/registry.ts";
import { encryptCredentials } from "../_shared/crypto.ts";
import { enqueueProvision } from "../_shared/provision.ts";

// ── helpers ────────────────────────────────────────────────────────
const FUNCTION_PREFIX = /^\/v1-connections/;

/** Strips the function name and trailing slashes, leaving the logical route. */
function routePath(req: Request): string {
  return new URL(req.url).pathname.replace(FUNCTION_PREFIX, "").replace(/\/+$/, "") || "/";
}

/**
 * Returns credentials with every value masked — safe to send to the client.
 * Stored values are AES-GCM ciphertext, so we NEVER echo them (neither the
 * ciphertext nor any derived substring). We only reveal which fields are
 * present, masking each value with a fixed placeholder.
 */
function maskCredentials(creds: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(creds ?? {})) out[k] = "••••";
  return out;
}

interface TierMapping {
  tierId: string;
  resource: string;
}

/** Shapes a DB row into the public Connection view (camelCase, masked secrets). */
function presentConnection(row: Record<string, any>) {
  return {
    id: row.id,
    orgId: row.org_id,
    provider: row.provider,
    status: row.status,
    accountLabel: row.account_label ?? "",
    connectedAt: row.connected_at,
    mappings: (row.mappings ?? []) as TierMapping[],
    credentials: maskCredentials(row.credentials),
  };
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new AppError("validation_failed", "JSON inválido", 400);
  }
}

// ── handlers ───────────────────────────────────────────────────────

/** GET /connections — list every connection for the authenticated org. */
async function listConnections(db: SupabaseClient, auth: AuthContext): Promise<Response> {
  const { data, error: dbErr } = await db
    .from("connections")
    .select("*")
    .eq("org_id", auth.orgId)
    .order("created_at", { ascending: true });
  if (dbErr) throw new AppError("internal_error", "Falha ao listar conexões", 500);
  return ok({ connections: (data ?? []).map(presentConnection) });
}

/**
 * POST /connect — connect (or reconnect) a provider.
 * Body: { provider, credentials?, accountLabel? }. Upserts on (org_id, provider).
 *
 * REAL flow: if the provider has an adapter we run adapter.verify() with the RAW
 * (plaintext) credentials. On failure → status=error, last_error stored, 422. On
 * success → credentials are AES-GCM encrypted (encryptCredentials) before storage,
 * status=connected, and account/verification metadata is stamped. Providers with
 * no adapter (none expected) fall back to storing the credentials as-is.
 * Secrets are masked from field keys on every response — ciphertext never leaks.
 */
async function connect(db: SupabaseClient, auth: AuthContext, body: any): Promise<Response> {
  const provider = String(body?.provider ?? "").trim();
  if (!provider) throw new AppError("validation_failed", "provider é obrigatório", 422);

  // RAW (plaintext) credentials from the request — only ever used to verify and
  // then encrypt; never stored or returned as-is once an adapter is present.
  const rawCredentials = (body?.credentials && typeof body.credentials === "object")
    ? body.credentials as Record<string, unknown>
    : {};
  const credentialsStr: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawCredentials)) credentialsStr[k] = String(v ?? "");

  const accountLabel = body?.accountLabel != null ? String(body.accountLabel) : null;
  const now = new Date().toISOString();

  const { data: existing } = await db
    .from("connections")
    .select("id, mappings, credentials, account_label")
    .eq("org_id", auth.orgId)
    .eq("provider", provider)
    .maybeSingle();

  const adapter = getAdapter(provider);

  // ── adapter path: verify with raw creds, then encrypt before storing ──
  if (adapter) {
    let verify;
    try {
      verify = await adapter.verify(credentialsStr);
    } catch (e) {
      verify = { ok: false, error: e instanceof Error ? e.message : "Falha ao verificar credenciais" };
    }

    if (verify.ok === false) {
      const lastError = verify.error ?? "Verificação falhou";
      // Persist the error state so the owner sees why the connection failed.
      if (existing) {
        await db
          .from("connections")
          .update({ status: "error", last_error: lastError })
          .eq("org_id", auth.orgId)
          .eq("provider", provider);
      } else {
        await db.from("connections").insert({
          org_id: auth.orgId,
          provider,
          status: "error",
          account_label: accountLabel,
          mappings: [],
          credentials: {},
          last_error: lastError,
        });
      }
      await db.from("audit_logs").insert({
        org_id: auth.orgId,
        actor: "api",
        action: "connection.verify_failed",
        target: provider,
      });
      throw new AppError("verification_failed", lastError, 422);
    }

    // Verified → encrypt (merged over existing ciphertext so a partial re-connect
    // doesn't wipe untouched secrets) and stamp verification metadata.
    const encrypted = await encryptCredentials(credentialsStr);
    const mergedCreds = { ...(existing?.credentials ?? {}), ...encrypted };
    const fields = {
      status: "connected",
      connected_at: now,
      credentials: mergedCreds,
      account_label: accountLabel ?? verify.accountLabel ?? existing?.account_label ?? null,
      external_account_id: verify.externalAccountId ?? null,
      last_verified_at: now,
      last_error: null,
    };

    let row: Record<string, any> | null = null;
    if (existing) {
      const { data, error: dbErr } = await db
        .from("connections")
        .update(fields)
        .eq("org_id", auth.orgId)
        .eq("provider", provider)
        .select("*")
        .single();
      if (dbErr) throw new AppError("internal_error", "Falha ao conectar", 500);
      row = data;
    } else {
      const { data, error: dbErr } = await db
        .from("connections")
        .insert({ org_id: auth.orgId, provider, mappings: [], ...fields })
        .select("*")
        .single();
      if (dbErr) throw new AppError("internal_error", "Falha ao conectar", 500);
      row = data;
    }

    await db.from("audit_logs").insert({
      org_id: auth.orgId,
      actor: "api",
      action: "connection.connected",
      target: provider,
    });
    return ok({ connection: presentConnection(row!) });
  }

  // ── no adapter (none expected): store credentials as-is (legacy path) ──
  let row: Record<string, any> | null = null;
  if (existing) {
    const mergedCreds = { ...(existing.credentials ?? {}), ...credentialsStr };
    const { data, error: dbErr } = await db
      .from("connections")
      .update({
        status: "connected",
        connected_at: now,
        credentials: mergedCreds,
        account_label: accountLabel ?? existing.account_label,
      })
      .eq("org_id", auth.orgId)
      .eq("provider", provider)
      .select("*")
      .single();
    if (dbErr) throw new AppError("internal_error", "Falha ao conectar", 500);
    row = data;
  } else {
    const { data, error: dbErr } = await db
      .from("connections")
      .insert({
        org_id: auth.orgId,
        provider,
        status: "connected",
        account_label: accountLabel,
        connected_at: now,
        mappings: [],
        credentials: credentialsStr,
      })
      .select("*")
      .single();
    if (dbErr) throw new AppError("internal_error", "Falha ao conectar", 500);
    row = data;
  }

  await db.from("audit_logs").insert({
    org_id: auth.orgId,
    actor: "api",
    action: "connection.connected",
    target: provider,
  });

  return ok({ connection: presentConnection(row!) });
}

/**
 * POST /disconnect — mark a provider as disconnected (keeps the row + mappings
 * so reconnecting restores config). Body: { provider }.
 *
 * After flipping the status we enqueue a `revoke` job for every active member of
 * the org whose tier maps to one of this connection's resources, so the perk is
 * pulled when the integration goes away. This is BEST-EFFORT — enqueue errors do
 * not fail the disconnect.
 */
async function disconnect(db: SupabaseClient, auth: AuthContext, body: any): Promise<Response> {
  const provider = String(body?.provider ?? "").trim();
  if (!provider) throw new AppError("validation_failed", "provider é obrigatório", 422);

  const { data, error: dbErr } = await db
    .from("connections")
    .update({ status: "disconnected", connected_at: null })
    .eq("org_id", auth.orgId)
    .eq("provider", provider)
    .select("*")
    .maybeSingle();
  if (dbErr) throw new AppError("internal_error", "Falha ao desconectar", 500);
  if (!data) throw new AppError("not_found", "Conexão não encontrada", 404);

  // Best-effort: enqueue revoke jobs for every active member on a mapped tier.
  try {
    const mappings = ((data.mappings ?? []) as TierMapping[]).filter((m) => m?.tierId && m?.resource);
    for (const mapping of mappings) {
      const { data: members } = await db
        .from("members")
        .select("id")
        .eq("org_id", auth.orgId)
        .eq("tier_id", mapping.tierId)
        .eq("status", "active");
      for (const member of members ?? []) {
        try {
          await enqueueProvision(db, {
            orgId: auth.orgId,
            provider,
            memberId: member.id,
            action: "revoke",
            resource: mapping.resource,
          });
        } catch {
          // swallow — one member's enqueue failure must not block disconnect.
        }
      }
    }
  } catch {
    // swallow — revoke fan-out is best-effort.
  }

  await db.from("audit_logs").insert({
    org_id: auth.orgId,
    actor: "api",
    action: "connection.disconnected",
    target: provider,
  });

  return ok({ connection: presentConnection(data) });
}

/**
 * POST /mapping — upsert a tier→resource mapping inside the connection's
 * mappings jsonb. An empty/absent `resource` removes the mapping for that tier.
 * Body: { provider, tierId, resource }.
 */
async function setMapping(db: SupabaseClient, auth: AuthContext, body: any): Promise<Response> {
  const provider = String(body?.provider ?? "").trim();
  const tierId = String(body?.tierId ?? "").trim();
  const resource = body?.resource != null ? String(body.resource).trim() : "";
  if (!provider) throw new AppError("validation_failed", "provider é obrigatório", 422);
  if (!tierId) throw new AppError("validation_failed", "tierId é obrigatório", 422);

  const { data: conn } = await db
    .from("connections")
    .select("mappings")
    .eq("org_id", auth.orgId)
    .eq("provider", provider)
    .maybeSingle();
  if (!conn) throw new AppError("not_found", "Conexão não encontrada", 404);

  // Confirm the tier belongs to this org (avoids cross-tenant mapping).
  const { data: tier } = await db
    .from("tiers")
    .select("id")
    .eq("org_id", auth.orgId)
    .eq("id", tierId)
    .maybeSingle();
  if (!tier) throw new AppError("not_found", "Tier não encontrado", 404);

  const current = ((conn.mappings ?? []) as TierMapping[]).filter((m) => m.tierId !== tierId);
  if (resource) current.push({ tierId, resource });

  const { data, error: dbErr } = await db
    .from("connections")
    .update({ mappings: current })
    .eq("org_id", auth.orgId)
    .eq("provider", provider)
    .select("*")
    .single();
  if (dbErr) throw new AppError("internal_error", "Falha ao salvar mapeamento", 500);

  await db.from("audit_logs").insert({
    org_id: auth.orgId,
    actor: "api",
    action: resource ? "connection.mapping_set" : "connection.mapping_removed",
    target: provider,
    payload: { tierId },
  });

  return ok({ connection: presentConnection(data) });
}

/**
 * GET /oauth/{provider}/callback — OAuth callback STUB. In production this would
 * exchange `code` for tokens; here it only records the connection as connected
 * so the front-end flow can be exercised end-to-end. No real token exchange.
 */
async function oauthCallback(
  db: SupabaseClient,
  auth: AuthContext,
  provider: string,
  url: URL,
): Promise<Response> {
  if (!provider) throw new AppError("validation_failed", "provider é obrigatório", 422);

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    await db
      .from("connections")
      .update({ status: "error" })
      .eq("org_id", auth.orgId)
      .eq("provider", provider);
    throw new AppError("oauth_failed", `Provedor retornou erro: ${oauthError}`, 400);
  }

  const now = new Date().toISOString();
  // We deliberately do NOT persist the raw `code`/`state` — no real exchange.
  const hasCode = Boolean(url.searchParams.get("code"));
  const accountLabel = url.searchParams.get("account_label");

  const { data: existing } = await db
    .from("connections")
    .select("id, account_label")
    .eq("org_id", auth.orgId)
    .eq("provider", provider)
    .maybeSingle();

  let row: Record<string, any> | null = null;
  if (existing) {
    const { data } = await db
      .from("connections")
      .update({
        status: "connected",
        connected_at: now,
        account_label: accountLabel ?? existing.account_label,
      })
      .eq("org_id", auth.orgId)
      .eq("provider", provider)
      .select("*")
      .single();
    row = data;
  } else {
    const { data } = await db
      .from("connections")
      .insert({
        org_id: auth.orgId,
        provider,
        status: "connected",
        account_label: accountLabel,
        connected_at: now,
        mappings: [],
        credentials: {},
      })
      .select("*")
      .single();
    row = data;
  }

  await db.from("audit_logs").insert({
    org_id: auth.orgId,
    actor: "oauth",
    action: "connection.oauth_callback",
    target: provider,
    payload: { stub: true, codePresent: hasCode },
  });

  return ok({ connection: presentConnection(row!), stub: true });
}

// ── entrypoint ──────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  const url = new URL(req.url);
  const path = routePath(req);
  const method = req.method.toUpperCase();
  const db = serviceClient();

  try {
    const auth = await resolveAuth(req, db);

    // GET /oauth/{provider}/callback
    const oauth = path.match(/^\/oauth\/([A-Za-z0-9_-]+)\/callback$/);
    if (oauth) {
      if (method !== "GET") throw new AppError("method_not_allowed", "Use GET", 405);
      return await oauthCallback(db, auth, oauth[1].toLowerCase(), url);
    }

    if (path === "/connections" && method === "GET") {
      return await listConnections(db, auth);
    }

    if (path === "/connect") {
      if (method !== "POST") throw new AppError("method_not_allowed", "Use POST", 405);
      return await connect(db, auth, await readJson(req));
    }

    if (path === "/disconnect") {
      if (method !== "POST") throw new AppError("method_not_allowed", "Use POST", 405);
      return await disconnect(db, auth, await readJson(req));
    }

    if (path === "/mapping") {
      if (method !== "POST") throw new AppError("method_not_allowed", "Use POST", 405);
      return await setMapping(db, auth, await readJson(req));
    }

    throw new AppError("not_found", `Rota ${method} ${path} não encontrada`, 404);
  } catch (e) {
    if (e instanceof AppError) return error(e.code, e.message, e.status, e.details);
    return error("internal_error", "Erro interno", 500);
  }
});
