// Provider adapter contract — the uniform interface every real integration
// implements. The framework (§19) is generic plumbing: it stores encrypted
// Connections, resolves Mappings (tier→external resource), and calls these hooks.
// An adapter NEVER knows membership rules — it only talks to its provider's API.
//
// Each provider lives in `_shared/connectors/<provider>.ts` and exports
// `export const <provider>Adapter: ProviderAdapter = { ... }`.

export type AuthKind = "oauth" | "api_key" | "bot" | "manual";

/** Result of verifying credentials with a real test call to the provider. */
export interface VerifyResult {
  ok: boolean;
  /** human label for the connected account (e.g. "Servidor Aurora", "@aurora"). */
  accountLabel?: string;
  /** stable external id of the connected account (guild id, channel id, …). */
  externalAccountId?: string;
  /** failure reason (shown to the owner) when ok=false. */
  error?: string;
}

/** A member to (de)provision, with the external ids resolved from their auth identities/profile. */
export interface ProvisionMember {
  id: string;
  /** provider→external id (e.g. { discord: "1234", telegram: "987" }) from Supabase Auth identities / profile. */
  externalIds: Record<string, string>;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
}

/** Everything an adapter needs to grant/revoke one perk for one member. */
export interface ProvisionContext {
  orgId: string;
  member: ProvisionMember;
  /** the mapped external resource for the member's tier (role id, chat id, list id, …). */
  resource: string;
  /** decrypted provider credentials for this org's connection. */
  credentials: Record<string, string>;
}

export interface ProvisionResult {
  ok: boolean;
  error?: string;
  /** true → transient failure, the queue should retry; false → permanent, give up. */
  retryable?: boolean;
}

/** Tokens/labels returned after an OAuth code exchange. */
export interface OAuthExchangeResult {
  credentials: Record<string, string>;
  accountLabel?: string;
  externalAccountId?: string;
  /** ISO timestamp when the access token expires (for refresh). */
  expiresAt?: string;
}

/** A provider webhook event normalized to the framework's vocabulary. */
export interface NormalizedEvent {
  type: string; // e.g. "member.left", "subscription.updated"
  externalAccountId?: string;
  externalMemberId?: string;
  raw?: unknown;
}

export interface OAuthSupport {
  /** PKCE-capable providers return true so the framework generates a code_verifier. */
  usesPkce?: boolean;
  scopes: string[];
  /** Build the provider consent URL the member/owner is redirected to. */
  authorizeUrl(args: { state: string; redirectUri: string; codeChallenge?: string; clientId: string }): string;
  /** Exchange the auth code for tokens (server-side). */
  exchangeCode(args: { code: string; redirectUri: string; codeVerifier?: string }): Promise<OAuthExchangeResult>;
  /** Refresh an expired access token, if the provider supports it. */
  refresh?(creds: Record<string, string>): Promise<OAuthExchangeResult>;
}

export interface WebhookSupport {
  /** Verify the provider's signature over the raw body (HMAC/timestamp). */
  verifySignature(args: { req: Request; rawBody: string; credentials: Record<string, string> }): Promise<boolean> | boolean;
  /** Normalize the raw payload into framework events. */
  parse(rawBody: string): Promise<NormalizedEvent[]> | NormalizedEvent[];
}

export interface ProviderAdapter {
  provider: string;
  authKind: AuthKind;
  /** Confirm the credentials work (real API call). Required for every adapter. */
  verify(credentials: Record<string, string>): Promise<VerifyResult>;
  /** Provision the perk for a member (idempotent). Omit if the provider has no provisioning. */
  grant?(ctx: ProvisionContext): Promise<ProvisionResult>;
  /** Deprovision the perk for a member (idempotent). */
  revoke?(ctx: ProvisionContext): Promise<ProvisionResult>;
  /** OAuth flow (for authKind "oauth"). The client id/secret come from env (platform-level). */
  oauth?: OAuthSupport;
  /** Inbound webhook handling + signature verification. */
  webhook?: WebhookSupport;
}

/** Small fetch helper: throws on non-2xx with the provider's message. */
export async function api(
  url: string,
  init: RequestInit & { provider: string },
): Promise<any> {
  const { provider, ...rest } = init;
  const res = await fetch(url, rest);
  const text = await res.text();
  let body: any = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body?.message ?? body?.error?.message ?? body?.error_description ?? body?.error ?? `${provider} respondeu ${res.status}`;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    (err as any).status = res.status;
    (err as any).body = body;
    throw err;
  }
  return body;
}

/** Reads a platform OAuth client credential pair from env, e.g. OAUTH_TWITCH_CLIENT_ID. */
export function oauthClient(provider: string): { clientId: string; clientSecret: string } {
  const up = provider.toUpperCase();
  const clientId = Deno.env.get(`OAUTH_${up}_CLIENT_ID`) ?? "";
  const clientSecret = Deno.env.get(`OAUTH_${up}_CLIENT_SECRET`) ?? "";
  return { clientId, clientSecret };
}
