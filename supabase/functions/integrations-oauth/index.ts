// integrations-oauth — the server-side OAuth dance for oauth-kind providers (§19).
// PUBLIC function: verify_jwt=false. There is NO API key here — the org identity
// travels inside the signed/one-time `state` row (oauth_states), not in a header,
// so the provider can redirect the browser back to us without our auth.
//
// Runs with the service role and filters org_id explicitly (from the state row).
// Secrets returned by the token exchange are AES-GCM encrypted before they touch
// the DB (see _shared/crypto.ts). Routes (path = pathname after the function name):
//
//   GET /start/{provider}?org={orgId}&redirect={url}
//        → mint state (+PKCE verifier/challenge when usesPkce), persist oauth_states,
//          302 redirect the browser to the provider's consent URL.
//   GET /callback/{provider}?code&state
//        → consume the one-time state, exchange `code` for tokens, upsert the
//          connection as `connected`, then 302 back to `redirect_to` with
//          ?connected=provider (or ?error=… on failure).
import { handlePreflight, corsHeaders } from "../_shared/cors.ts";
import { error, AppError } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { encryptCredentials } from "../_shared/crypto.ts";
import { getAdapter } from "../_shared/connectors/registry.ts";
import { oauthClient, type ProviderAdapter } from "../_shared/connectors/types.ts";
import { type SupabaseClient } from "@supabase/supabase-js";

// ── helpers ────────────────────────────────────────────────────────
const FUNCTION_PREFIX = /^\/integrations-oauth/;
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_REDIRECT = "/";

/** Strips the function name and trailing slashes, leaving the logical route. */
function routePath(req: Request): string {
  return new URL(req.url).pathname.replace(FUNCTION_PREFIX, "").replace(/\/+$/, "") || "/";
}

/** base64url (no padding) of an ArrayBuffer/Uint8Array. */
function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A random URL-safe PKCE code_verifier (RFC 7636: 43–128 chars). 64 chars here. */
function randomCodeVerifier(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const rnd = crypto.getRandomValues(new Uint8Array(64));
  let out = "";
  for (const n of rnd) out += alphabet[n % alphabet.length];
  return out;
}

/** S256 challenge: base64url(SHA-256(verifier)). */
async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(digest);
}

/** Resolve the adapter and assert it supports OAuth, else 404/422. */
function requireOAuthAdapter(provider: string): ProviderAdapter {
  const adapter = getAdapter(provider);
  if (!adapter) throw new AppError("not_found", `Provider sem adapter: ${provider}`, 404);
  if (!adapter.oauth) throw new AppError("validation_failed", `Provider ${provider} não usa OAuth`, 422);
  return adapter;
}

/** Where the provider must redirect back to (must be identical on start + callback). */
function callbackRedirectUri(provider: string): string {
  const base = (Deno.env.get("PUBLIC_FUNCTIONS_URL") ?? "").replace(/\/+$/, "");
  return `${base}/integrations-oauth/callback/${provider}`;
}

/** A 302 redirect with CORS headers. */
function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { ...corsHeaders, Location: location } });
}

/** Append a query param to a (possibly already-query'd) URL. */
function withParam(target: string, key: string, value: string): string {
  const sep = target.includes("?") ? "&" : "?";
  return `${target}${sep}${key}=${encodeURIComponent(value)}`;
}

// ── handlers ───────────────────────────────────────────────────────

/**
 * GET /start/{provider}?org={orgId}&redirect={url}
 * Mints state (+PKCE when the adapter requires it), persists it, and 302s the
 * browser to the provider's consent screen.
 */
async function start(
  db: SupabaseClient,
  provider: string,
  url: URL,
): Promise<Response> {
  const adapter = requireOAuthAdapter(provider);

  const orgId = (url.searchParams.get("org") ?? "").trim();
  if (!orgId) throw new AppError("validation_failed", "org é obrigatório", 422);
  const redirect = (url.searchParams.get("redirect") ?? "").trim() || DEFAULT_REDIRECT;

  const state = crypto.randomUUID();
  let codeVerifier: string | null = null;
  let codeChallenge: string | undefined;
  if (adapter.oauth!.usesPkce) {
    codeVerifier = randomCodeVerifier();
    codeChallenge = await codeChallengeFor(codeVerifier);
  }

  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();
  const { error: dbErr } = await db.from("oauth_states").insert({
    state,
    org_id: orgId,
    provider,
    code_verifier: codeVerifier,
    redirect_to: redirect,
    expires_at: expiresAt,
  });
  if (dbErr) throw new AppError("internal_error", "Falha ao iniciar OAuth", 500);

  const redirectUri = callbackRedirectUri(provider);
  const { clientId } = oauthClient(provider);
  const authorizeUrl = adapter.oauth!.authorizeUrl({ state, redirectUri, codeChallenge, clientId });

  return redirectTo(authorizeUrl);
}

