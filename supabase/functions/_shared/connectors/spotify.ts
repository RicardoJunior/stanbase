// Spotify connector — OAuth (Authorization Code + PKCE).
// Provisioning is OMITTED: Spotify's Web API has no programmatic membership/role
// concept. Perks here are content-gating only (e.g. unlocking private playlists),
// so there is nothing to grant/revoke at the provider.

import type {
  OAuthExchangeResult,
  ProviderAdapter,
  VerifyResult,
} from "./types.ts";
import { api, oauthClient } from "./types.ts";

const TOKEN_URL = "https://accounts.spotify.com/api/token";

function basicAuth(clientId: string, clientSecret: string): string {
  return "Basic " + btoa(`${clientId}:${clientSecret}`);
}

function buildCreds(token: any): OAuthExchangeResult {
  const credentials: Record<string, string> = {
    access_token: token.access_token,
  };
  if (token.refresh_token) credentials.refresh_token = token.refresh_token;

  const out: OAuthExchangeResult = { credentials };
  if (typeof token.expires_in === "number") {
    out.expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
  }
  return out;
}

export const spotifyAdapter: ProviderAdapter = {
  provider: "spotify",
  authKind: "oauth",

  oauth: {
    usesPkce: true,
    scopes: ["user-read-email", "playlist-read-private"],

    authorizeUrl({ state, redirectUri, codeChallenge }) {
      const { clientId } = oauthClient("spotify");
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: ["user-read-email", "playlist-read-private"].join(" "),
        state,
        code_challenge_method: "S256",
      });
      if (codeChallenge) params.set("code_challenge", codeChallenge);
      return "https://accounts.spotify.com/authorize?" + params.toString();
    },

    async exchangeCode({ code, redirectUri, codeVerifier }) {
      const { clientId, clientSecret } = oauthClient("spotify");
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
      });
      if (codeVerifier) form.set("code_verifier", codeVerifier);

      const token = await api(TOKEN_URL, {
        provider: "spotify",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basicAuth(clientId, clientSecret),
        },
        body: form.toString(),
      });

      const result = buildCreds(token);

      // Enrich with account label/id from /me.
      try {
        const me = await api("https://api.spotify.com/v1/me", {
          provider: "spotify",
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        result.accountLabel = me.display_name ?? me.id;
        result.externalAccountId = me.id;
      } catch {
        // token is valid even if /me lookup transiently fails; labels are optional.
      }
      return result;
    },

    async refresh(creds) {
      const { clientId, clientSecret } = oauthClient("spotify");
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refresh_token ?? "",
        client_id: clientId,
      });

      const token = await api(TOKEN_URL, {
        provider: "spotify",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basicAuth(clientId, clientSecret),
        },
        body: form.toString(),
      });

      const result = buildCreds(token);
      // Spotify may not return a new refresh_token on refresh — keep the old one.
      if (!token.refresh_token && creds.refresh_token) {
        result.credentials.refresh_token = creds.refresh_token;
      }
      return result;
    },
  },

  async verify(credentials): Promise<VerifyResult> {
    try {
      const me = await api("https://api.spotify.com/v1/me", {
        provider: "spotify",
        headers: { Authorization: `Bearer ${credentials.access_token}` },
      });
      return {
        ok: true,
        accountLabel: me.display_name ?? me.id,
        externalAccountId: me.id,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  // No grant/revoke: Spotify has no membership/role API — perks are content-gating only.
};
