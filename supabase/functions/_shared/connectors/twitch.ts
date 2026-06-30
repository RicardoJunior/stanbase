// Twitch — OAuth (authorization code). We read user identity via the Helix API.
// NO grant/revoke: Twitch subscriptions/follows are read-only for third parties;
// there is no API to add/remove a user's membership in a channel, so we omit them.

import type {
  ProviderAdapter,
  VerifyResult,
  OAuthExchangeResult,
} from "./types.ts";
import { api, oauthClient } from "./types.ts";

const SCOPES = ["user:read:email"];

/** GET helix/users with a user access token → the first (authed) user. */
async function getUser(accessToken: string, clientId: string): Promise<any> {
  const body = await api("https://api.twitch.tv/helix/users", {
    provider: "twitch",
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Client-Id": clientId,
    },
  });
  const user = body?.data?.[0];
  if (!user) throw new Error("twitch: nenhum usuário retornado");
  return user;
}

export const twitchAdapter: ProviderAdapter = {
  provider: "twitch",
  authKind: "oauth",

  async verify(credentials): Promise<VerifyResult> {
    try {
      const { clientId } = oauthClient("twitch");
      const accessToken = credentials.access_token;
      if (!accessToken) return { ok: false, error: "twitch: access_token ausente" };
      const user = await getUser(accessToken, clientId);
      return { ok: true, accountLabel: user.login, externalAccountId: user.id };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  oauth: {
    scopes: SCOPES,

    authorizeUrl({ state, redirectUri, clientId }): string {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPES.join(" "),
        state,
      });
      return "https://id.twitch.tv/oauth2/authorize?" + params.toString();
    },

    async exchangeCode({ code, redirectUri }): Promise<OAuthExchangeResult> {
      const { clientId, clientSecret } = oauthClient("twitch");
      const token = await api("https://id.twitch.tv/oauth2/token", {
        provider: "twitch",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }).toString(),
      });
      const user = await getUser(token.access_token, clientId);
      return {
        credentials: {
          access_token: token.access_token,
          refresh_token: token.refresh_token,
        },
        accountLabel: user.login,
        externalAccountId: user.id,
        expiresAt: token.expires_in
          ? new Date(Date.now() + token.expires_in * 1000).toISOString()
          : undefined,
      };
    },

    async refresh(creds): Promise<OAuthExchangeResult> {
      const { clientId, clientSecret } = oauthClient("twitch");
      const refreshToken = creds.refresh_token;
      if (!refreshToken) throw new Error("twitch: refresh_token ausente");
      const token = await api("https://id.twitch.tv/oauth2/token", {
        provider: "twitch",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
      });
      const user = await getUser(token.access_token, clientId);
      return {
        credentials: {
          access_token: token.access_token,
          // Twitch may rotate the refresh token; keep the new one if returned.
          refresh_token: token.refresh_token ?? refreshToken,
        },
        accountLabel: user.login,
        externalAccountId: user.id,
        expiresAt: token.expires_in
          ? new Date(Date.now() + token.expires_in * 1000).toISOString()
          : undefined,
      };
    },
  },
};
