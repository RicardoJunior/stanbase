// Mailchimp adapter — Marketing API v3. authKind 'api_key'.
// creds: api_key (form 'key-usXX'), audience_id (the list to manage).
// The data center (dc) is the suffix of the api key; the API host is derived from it.
import type {
  ProviderAdapter,
  VerifyResult,
  ProvisionContext,
  ProvisionResult,
} from "./types.ts";
import { api } from "./types.ts";
import { crypto as stdCrypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";

function dcOf(apiKey: string): string {
  return apiKey.split("-")[1] ?? "";
}

function baseOf(apiKey: string): string {
  return `https://${dcOf(apiKey)}.api.mailchimp.com/3.0`;
}

function authHeader(apiKey: string): Record<string, string> {
  return { Authorization: "Basic " + btoa("stanbase:" + apiKey) };
}

/** Mailchimp subscriber hash = hex(md5(lowercased email)). */
async function subscriberHash(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await stdCrypto.subtle.digest("MD5", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isRetryable(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  if (status === undefined) return true; // network / no response → retry
  return status === 429 || status >= 500;
}

export const mailchimpAdapter: ProviderAdapter = {
  provider: "mailchimp",
  authKind: "api_key",

  async verify(credentials: Record<string, string>): Promise<VerifyResult> {
    const apiKey = credentials.api_key ?? "";
    if (!dcOf(apiKey)) {
      return { ok: false, error: "api_key inválida (esperado formato 'chave-usXX')" };
    }
    try {
      const body = await api(`${baseOf(apiKey)}/`, {
        provider: "mailchimp",
        method: "GET",
        headers: authHeader(apiKey),
      });
      return {
        ok: true,
        accountLabel: body?.account_name,
        externalAccountId: body?.account_id,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async grant(ctx: ProvisionContext): Promise<ProvisionResult> {
    const apiKey = ctx.credentials.api_key ?? "";
    const audienceId = ctx.credentials.audience_id ?? "";
    const email = ctx.member.email;
    if (!email) {
      return { ok: false, error: "membro sem e-mail", retryable: false };
    }
    try {
      const hash = await subscriberHash(email);
      const base = baseOf(apiKey);
      // Upsert the member as subscribed (idempotent).
      await api(`${base}/lists/${audienceId}/members/${hash}`, {
        provider: "mailchimp",
        method: "PUT",
        headers: { ...authHeader(apiKey), "Content-Type": "application/json" },
        body: JSON.stringify({
          email_address: email,
          status_if_new: "subscribed",
          status: "subscribed",
        }),
      });
      // If the mapped resource is a tag, attach it (idempotent — 'active' is a no-op if already set).
      if (ctx.resource) {
        await api(`${base}/lists/${audienceId}/members/${hash}/tags`, {
          provider: "mailchimp",
          method: "POST",
          headers: { ...authHeader(apiKey), "Content-Type": "application/json" },
          body: JSON.stringify({
            tags: [{ name: ctx.resource, status: "active" }],
          }),
        });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message, retryable: isRetryable(e) };
    }
  },

  async revoke(ctx: ProvisionContext): Promise<ProvisionResult> {
    const apiKey = ctx.credentials.api_key ?? "";
    const audienceId = ctx.credentials.audience_id ?? "";
    const email = ctx.member.email;
    if (!email) {
      // No email → nothing was ever provisioned; treat as already revoked.
      return { ok: true };
    }
    try {
      const hash = await subscriberHash(email);
      await api(`${baseOf(apiKey)}/lists/${audienceId}/members/${hash}`, {
        provider: "mailchimp",
        method: "PATCH",
        headers: { ...authHeader(apiKey), "Content-Type": "application/json" },
        body: JSON.stringify({ status: "unsubscribed" }),
      });
      return { ok: true };
    } catch (e) {
      // 404 → member not on the list → already revoked.
      if ((e as { status?: number })?.status === 404) return { ok: true };
      return { ok: false, error: (e as Error).message, retryable: isRetryable(e) };
    }
  },
};
