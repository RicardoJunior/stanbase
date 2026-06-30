// Ingresse — Brazilian ticketing/event platform. API-key auth via HMAC-SHA1.
// Ingresse signs requests with a public/private key pair: a timestamp (ISO) plus
// a base64(HMAC_SHA1(private_key, public_key + timestamp)) signature, all passed
// as query params. There is no programmatic membership/role provisioning here —
// Ingresse manages ticket buyers/attendees, not perk memberships — so we OMIT
// grant/revoke and only implement verify().
//
// NOTE: the exact signing recipe (which string is signed, encoding, param names)
// may need adjustment to match the current Ingresse docs — this follows the
// documented base64(HMAC_SHA1(private_key, public_key + timestamp)) shape.

import type { ProviderAdapter, VerifyResult } from "./types.ts";
import { api } from "./types.ts";

const INGRESSE_API = "https://api.ingresse.com";

/** Build the Ingresse HMAC-SHA1 signature for the given keys + timestamp. */
async function signIngresse(
  publicKey: string,
  privateKey: string,
  timestamp: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(privateKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  // Ingresse signs the concatenation of public key + timestamp.
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(publicKey + timestamp));
  // base64 of the raw HMAC bytes.
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

export const ingresseAdapter: ProviderAdapter = {
  provider: "ingresse",
  authKind: "api_key",

  async verify(credentials: Record<string, string>): Promise<VerifyResult> {
    const publicKey = credentials.public_key?.trim();
    const privateKey = credentials.private_key?.trim();
    if (!publicKey || !privateKey) {
      return { ok: false, error: "Informe public_key e private_key da Ingresse." };
    }

    try {
      const timestamp = new Date().toISOString();
      const signature = await signIngresse(publicKey, privateKey, timestamp);

      const url =
        `${INGRESSE_API}/status?publickey=${encodeURIComponent(publicKey)}` +
        `&signature=${encodeURIComponent(signature)}` +
        `&timestamp=${encodeURIComponent(timestamp)}`;

      // 200 → credentials/signature accepted by Ingresse.
      const body = await api(url, { provider: "ingresse", method: "GET" });

      return {
        ok: true,
        accountLabel: body?.data?.name ?? body?.name ?? "Ingresse",
        externalAccountId: publicKey,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  // No grant/revoke: Ingresse is a ticketing API (event/order data), not a
  // membership/role provider — there is no programmatic perk-membership API.
};
