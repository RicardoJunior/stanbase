import type { ProviderAdapter, VerifyResult } from "./types.ts";

// Zapier is an OUTBOUND automation integration: Stanbase pushes events to
// Zapier (e.g. via a webhook/REST trigger) using a Stanbase publishable key.
// There is no Zapier-side membership to provision, so no grant/revoke.
export const zapierAdapter: ProviderAdapter = {
  provider: "zapier",
  authKind: "manual",

  // Nothing to call: `api_key` here is the Stanbase publishable key, which the
  // platform validates server-side in resolveAuth. So verify is a no-op success.
  verify(_credentials: Record<string, string>): Promise<VerifyResult> {
    return Promise.resolve({ ok: true, accountLabel: "Zapier" });
  },

  // No grant/revoke: outbound automation, no membership to provision.
};
