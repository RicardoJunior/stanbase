import type { ProviderAdapter, VerifyResult } from "./types.ts";

// Generic outbound webhooks. authKind "manual": the owner configures an HTTPS
// endpoint and the set of events they want delivered. verify() only validates
// that the endpoint is a well-formed HTTPS URL — it does NOT POST to it (a probe
// request could trigger the owner's handler or fail on an endpoint that expects
// real events). No grant/revoke: there is no membership/role concept here;
// actual event delivery is performed by the framework's webhook dispatcher.
export const webhooksAdapter: ProviderAdapter = {
  provider: "webhooks",
  authKind: "manual",

  verify(credentials: Record<string, string>): Promise<VerifyResult> {
    const endpointUrl = (credentials.endpoint_url ?? "").trim();
    if (!endpointUrl) {
      return Promise.resolve({ ok: false, error: "informe a URL https" });
    }
    let url: URL;
    try {
      url = new URL(endpointUrl);
    } catch {
      return Promise.resolve({ ok: false, error: "informe a URL https" });
    }
    if (url.protocol !== "https:") {
      return Promise.resolve({ ok: false, error: "informe a URL https" });
    }
    return Promise.resolve({ ok: true, accountLabel: url.host });
  },
};
