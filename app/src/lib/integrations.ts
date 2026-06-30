/**
 * Integrations client — the REAL backend twin of the lib/api.ts integration
 * mock (connectIntegration / disconnectIntegration / setTierMapping /
 * listConnections). When `hasBackend()`, these call the Edge `v1-connections`
 * function with the org API key (x-api-key), mirroring the auth/base-url pattern
 * already established in lib/api.remote.ts (callFunction → x-api-key header).
 *
 * Auth: the same API key model the `/v1-*` resource functions use server-side
 * (see functions/_shared/auth.ts → resolveAuth → orgId). The key is read from
 * VITE_ORG_API_KEY at build time; when it (or the backend) is absent the screen
 * stays on the localStorage mock (offline demo) untouched.
 *
 * Contract notes:
 *  - connect throws with the REAL verification error message when the provider
 *    rejects the credentials, so the dialog can surface it.
 *  - oauth providers do NOT post credentials: the caller redirects the browser
 *    to startOAuth(...) and the provider's callback records the connection.
 */
import { callFunction } from "@/lib/api.remote";
import { FUNCTIONS_URL } from "@/lib/supabase";
import type { Connection } from "@/types/domain";

/**
 * Org API key for the `/v1-*` resource functions (sent as x-api-key — the same
 * header api.remote.ts already wires through callFunction). Read from env so the
 * key never lives in the store; absent in prototype mode.
 */
const ORG_API_KEY = import.meta.env.VITE_ORG_API_KEY as string | undefined;

/** True when both the functions URL and an org API key are configured. */
export const hasIntegrationsBackend = (): boolean => !!FUNCTIONS_URL && !!ORG_API_KEY;

/** Shared options for every v1-connections call: org-scoped x-api-key auth. */
type Row = Record<string, any>;
function authed(method: string, body?: unknown) {
  return { method, apiKey: ORG_API_KEY, ...(body !== undefined ? { body } : {}) };
}

/** Shapes a v1-connections row (camelCase, masked secrets) into the domain Connection. */
function shapeConnection(c: Row): Connection {
  return {
    id: c.id,
    orgId: c.orgId,
    provider: c.provider,
    status: c.status,
    accountLabel: c.accountLabel ?? "",
    connectedAt: c.connectedAt ?? null,
    mappings: (c.mappings ?? []).map((m: Row) => ({ tierId: m.tierId, resource: m.resource })),
    credentials: c.credentials ?? {},
  };
}

/** GET /v1-connections/connections — list the org's connections (masked secrets). */
export async function listConnections(_orgId: string): Promise<Connection[]> {
  const res = await callFunction("v1-connections/connections", authed("GET"));
  return ((res.connections ?? []) as Row[]).map(shapeConnection);
}

/**
 * POST /v1-connections/connect — connect (or reconnect) an api_key/bot/manual
 * provider with REAL credentials. Returns the connection, or throws with the
 * provider's verification error message (callFunction surfaces data.error.message).
 */
export async function connectIntegration(
  _orgId: string,
  provider: string,
  credentials: Record<string, string>,
  accountLabel?: string,
): Promise<Connection> {
  const res = await callFunction(
    "v1-connections/connect",
    authed("POST", { provider, credentials, accountLabel }),
  );
  return shapeConnection(res.connection ?? {});
}

/** POST /v1-connections/disconnect — mark a provider disconnected (keeps mappings). */
export async function disconnectIntegration(_orgId: string, provider: string): Promise<Connection> {
  const res = await callFunction("v1-connections/disconnect", authed("POST", { provider }));
  return shapeConnection(res.connection ?? {});
}

/** POST /v1-connections/mapping — upsert/remove a tier→resource mapping. */
export async function setTierMapping(
  _orgId: string,
  provider: string,
  tierId: string,
  resource: string,
): Promise<Connection> {
  const res = await callFunction(
    "v1-connections/mapping",
    authed("POST", { provider, tierId, resource }),
  );
  return shapeConnection(res.connection ?? {});
}

/**
 * Builds the OAuth start URL the caller opens (window.location or a popup). The
 * provider redirects back to `redirect` after consent, and the callback records
 * the connection. Defaults `redirect` to the current page so the user returns to
 * the integrations screen.
 */
export function startOAuth(provider: string, orgId: string, redirect?: string): string {
  if (!FUNCTIONS_URL) throw new Error("VITE_FUNCTIONS_URL não configurado.");
  const back = redirect ?? (typeof window !== "undefined" ? window.location.href : "");
  const qs = new URLSearchParams({ org: orgId, redirect: back });
  return `${FUNCTIONS_URL}/integrations-oauth/start/${encodeURIComponent(provider)}?${qs.toString()}`;
}