/**
 * GET /callback/{provider}?code&state
 * Consumes the one-time state, exchanges the code, upserts the connection, and
 * 302s back to the caller's redirect_to. Any failure redirects with ?error=….
 */
async function callback(
  db: SupabaseClient,
  provider: string,
  url: URL,
): Promise<Response> {
  // We can't redirect with the caller's redirect_to until we load the state row,
  // so fall back to DEFAULT_REDIRECT for pre-state errors.
  let redirectBase = DEFAULT_REDIRECT;
  try {
    const adapter = requireOAuthAdapter(provider);

    const providerError = url.searchParams.get("error");
    const state = (url.searchParams.get("state") ?? "").trim();
    const code = (url.searchParams.get("code") ?? "").trim();
    if (!state) throw new AppError("validation_failed", "state ausente", 400);

    // Load + immediately consume (one-time) the state row, scoped to provider.
    const { data: row, error: loadErr } = await db
      .from("oauth_states")
      .select("state, org_id, provider, code_verifier, redirect_to, expires_at")
      .eq("state", state)
      .eq("provider", provider)
      .maybeSingle();
    if (loadErr) throw new AppError("internal_error", "Falha ao validar state", 500);
    if (!row) throw new AppError("not_found", "state inválido ou expirado", 404);

    // Burn the state row regardless of outcome (one-time use, no replay).
    await db.from("oauth_states").delete().eq("state", state);

    redirectBase = row.redirect_to || DEFAULT_REDIRECT;

    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new AppError("validation_failed", "state expirado", 400);
    }
    if (providerError) {
      throw new AppError("oauth_failed", `Provedor retornou erro: ${providerError}`, 400);
    }
    if (!code) throw new AppError("validation_failed", "code ausente", 400);

    const redirectUri = callbackRedirectUri(provider);
    const result = await adapter.oauth!.exchangeCode({
      code,
      redirectUri,
      codeVerifier: row.code_verifier ?? undefined,
    });

    const now = new Date().toISOString();
    const encrypted = await encryptCredentials(result.credentials ?? {});

    // Upsert on (org_id, provider) — the table's unique constraint.
    const { error: upsertErr } = await db
      .from("connections")
      .upsert(
        {
          org_id: row.org_id,
          provider,
          status: "connected",
          connected_at: now,
          account_label: result.accountLabel ?? null,
          external_account_id: result.externalAccountId ?? null,
          token_expires_at: result.expiresAt ?? null,
          last_verified_at: now,
          last_error: null,
          credentials: encrypted,
        },
        { onConflict: "org_id,provider" },
      );
    if (upsertErr) throw new AppError("internal_error", "Falha ao salvar conexão", 500);

    await db.from("audit_logs").insert({
      org_id: row.org_id,
      actor: "oauth",
      action: "connection.oauth_connected",
      target: provider,
    });

    return redirectTo(withParam(redirectBase, "connected", provider));
  } catch (e) {
    const message = e instanceof AppError ? e.message : "Falha no OAuth";
    return redirectTo(withParam(redirectBase, "error", message));
  }
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
    const startMatch = path.match(/^\/start\/([A-Za-z0-9_-]+)$/);
    if (startMatch) {
      if (method !== "GET") throw new AppError("method_not_allowed", "Use GET", 405);
      return await start(db, startMatch[1].toLowerCase(), url);
    }

    const callbackMatch = path.match(/^\/callback\/([A-Za-z0-9_-]+)$/);
    if (callbackMatch) {
      if (method !== "GET") throw new AppError("method_not_allowed", "Use GET", 405);
      return await callback(db, callbackMatch[1].toLowerCase(), url);
    }

    throw new AppError("not_found", `Rota ${method} ${path} não encontrada`, 404);
  } catch (e) {
    if (e instanceof AppError) return error(e.code, e.message, e.status, e.details);
    return error("internal_error", "Erro interno", 500);
  }
});
