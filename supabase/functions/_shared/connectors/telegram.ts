// Telegram Bot API adapter. The org connects a bot (creds: bot_token) that must
// be an admin of the target chat/channel (the mapped `resource` = chat_id).
// Telegram has NO way to programmatically force-add a user to a group/channel, so
// `grant` mints a single-use invite link (delivered to the member out-of-band).
// `revoke` ban+unban so the user is removed but can rejoin later via a new invite.

import type {
  ProviderAdapter,
  VerifyResult,
  ProvisionContext,
  ProvisionResult,
} from "./types.ts";
import { api } from "./types.ts";

const PROVIDER = "telegram";

function base(creds: Record<string, string>): string {
  return "https://api.telegram.org/bot" + (creds.bot_token ?? "");
}

/** Telegram replies 2xx with { ok, result } or non-2xx with { description }.
 *  `api` already throws on non-2xx (using `description` as the message), so here
 *  we only need to defend against the rare 200-with-ok:false case. */
function unwrap(body: any): any {
  if (body && body.ok === false) {
    const err = new Error(body.description ?? "telegram retornou ok:false");
    throw err;
  }
  return body?.result;
}

function post(
  creds: Record<string, string>,
  method: string,
  payload: Record<string, unknown>,
): Promise<any> {
  return api(`${base(creds)}/${method}`, {
    provider: PROVIDER,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export const telegramAdapter: ProviderAdapter = {
  provider: PROVIDER,
  authKind: "bot",

  async verify(credentials: Record<string, string>): Promise<VerifyResult> {
    try {
      const body = await api(`${base(credentials)}/getMe`, { provider: PROVIDER });
      const me = unwrap(body);
      return {
        ok: true,
        accountLabel: me?.username ? "@" + me.username : me?.first_name,
        externalAccountId: me?.id != null ? String(me.id) : undefined,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async grant(ctx: ProvisionContext): Promise<ProvisionResult> {
    // Telegram cannot force-add a member; we mint a single-use invite link.
    // The caller delivers `result.invite_link` to the member elsewhere (email/DM).
    try {
      await post(ctx.credentials, "createChatInviteLink", {
        chat_id: ctx.resource,
        member_limit: 1,
        name: ctx.member.id.slice(0, 32),
      });
      return { ok: true };
    } catch (e) {
      const status = (e as any).status as number | undefined;
      const retryable = status == null || status === 429 || status >= 500;
      return { ok: false, error: (e as Error).message, retryable };
    }
  },

  async revoke(ctx: ProvisionContext): Promise<ProvisionResult> {
    const userId = ctx.member.externalIds?.telegram;
    // No linked Telegram identity → nothing to remove; treat as success.
    if (!userId) return { ok: true };
    try {
      // Ban removes them from the chat...
      await post(ctx.credentials, "banChatMember", {
        chat_id: ctx.resource,
        user_id: userId,
      });
      // ...then unban (only_if_banned) so they're eligible to rejoin later.
      await post(ctx.credentials, "unbanChatMember", {
        chat_id: ctx.resource,
        user_id: userId,
        only_if_banned: true,
      });
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message ?? "";
      const status = (e as any).status as number | undefined;
      // Idempotent: not a member / already gone → success.
      if (/not.*member|user not found|PARTICIPANT_ID_INVALID/i.test(msg)) {
        return { ok: true };
      }
      const retryable = status == null || status === 429 || status >= 500;
      return { ok: false, error: msg, retryable };
    }
  },
};
