# Stanbase — Integrations backend (operator guide)

The real, production integrations framework: org-scoped **connections** with
**encrypted credentials**, an OAuth dance, a **grant/revoke provisioning queue**
drained by a worker, and an **inbound webhook** log. Membership rules live in the
core (checkout / subscriptions); the integration adapters only talk to each
provider's API.

This doc is what you (the operator) need to deploy and run it. It is kept
accurate to the code in `migrations/20260630120000_integrations.sql`,
`functions/_shared/`, and `functions/_shared/connectors/`.

---

## Architecture

### Connections + encrypted credentials
- A **connection** is one provider linked to one org (`connections` table, unique
  per `org_id` + `provider`). It carries `status`, `account_label`, the
  tier→resource **mappings** (jsonb), `external_account_id`, token expiry, and the
  encrypted `credentials`.
- Secrets are encrypted **at the application layer** before they touch the DB —
  the DB only ever stores opaque ciphertext. See `_shared/crypto.ts`:
  - **AES-256-GCM**, key from the `INTEGRATIONS_ENC_KEY` secret (32 bytes, base64).
  - Ciphertext format: `base64( [12-byte IV][GCM ciphertext+tag] )`, self-contained
    so decryption needs only the key.
  - `encryptCredentials` / `decryptCredentials` encrypt field-by-field. Decrypt is
    lenient: a value that fails to decrypt is passed through as-is (legacy/plaintext
    pre-encryption rows), so a reconnect heals it.
  - Rotate the key by re-encrypting; decrypt only needs the key, no schema change.
- On the way **out** to clients, credentials are never echoed — `v1-connections`
  masks every field to `••••` (it returns which fields exist, never their values).

### Provisioning queue + worker
- `provision_jobs` is the **grant/revoke queue** (one row = one intent: grant or
  revoke one resource for one member of one provider). Columns of note: `action`
  (`grant`|`revoke`), `resource`, `status` (`pending`|`processing`|`done`|`failed`),
  `attempts` / `max_attempts` (default 6), `run_after`, `last_error`.
- **Enqueue** (`_shared/provision.ts`): when a subscription activates/cancels, the
  membership side calls `enqueueForMemberTier`, which looks up every connected
  provider that has a mapping for the member's tier and enqueues one job per
  mapping with the mapped `resource`. `enqueueProvision` dedupes against pending
  jobs for the same (org, provider, member, action, resource).
- **Drain** (`integrations-provision` Edge Function, the worker): claims due jobs
  (`status=pending`, `run_after<=now`) with an optimistic per-row claim that guards
  concurrent drains, resolves the adapter from the registry, decrypts the org's
  credentials, resolves the member's external provider ids, and calls the adapter's
  `grant` / `revoke`. Results:
  - success → `completeJob` (status `done`).
  - failure → `failJob`: retryable failures reschedule with **exponential backoff**
    (`30s, 60s, 120s, …` capped at 1h) until `max_attempts`; non-retryable or
    exhausted → status `failed` with `last_error`.
- Member external ids come from **Supabase Auth identities** via the
  `member_provider_ids(p_member)` SECURITY DEFINER function (read-only projection of
  `auth.identities`, so provisioning gets the discord/google/… account id without
  opening the auth schema).
- The worker is **drained on a schedule by `pg_cron` + `pg_net`** (both enabled in
  the dashboard). The cron job POSTs `{"max":50}` to the function with a
  `Bearer <CRON_SECRET>` header. See the commented `cron.schedule(...)` example at
  the bottom of the integrations migration; it uses `app.functions_url` and
  `app.cron_secret` (or pass `PUBLIC_FUNCTIONS_URL` / `CRON_SECRET` directly).

### OAuth (`integrations-oauth`)
- For `authKind: "oauth"` providers, the framework runs the consent dance:
  `oauth_states` holds short-lived **CSRF/PKCE state** (`state` pk, `code_verifier`,
  `redirect_to`, `expires_at`) — service-role only, no member-readable RLS policy.
- Start: build the provider consent URL (`authorizeUrl`) with the platform client
  id and the function's redirect URI, store the state (+ `code_verifier` for PKCE).
- Callback: validate `state`, exchange the `code` for tokens (`exchangeCode`),
  encrypt the returned tokens into the connection's `credentials`, and stamp
  `external_account_id` / `token_expires_at` / `account_label`.
- Platform OAuth client id/secret are read from env per provider via
  `oauthClient(provider)` → `OAUTH_<PROVIDER>_CLIENT_ID` / `_SECRET`.
- The callback redirect URI is derived from `PUBLIC_FUNCTIONS_URL`; register it in
  each provider's developer console.

### Webhooks (`integrations-webhook`)
- Inbound provider webhooks land here. The adapter's `verifySignature` checks the
  provider signature over the **raw body** (HMAC/timestamp), and `parse` normalizes
  the payload into framework events (`member.left`, `subscription.updated`, …).
- Every event is logged to `integration_events` (provider, org, event type, external
  account/member ids, `signature_ok`, raw payload) for audit + reconcile. Normalized
  events can enqueue follow-up grant/revoke jobs.

### RLS / service role
- `provision_jobs` and `integration_events` are org-scoped read via
  `org_id = app.current_org()`; `oauth_states` has **no** permissive policy
  (service-role only). All three Edge Functions run with the **service role**
  (bypass RLS) and therefore filter `org_id` explicitly on every query.

---

## Required secrets

Set every one of these before deploying the integration functions.

