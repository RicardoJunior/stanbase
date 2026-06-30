import type { ProviderAdapter, VerifyResult } from "./types.ts";
import { api } from "./types.ts";

// Steam Web API connector. Used for niche_verify (reading account attributes
// like owned games / playtime). No grant/revoke: Steam has no programmatic
// membership/role provisioning — member links are established via Steam OpenID
// sign-in, not provisioned by this adapter.
export const steamAdapter: ProviderAdapter = {
  provider: "steam",
  authKind: "api_key",

  async verify(credentials: Record<string, string>): Promise<VerifyResult> {
    const webApiKey = credentials.web_api_key?.trim();
    if (!webApiKey) {
      return { ok: false, error: "web_api_key é obrigatório" };
    }
    try {
      // GetSupportedAPIList returns the methods the key can access (200 = valid key).
      await api(
        `https://api.steampowered.com/ISteamWebAPIUtil/GetSupportedAPIList/v1/?key=${encodeURIComponent(webApiKey)}`,
        { provider: "steam", method: "GET" },
      );
      return { ok: true, accountLabel: "Steam Web API" };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};
