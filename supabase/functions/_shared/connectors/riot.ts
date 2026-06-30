import type { ProviderAdapter, VerifyResult } from "./types.ts";
import { api } from "./types.ts";

// Riot Games API — used for niche_verify (read-only access to account/rank data).
// No grant/revoke: Riot has no programmatic membership/role provisioning; the API
// only reads rank/account info and cannot grant entitlements.
export const riotAdapter: ProviderAdapter = {
  provider: "riot",
  authKind: "api_key",

  async verify(credentials: Record<string, string>): Promise<VerifyResult> {
    const apiKey = credentials.api_key;
    if (!apiKey) return { ok: false, error: "api_key ausente" };
    try {
      await api("https://br1.api.riotgames.com/lol/status/v4/platform-data", {
        provider: "riot",
        method: "GET",
        headers: { "X-Riot-Token": apiKey },
      });
      return { ok: true, accountLabel: "Riot API" };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};