| Secret | What it is | How to generate / source |
| --- | --- | --- |
| `INTEGRATIONS_ENC_KEY` | AES-256-GCM key for credential encryption (32 bytes, base64). **Without it, encrypt/decrypt throws.** | `openssl rand -base64 32` |
| `CRON_SECRET` | Bearer token the pg_cron drain job sends to `integrations-provision`; the worker rejects calls without it. | any high-entropy string (e.g. `openssl rand -hex 32`) |
| `PUBLIC_FUNCTIONS_URL` | Public base URL of the functions, e.g. `https://<ref>.supabase.co/functions/v1`. Used to build OAuth redirect URIs and the cron POST target. | your project's functions URL |
| `OAUTH_YOUTUBE_CLIENT_ID` / `OAUTH_YOUTUBE_CLIENT_SECRET` | YouTube (Google) OAuth client. | Google Cloud console |
| `OAUTH_TWITCH_CLIENT_ID` / `OAUTH_TWITCH_CLIENT_SECRET` | Twitch OAuth client. | Twitch developer console |
| `OAUTH_SPOTIFY_CLIENT_ID` / `OAUTH_SPOTIFY_CLIENT_SECRET` | Spotify OAuth client (PKCE). | Spotify developer dashboard |

The per-provider OAuth pairs follow `OAUTH_<PROVIDER>_CLIENT_ID` /
`OAUTH_<PROVIDER>_CLIENT_SECRET` (read by `oauthClient()` in
`_shared/connectors/types.ts`). Only the three OAuth providers above need them.

> The base backend also expects `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (the
> platform injects these for deployed functions) plus the Asaas/Cloudflare secrets
> documented in the main README — those are unchanged by this feature.

---

## Deploy

```bash
# 1. Apply the schema (oauth_states, provision_jobs, integration_events,
#    member_provider_ids, connections columns).
supabase db push

# 2. Set the secrets (one-off, or via --env-file).
supabase secrets set INTEGRATIONS_ENC_KEY="$(openssl rand -base64 32)"
supabase secrets set CRON_SECRET="$(openssl rand -hex 32)"
supabase secrets set PUBLIC_FUNCTIONS_URL="https://<ref>.supabase.co/functions/v1"
supabase secrets set \
  OAUTH_YOUTUBE_CLIENT_ID="..."  OAUTH_YOUTUBE_CLIENT_SECRET="..." \
  OAUTH_TWITCH_CLIENT_ID="..."   OAUTH_TWITCH_CLIENT_SECRET="..." \
  OAUTH_SPOTIFY_CLIENT_ID="..."  OAUTH_SPOTIFY_CLIENT_SECRET="..."

# 3. Deploy the functions (verify_jwt=false in config.toml — they authenticate by
#    their own rules: API key for connection ops, CRON_SECRET for the worker,
#    provider signature for webhooks).
supabase functions deploy integrations-oauth
supabase functions deploy integrations-provision
supabase functions deploy integrations-webhook

# 4. Schedule the drain (pg_cron + pg_net enabled in the dashboard). See the
#    commented cron.schedule(...) at the end of the integrations migration:
#    POST {"max":50} to .../integrations-provision with Bearer <CRON_SECRET>,
#    e.g. every minute.
```

After deploy, register each OAuth provider's **redirect URI** (built from
`PUBLIC_FUNCTIONS_URL` + `integrations-oauth` callback) in its developer console,
and point each provider's webhook at the `integrations-webhook` URL.

---

## Provider capability matrix

Adapters live in `_shared/connectors/<provider>.ts` and register in
`_shared/connectors/registry.ts`. Every adapter implements `verify` (a real test
call). What differs is whether it can actually **provision**:

### Real grant + revoke (membership drives access)
These have working `grant` **and** `revoke` — the worker truly adds/removes access:
- **discord** (`authKind: bot`) — add/remove a guild **role**.
- **telegram** (`authKind: bot`) — invite to / ban+unban from a **chat**.
- **mailchimp** (`authKind: api_key`) — subscribe/archive a member on an **audience list**.

### Verify / content-only (no membership provisioning)
Connected and verified, used for reads/content or outbound signaling, but they do
**not** grant/revoke per-member access:
- **youtube** (oauth), **twitch** (oauth), **spotify** (oauth, PKCE) — OAuth-linked,
  read-only / content scope; no per-member access provisioning.
- **whatsapp** (api_key) — verify + inbound **webhook**; no group-membership API to
  grant/revoke.
- **sympla** (api_key) — verify + inbound **webhook**.
- **vimeo**, **steam**, **riot**, **ingresse**, **asaas** (api_key) — verify / read.
- **zapier**, **webhooks** (manual) — outbound signaling the owner wires up; no
  per-member grant.

### Login via Supabase Auth (not in this registry)
Social/identity **login** providers — email, phone, **google, apple, x, facebook** —
are **not** integration adapters. Login is **Supabase Auth**, configured at the
platform level (Auth → Providers). The provisioning layer reads those linked
identities back through `member_provider_ids` to resolve external ids for grant/revoke.

---

## Quick reference

- Migration: `migrations/20260630120000_integrations.sql`
- Crypto: `functions/_shared/crypto.ts`
- Queue helpers: `functions/_shared/provision.ts`
- Adapter contract + `oauthClient()`: `functions/_shared/connectors/types.ts`
- Registry: `functions/_shared/connectors/registry.ts`
- Connection management API (connect/disconnect/mapping, masks secrets):
  `functions/v1-connections/index.ts`
- Functions (this feature): `integrations-oauth`, `integrations-provision`,
  `integrations-webhook` (all `verify_jwt = false` in `config.toml`).
