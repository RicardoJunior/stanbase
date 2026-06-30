// Discord connector — bot-token auth against a single guild (server).
// The org installs a bot into its guild; perks map a tier → a Discord role id,
// and we add/remove that role on the member's Discord user.
//
// No webhook support: Discord delivers member events (joins/leaves/role changes)
// over the realtime Gateway (a persistent WebSocket), not via signed HTTP webhooks,
// so there is nothing for the framework's webhook plumbing to verify/parse here.

import type {
  ProviderAdapter,
  VerifyResult,
  ProvisionContext,
  ProvisionResult,
} from "./types.ts";
import { api } from "./types.ts";

const BASE = "https://discord.com/api/v10";

function authHeaders(credentials: Record<string, string>): HeadersInit {
  return { Authorization: `Bot ${credentials.bot_token}` };
}

export const discordAdapter: ProviderAdapter = {
  provider: "discord",
  authKind: "bot",

  async verify(credentials: Record<string, string>): Promise<VerifyResult> {
    const guildId = credentials.guild_id;
    if (!credentials.bot_token || !guildId) {
      return { ok: false, error: "credenciais incompletas (bot_token e guild_id obrigatórios)" };
    }
    try {
      const body = await api(`${BASE}/guilds/${guildId}`, {
        provider: "discord",
        method: "GET",
        headers: authHeaders(credentials),
      });
      return { ok: true, accountLabel: body?.name, externalAccountId: guildId };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async grant(ctx: ProvisionContext): Promise<ProvisionResult> {
    const user = ctx.member.externalIds.discord;
    if (!user) {
      return { ok: false, error: "membro sem conta Discord vinculada", retryable: false };
    }
    const guildId = ctx.credentials.guild_id;
    const url = `${BASE}/guilds/${guildId}/members/${user}/roles/${ctx.resource}`;
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: authHeaders(ctx.credentials),
      });
      // 204 = role added; 201/200 also treated as success. Adding a role the
      // member already has is a no-op 204, so this is naturally idempotent.
      if (res.ok) return { ok: true };

      if (res.status === 404) {
        // Unknown Member → not in the guild (vs. unknown role/guild, but the
        // common case for provisioning is the member hasn't joined yet).
        return { ok: false, error: "membro não está no servidor", retryable: false };
      }
      if (res.status === 429 || res.status >= 500) {
        return { ok: false, error: await errText(res, "discord"), retryable: true };
      }
      return { ok: false, error: await errText(res, "discord"), retryable: false };
    } catch (e) {
      // network failure → transient
      return { ok: false, error: (e as Error).message, retryable: true };
    }
  },

  async revoke(ctx: ProvisionContext): Promise<ProvisionResult> {
    const user = ctx.member.externalIds.discord;
    if (!user) {
      // nothing to remove for a member with no linked Discord account
      return { ok: true };
    }
    const guildId = ctx.credentials.guild_id;
    const url = `${BASE}/guilds/${guildId}/members/${user}/roles/${ctx.resource}`;
    try {
      const res = await fetch(url, {
        method: "DELETE",
        headers: authHeaders(ctx.credentials),
      });
      // 204 = removed. 404 (member not in guild / role already gone) → already
      // in the desired state, so idempotent success.
      if (res.ok || res.status === 404) return { ok: true };

      if (res.status === 429 || res.status >= 500) {
        return { ok: false, error: await errText(res, "discord"), retryable: true };
      }
      return { ok: false, error: await errText(res, "discord"), retryable: false };
    } catch (e) {
      return { ok: false, error: (e as Error).message, retryable: true };
    }
  },
};

async function errText(res: Response, provider: string): Promise<string> {
  try {
    const text = await res.text();
    if (text) {
      const body = JSON.parse(text);
      const msg = body?.message ?? body?.error;
      if (typeof msg === "string") return msg;
    }
  } catch {
    // fall through
  }
  return `${provider} respondeu ${res.status}`;
}
