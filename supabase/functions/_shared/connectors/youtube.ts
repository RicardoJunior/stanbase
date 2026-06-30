// YouTube (Google) OAuth adapter. The owner connects their YouTube channel via
// Google's OAuth consent flow; we read the channel via the YouTube Data API v3.
//
// NO grant/revoke: YouTube channel memberships cannot be granted/revoked
// programmatically — the Data API only exposes read-only members listing
// (members.list) for the channel owner, not adding/removing members. Perks here
// are content-gating only, so there is nothing to provision.

import type {
  OAuthExchangeResult,
  ProviderAdapter,
  VerifyResult,
} from "./types.ts";
import { api, oauthClient } from "./types.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHANNELS_URL =
  "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true";

/** GET the authenticated user's channel; returns { title, id } of the first channel. */
async function fetchChannel(
  accessToken: string,
): Promise<{ title?: string; id?: string }> {
  const body = await api(CHANNELS_URL, {
    provider: "youtube",
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const channel = body?.items?.[0];
  return { title: channel?.snippet?.title, id: channel?.id };
}

export const youtubeAdapter: ProviderAdapter = {
  provider: "youtube",
  authKind: "oauth",

  async verify(credentials: Record<string, string>): Promise<VerifyResult> {
    try {
      const accessToken = credentials.access_token;
      if (!accessToken) {
        return { ok: false, error: "access_token ausente nas credenciais" };
      }
      const { title, id } = await fetchChannel(accessToken);
      if (!id) {
        return { ok: false, error: "Nenhum canal do YouTube encontrado para esta conta" };
      }
      return { ok: true, accountLabel: title, externalAccountId: id };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  oauth: {
    usesPkce: false,
    scopes: ["https://www.googleapis.com/auth/youtube.readonly"],

    authorizeUrl({ state, redirectUri, clientId }): string {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/youtube.readonly",
        access_type: "offline",
        prompt: "consent",
        state,
      });
      return "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString();
    },

    async exchangeCode({ code, redirectUri }): Promise<OAuthExchangeResult> {
      const { clientId, clientSecret } = oauthClient("youtube");
      const tokens = await api(TOKEN_URL, {
        provider: "youtube",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }).toString(),
      });

      const accessToken: string = tokens.access_token;
      const refreshToken: string | undefined = tokens.refresh_token;
      const { title, id } = await fetchChannel(accessToken);

      const credentials: Record<string, string> = { access_token: accessToken };
      if (refreshToken) credentials.refresh_token = refreshToken;

      const result: OAuthExchangeResult = {
        credentials,
        accountLabel: title,
        externalAccountId: id,
      };
      if (typeof tokens.expires_in === "number") {
        result.expiresAt = new Date(Date.now() + tokens.expires_in * 1000)
          .toISOString();
      }
      return result;
    },

    async refresh(
      creds: Record<string, string>,
    ): Promise<OAuthExchangeResult> {
      const { clientId, clientSecret } = oauthClient("youtube");
      const refreshToken = creds.refresh_token;
      if (!refreshToken) {
        throw new Error("refresh_token ausente — reconecte o canal do YouTube");
      }
      const tokens = await api(TOKEN_URL, {
        provider: "youtube",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
        }).toString(),
      });

      // Google does not return a new refresh_token on refresh — keep the old one.
      const credentials: Record<string, string> = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? refreshToken,
      };
      const result: OAuthExchangeResult = { credentials };
      if (typeof tokens.expires_in === "number") {
        result.expiresAt = new Date(Date.now() + tokens.expires_in * 1000)
          .toISOString();
      }
      return result;
    },
  },
};
