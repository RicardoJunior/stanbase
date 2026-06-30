-- Real integrations framework (§19): encrypted credentials, OAuth state, a
-- provisioning queue (grant/revoke) and an inbound webhook log. Secrets in
-- connections.credentials are AES-GCM ciphertext (see _shared/crypto.ts); the DB
-- never sees plaintext. RLS keeps everything org-scoped; the Edge Functions run
-- with the service role and filter org_id explicitly.

-- ── connections: provisioning/oauth metadata ────────────────────────
alter table connections add column if not exists external_account_id text;
alter table connections add column if not exists token_expires_at timestamptz;
alter table connections add column if not exists last_verified_at timestamptz;
alter table connections add column if not exists last_error text;

-- ── oauth_states: short-lived CSRF/PKCE state for the OAuth dance ────
create table if not exists oauth_states (
  state text primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  provider text not null,
  code_verifier text,
  redirect_to text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists oauth_states_expires_idx on oauth_states (expires_at);
alter table oauth_states enable row level security;
-- service-role only (no member access); no permissive policy on purpose.

-- ── provision_jobs: the grant/revoke queue (idempotent workers) ─────
create table if not exists provision_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  provider text not null,
  member_id uuid references members(id) on delete cascade,
  action text not null check (action in ('grant','revoke')),
  resource text not null default '',
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','processing','done','failed')),
  attempts int not null default 0,
  max_attempts int not null default 6,
  last_error text,
  run_after timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists provision_jobs_due_idx on provision_jobs (status, run_after);
create index if not exists provision_jobs_org_idx on provision_jobs (org_id, created_at desc);
alter table provision_jobs enable row level security;
create policy provision_jobs_read on provision_jobs
  for select using (org_id = app.current_org());

-- ── integration_events: inbound webhook log (audit + reconcile) ─────
create table if not exists integration_events (
  id bigint generated always as identity primary key,
  provider text not null,
  org_id uuid references organizations(id) on delete cascade,
  event_type text,
  external_account_id text,
  external_member_id text,
  signature_ok boolean not null default false,
  payload jsonb,
  received_at timestamptz not null default now()
);
create index if not exists integration_events_org_idx on integration_events (org_id, received_at desc);
create index if not exists integration_events_provider_idx on integration_events (provider, received_at desc);
alter table integration_events enable row level security;
create policy integration_events_read on integration_events
  for select using (org_id = app.current_org());

-- ── keep updated_at fresh on provision_jobs ─────────────────────────
create or replace function touch_provision_jobs() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists provision_jobs_touch on provision_jobs;
create trigger provision_jobs_touch before update on provision_jobs
  for each row execute function touch_provision_jobs();

-- ── member external ids (from Supabase Auth identities) ─────────────
-- Provisioning needs the member's provider account id (discord/google/…). Login
-- is Supabase Auth, so the ids live in auth.identities. SECURITY DEFINER exposes
-- a safe, read-only projection to the service role without opening the auth schema.
create or replace function member_provider_ids(p_member uuid) returns jsonb
  language sql security definer set search_path = public, auth as $$
  select coalesce(
    jsonb_object_agg(i.provider, coalesce(i.provider_id, i.identity_data->>'sub', i.identity_data->>'provider_id')),
    '{}'::jsonb)
  from members m
  join auth.identities i on i.user_id = m.user_id
  where m.id = p_member
    and coalesce(i.provider_id, i.identity_data->>'sub', i.identity_data->>'provider_id') is not null;
$$;

-- ── scheduled drain (optional; needs pg_cron) ───────────────────────
-- The provisioning worker is the `integrations-provision` Edge Function. Drain it
-- on a schedule with pg_cron + pg_net (enable both in the dashboard), e.g.:
--
--   select cron.schedule('drain-provision', '* * * * *', $$
--     select net.http_post(
--       url    => current_setting('app.functions_url') || '/integrations-provision',
--       headers=> jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret')),
--       body   => '{"max":50}'::jsonb
--     );$$);
--
-- Left as a comment so this migration has no hard extension dependency.
