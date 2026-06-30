// integrations-webhook — inbound provider webhooks (§19/§20.1).
//
// PUBLIC endpoint (verify_jwt=false): providers POST signed payloads here, so
// there is no Supabase JWT and no x-api-key. We authenticate the *payload* with
// the provider's own signature, verified against the org's decrypted credentials.
//
// Routing is by method + the single `{provider}` path segment after the function
// name. The provider's adapter (registry) supplies signature verification +
// payload normalization; an adapter with no `.webhook` has nothing to receive,
// so we 404.
//
//   POST /{provider}     → verify signature → log event → normalize → enqueue revokes
//   GET  /{provider}     → Meta/WhatsApp hub.challenge verification handshake
//
// Resolving the org: webhooks arrive un-authenticated, so we must map the request
// to ONE connection (org_id, provider) before we can verify the signature.
//   1. ?org={orgId}                        — explicit, preferred
//   2. a provider-specific external account id (?account=… / hub-derived / body)
//      matched against connections.external_account_id.
// With the connection found, we decrypt its credentials and hand them to the
// adapter. We ALWAYS answer 200 quickly on the happy path — providers treat any
// non-200 as a failure and retry (sometimes aggressively), so the only non-200s
// we emit are 404 (unknown/unsupported provider) and 401 (bad signature).
import { handlePreflight } from "../_shared/cors.ts";
import { ok, error } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { getAdapter } from "../_shared/connectors/registry.ts";
import { decryptCredentials } from "../_shared/crypto.ts";
import { enqueueProvision, memberExternalIds } from "../_shared/provision.ts";
import type { NormalizedEvent } from "../_shared/connectors/types.ts";
import { type SupabaseClient } from "@supabase/supabase-js";

const FUNCTION_PREFIX = /^\/integrations-webhook/;

/** Strips the function name + trailing slashes, leaving "/{provider}" or "/". */
function routePath(req: Request): string {
  return new URL(req.url).pathname.replace(FUNCTION_PREFIX, "").replace(/\/+$/, "") || "/";
}

/** First path segment after the function name, lower-cased ("" if absent). */
function providerFromPath(path: string): string {
  const m = path.match(/^\/([A-Za-z0-9_-]+)/);
  return m ? m[1].toLowerCase() : "";
}

/** JSON.parse that never throws — webhook bodies may be non-JSON / truncated. */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface ConnectionRow {
  id: string;
  org_id: string;
  provider: string;
  credentials: Record<string, string> | null;
  external_account_id: string | null;
}

/**
 * Resolve the connection (org_id, provider) this webhook belongs to.
 *  - ?org={orgId}: load that org's connection for the provider (single row).
 *  - else if an external account id is known (query/header/body-derived): match
 *    connections.external_account_id for the provider.
 * Returns null when no single connection can be identified.
 */
async function resolveConnection(
  db: SupabaseClient,
  provider: string,
  orgId: string | null,
  externalAccountId: string | null,
): Promise<ConnectionRow | null> {
  const cols = "id, org_id, provider, credentials, external_account_id";

  if (orgId) {
    const { data } = await db
      .from("connections")
      .select(cols)
      .eq("provider", provider)
      .eq("org_id", orgId)
      .maybeSingle();
    return (data as ConnectionRow) ?? null;
  }

  if (externalAccountId) {
    const { data } = await db
      .from("connections")
      .select(cols)
      .eq("provider", provider)
      .eq("external_account_id", externalAccountId)
      .limit(1)
      .maybeSingle();
    return (data as ConnectionRow) ?? null;
  }

  return null;
}

/** Pull a candidate external account id from query, common Meta headers, or body. */
function externalAccountHint(url: URL, payload: unknown): string | null {
  const q = url.searchParams.get("account") ?? url.searchParams.get("account_id");
  if (q) return q;
  // Meta/WhatsApp: entry[].changes[].value.metadata.phone_number_id (or entry[].id).
  const p = payload as any;
  const entry = Array.isArray(p?.entry) ? p.entry[0] : undefined;
  const phoneId = entry?.changes?.[0]?.value?.metadata?.phone_number_id;
  if (typeof phoneId === "string") return phoneId;
  if (typeof entry?.id === "string") return entry.id;
  return null;
}

/**
 * Best-effort reverse lookup: given a provider-specific member id from a normalized
 * event, find the matching Stanbase member in this org. There is no reverse RPC, so
 * we scan the org's members and compare their linked external ids — bounded by a cap
 * so a busy webhook can never trigger an unbounded scan.
 */
async function resolveMemberId(
  db: SupabaseClient,
  orgId: string,
  provider: string,
  externalMemberId: string | undefined,
): Promise<string | null> {
  if (!externalMemberId) return null;
  const { data: members } = await db
    .from("members")
    .select("id")
    .eq("org_id", orgId)
    .not("user_id", "is", null)
    .limit(500);
  if (!members?.length) return null;

  for (const m of members as { id: string }[]) {
    const ids = await memberExternalIds(db, m.id);
    if (ids[provider] && ids[provider] === externalMemberId) return m.id;
  }
  return null;
}

