import type {
  NormalizedEvent,
  ProviderAdapter,
  VerifyResult,
} from "./types.ts";
import { api } from "./types.ts";

const GRAPH = "https://graph.facebook.com/v21.0";

/** Constant-time hex comparison to avoid signature timing leaks. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HMAC-SHA256(key, message) as lowercase hex, via Web Crypto. */
async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const whatsappAdapter: ProviderAdapter = {
  provider: "whatsapp",
  authKind: "api_key",

  async verify(credentials: Record<string, string>): Promise<VerifyResult> {
    const phoneNumberId = credentials.phone_number_id;
    const accessToken = credentials.access_token;
    if (!phoneNumberId) return { ok: false, error: "phone_number_id ausente" };
    if (!accessToken) return { ok: false, error: "access_token ausente" };
    try {
      const body = await api(`${GRAPH}/${phoneNumberId}`, {
        provider: "whatsapp",
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return {
        ok: true,
        accountLabel: body?.display_phone_number ?? body?.verified_name,
        externalAccountId: body?.id ?? phoneNumberId,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  // No grant/revoke: the WhatsApp Cloud API has no group-membership API
  // (messaging only, no programmatic add/remove of members), so provisioning
  // is intentionally omitted.

  webhook: {
    async verifySignature(
      { rawBody, credentials, req },
    ): Promise<boolean> {
      const appSecret = credentials.app_secret;
      if (!appSecret) return false;
      const header = req.headers.get("x-hub-signature-256") ?? "";
      if (!header.startsWith("sha256=")) return false;
      const provided = header.slice("sha256=".length).toLowerCase();
      const expected = await hmacSha256Hex(appSecret, rawBody);
      return timingSafeEqualHex(provided, expected);
    },

    parse(rawBody: string): NormalizedEvent[] {
      const events: NormalizedEvent[] = [];
      let payload: any;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return events;
      }
      const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];
      for (const entry of entries) {
        const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const change of changes) {
          const value = change?.value;
          const phoneNumberId = value?.metadata?.phone_number_id;
          const messages: any[] = Array.isArray(value?.messages)
            ? value.messages
            : [];
          for (const msg of messages) {
            events.push({
              type: "message.received",
              externalAccountId: phoneNumberId,
              externalMemberId: msg?.from,
              raw: msg,
            });
          }
        }
      }
      return events;
    },
  },
};
