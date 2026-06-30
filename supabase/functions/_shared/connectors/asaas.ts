import type { ProviderAdapter, VerifyResult } from "./types.ts";
import { api } from "./types.ts";

// Asaas is a Brazilian payment PSP (cobranças/PIX/boleto). It has no concept of
// memberships, roles, or groups — there is nothing to provision per member — so
// this adapter intentionally OMITS grant/revoke and only verifies credentials.
export const asaasAdapter: ProviderAdapter = {
  provider: "asaas",
  authKind: "api_key",

  async verify(credentials: Record<string, string>): Promise<VerifyResult> {
    const accessToken = credentials.access_token;
    const base =
      credentials.environment === "production"
        ? "https://api.asaas.com"
        : "https://api-sandbox.asaas.com";

    try {
      const body = await api(`${base}/v3/myAccount`, {
        provider: "asaas",
        method: "GET",
        headers: {
          access_token: accessToken,
          "Content-Type": "application/json",
        },
      });

      return {
        ok: true,
        accountLabel: body?.name ?? "Asaas",
        externalAccountId: body?.walletId ?? credentials.wallet_id,
      };
    } catch (e) {
      const body = (e as any)?.body;
      const detail = body?.errors?.[0]?.description;
      return { ok: false, error: detail ?? (e as Error).message };
    }
  },
};