/** A normalized event type that means the member is no longer entitled. */
function isMemberLeft(type: string): boolean {
  const t = type.toLowerCase();
  return (
    t === "member.left" ||
    t === "member.removed" ||
    t === "member.banned" ||
    t === "subscription.canceled" ||
    t === "subscription.cancelled" ||
    t === "subscription.deleted"
  );
}

// ── GET handshake (Meta/WhatsApp subscribe verification) ────────────
// Meta confirms a webhook by GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
// We echo hub.challenge as plain text iff the token matches the connection's
// stored verify_token. The connection is resolved by ?org or the hub query.
async function handleHandshake(
  db: SupabaseClient,
  provider: string,
  url: URL,
): Promise<Response> {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode !== "subscribe" || !token || challenge == null) {
    return error("validation_failed", "Handshake inválido", 400);
  }

  const orgId = url.searchParams.get("org");
  const accountHint = url.searchParams.get("account") ?? url.searchParams.get("account_id");
  const conn = await resolveConnection(db, provider, orgId, accountHint);
  if (!conn) return error("not_found", "Conexão não encontrada", 404);

  const creds = await decryptCredentials(conn.credentials);
  const expected = creds.verify_token ?? creds.webhook_verify_token;
  if (!expected || expected !== token) {
    return error("unauthorized", "verify_token inválido", 401);
  }

  // Plain-text challenge echo — Meta requires the raw value, not JSON.
  return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

// ── POST inbound webhook ────────────────────────────────────────────
async function handleWebhook(
  db: SupabaseClient,
  provider: string,
  req: Request,
  url: URL,
  webhook: NonNullable<ReturnType<typeof getAdapter>>["webhook"],
): Promise<Response> {
  const rawBody = await req.text();
  const payload = safeJsonParse(rawBody);

  const orgId = url.searchParams.get("org");
  const accountHint = externalAccountHint(url, payload);
  const conn = await resolveConnection(db, provider, orgId, accountHint);

  // No connection → we can't verify; log the unverifiable attempt (org_id null is
  // allowed) and 200 so the provider stops retrying a payload we can't place.
  if (!conn) {
    await db.from("integration_events").insert({
      provider,
      org_id: null,
      event_type: null,
      external_account_id: accountHint,
      signature_ok: false,
      payload: payload ?? null,
    });
    return ok({ received: true, resolved: false });
  }

  const credentials = await decryptCredentials(conn.credentials);

  let signatureOk = false;
  try {
    signatureOk = await webhook!.verifySignature({ req, rawBody, credentials });
  } catch {
    signatureOk = false;
  }

  // One audit row per delivery, recording the verification outcome.
  await db.from("integration_events").insert({
    provider,
    org_id: conn.org_id,
    event_type: null,
    external_account_id: conn.external_account_id ?? accountHint,
    signature_ok: signatureOk,
    payload: payload ?? null,
  });

  if (!signatureOk) return error("unauthorized", "Assinatura inválida", 401);

  // Normalize and act. Parsing/enqueue failures must never bubble a non-200 to
  // the provider (it would just retry the same already-verified payload), so we
  // process each event defensively.
  let events: NormalizedEvent[] = [];
  try {
    events = await webhook!.parse(rawBody);
  } catch {
    events = [];
  }

  let revokesEnqueued = 0;
  for (const ev of events) {
    // Persist the normalized event type alongside its external ids for reconcile.
    await db.from("integration_events").insert({
      provider,
      org_id: conn.org_id,
      event_type: ev.type,
      external_account_id: ev.externalAccountId ?? conn.external_account_id ?? accountHint,
      external_member_id: ev.externalMemberId ?? null,
      signature_ok: true,
      payload: (ev.raw ?? null) as any,
    });

    if (!isMemberLeft(ev.type)) continue;

    const memberId = await resolveMemberId(db, conn.org_id, provider, ev.externalMemberId);
    if (!memberId) continue;

    // The member left the provider's space → revoke their perks for this provider.
    // resource "" => the provision worker revokes across this provider's mappings.
    await enqueueProvision(db, {
      orgId: conn.org_id,
      provider,
      memberId,
      action: "revoke",
      resource: "",
      payload: { reason: ev.type, via: "webhook" },
    });
    revokesEnqueued++;
  }

  return ok({ received: true, events: events.length, revokesEnqueued });
}

// ── entrypoint ──────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  const url = new URL(req.url);
  const path = routePath(req);
  const method = req.method.toUpperCase();
  const provider = providerFromPath(path);
  const db = serviceClient();

  try {
    if (!provider) return error("not_found", "Provider ausente na rota", 404);

    const adapter = getAdapter(provider);
    if (!adapter?.webhook) {
      return error("not_found", `Provider ${provider} não recebe webhooks`, 404);
    }

    if (method === "GET") {
      return await handleHandshake(db, provider, url);
    }
    if (method === "POST") {
      return await handleWebhook(db, provider, req, url, adapter.webhook);
    }
    return error("method_not_allowed", "Use GET (handshake) ou POST", 405);
  } catch {
    // Defensive catch-all. For POST we still return 200 so the provider doesn't
    // hammer us retrying an error it can't fix; GET/other surface a 500.
    if (method === "POST") return ok({ received: true, error: true });
    return error("internal_error", "Erro interno", 500);
  }
});
