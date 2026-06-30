import type { ProviderAdapter, VerifyResult } from "./types.ts";
import { api } from "./types.ts";

// Vimeo: personal access token auth. Verify hits GET /me to confirm the token.
// NO grant/revoke: Vimeo has no per-member API — private video access is gated
// at the video/folder level via domain privacy (allowed domains/embed),
// not by adding/removing individual members. So provisioning is omitted.
export const vimeoAdapter: ProviderAdapter = {
  provider: "vimeo",
  authKind: "api_key",

  async verify(credentials: Record<string, string>): Promise<VerifyResult> {
    const accessToken = credentials.access_token;
    if (!accessToken) return { ok: false, error: "access_token é obrigatório" };
    try {
      const me = await api("https://api.vimeo.com/me", {
        provider: "vimeo",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.vimeo.*+json;version=3.4",
        },
      });
      return { ok: true, accountLabel: me?.name, externalAccountId: me?.uri };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};
