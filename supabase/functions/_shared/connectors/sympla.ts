import type { ProviderAdapter, VerifyResult, NormalizedEvent } from "./types.ts";
import { api } from "./types.ts";

// Sympla is a Brazilian event/ticketing platform. Its public API (s_token) is
// read-only for event/order/checkin import — there is no membership, role, or
// group provisioning per attendee — so this adapter intentionally OMITS
// grant/revoke and only verifies credentials + ingests webhooks.
export const symplaAdapter: ProviderAdapter = {
  provider: "sympla",
  authKind: "api_key",

  async verify(credentials: Record<string, string>): Promise<VerifyResult> {
    const sToken = credentials.s_token;

    try {
      await api("https://api.sympla.com.br/public/v3/events", {
        provider: "sympla",
        method: "GET",
        headers: {
          s_token: sToken,
          "Content-Type": "application/json",
        },
      });

      return { ok: true, accountLabel: "Sympla" };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  webhook: {
    // Sympla does NOT sign its webhooks (no HMAC/secret). Best-effort auth: we
    // accept the call only if a configured shared token — passed as a `token`
    // query param or `x-sympla-token` header — matches creds.s_token.
    verifySignature({ req, credentials }): boolean {
      const expected = credentials.s_token;
      if (!expected) return false;

      const url = new URL(req.url);
      const provided =
        url.searchParams.get("token") ??
        req.headers.get("x-sympla-token") ??
        req.headers.get("s_token") ??
        "";

      return provided === expected;
    },

    // Normalize Sympla order/checkin payloads into framework events.
    parse(rawBody: string): NormalizedEvent[] {
      let payload: any;
      try {
        payload = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        return [];
      }
      if (!payload) return [];

      const items: any[] = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
          ? payload.data
          : [payload];

      const events: NormalizedEvent[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;

        const rawType = String(
          item.event_type ?? item.type ?? item.action ?? "",
        ).toLowerCase();
        const isCheckin =
          rawType.includes("checkin") ||
          rawType.includes("check_in") ||
          rawType.includes("check-in") ||
          item.checkin === true ||
          item.checked_in === true;

        const type = isCheckin ? "checkin" : "order.created";

        const externalAccountId =
          item.event_id != null
            ? String(item.event_id)
            : item.event?.id != null
              ? String(item.event.id)
              : undefined;

        const externalMemberId =
          item.order_id != null
            ? String(item.order_id)
            : item.order?.id != null
              ? String(item.order.id)
              : item.ticket_id != null
                ? String(item.ticket_id)
                : item.participant_id != null
                  ? String(item.participant_id)
                  : undefined;

        events.push({ type, externalAccountId, externalMemberId, raw: item });
      }

      return events;
    },
  },
};
