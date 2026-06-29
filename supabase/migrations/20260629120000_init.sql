-- Stanbase — initial schema + RLS (multi-tenant by org_id), aligned to the
-- TypeScript domain model (src/types/domain.ts). Every domain table carries
-- org_id and is protected by RLS. Edge Functions use the service role and
-- filter org_id explicitly (belt + suspenders).

create extension if not exists pgcrypto;       -- gen_random_uuid()
create schema if not exists app;

-- ── claims helpers (org_id/role injected by the Custom Access Token Hook) ──
create or replace function app.current_org() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'org_id', '')::uuid
$$;

create or replace function app.current_role() returns text language sql stable as $$
  select current_setting('request.jwt.claims', true)::jsonb ->> 'role'
$$;

create or replace function app.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ── núcleo ─────────────────────────────────────────────────────
create table accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid,
  created_at timestamptz not null default now()
);

create table organizations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  slug text unique not null,
  name text not null,
  vertical text,
  logo_text text,
  tagline text,
  status text not null default 'active' check (status in ('active','suspended','deleted')),
  theme jsonb not null default '{}'::jsonb,
  landing jsonb,
  created_at timestamptz not null default now()
);

create table org_users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid,
  name text,
  email text,
  role text not null check (role in ('owner','admin','operator')),
  permissions text[] not null default '{}',
  status text not null default 'active' check (status in ('active','invited')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index on org_users (org_id);
create index on org_users (user_id);

create table platform_billing_settings (
  id int primary key default 1 check (id = 1),
  base_commission_rate numeric(6,4) not null default 0.0799,
  installment_interest_rate_am numeric(6,4) not null default 0.0349,
  max_installments int not null default 12,
  psp_anticipation_rate_am numeric(6,4) not null default 0.0125
);
insert into platform_billing_settings (id) values (1) on conflict do nothing;

-- ── tiers & perks ──────────────────────────────────────────────
create table perks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  mode text not null default 'live' check (mode in ('live','test')),
  type text not null,
  name text not null,
  config jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table tiers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  mode text not null default 'live' check (mode in ('live','test')),
  name text not null,
  description text default '',
  price numeric(12,2) not null default 0,
  currency text not null default 'BRL',
  period text not null check (period in ('monthly','quarterly','semiannual','annual','one_time','lifetime')),
  position int not null default 0,
  color text,
  capacity int,
  installments_enabled boolean not null default false,
  perk_ids uuid[] not null default '{}',
  status text not null default 'active',
  created_at timestamptz not null default now()
);

-- ── membros / CRM ──────────────────────────────────────────────
create table members (
  id uuid primary key default gen_random_uuid(),
  member_id text unique not null,                 -- 8-char public ID
  org_id uuid not null references organizations(id) on delete cascade,
  mode text not null default 'live' check (mode in ('live','test')),
  user_id uuid,
  tier_id uuid references tiers(id),
  status text not null default 'active' check (status in ('lead','active','past_due','canceled','reactivated')),
  joined_at timestamptz not null default now(),
  reactivated_at timestamptz,
  source text,
  grace_period_ends_at timestamptz,
  created_at timestamptz not null default now()
);
create index on members (org_id);

create table member_profiles (
  member_id uuid primary key references members(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  name text,
  photo_url text,
  email text,
  phone text,
  address text,
  social jsonb not null default '{}'::jsonb,
  attributes jsonb not null default '{}'::jsonb,
  consents jsonb not null default '{}'::jsonb
);

create table member_metrics (
  member_id uuid primary key references members(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  ltv numeric(12,2) not null default 0,
  total_paid numeric(12,2) not null default 0,
  net_org numeric(12,2) not null default 0,
  mrr numeric(12,2) not null default 0,
  engagement_score int not null default 0,
  churn_score int not null default 0,
  rfm jsonb not null default '{}'::jsonb,
  last_active_at timestamptz
);

create table tags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  label text not null,
  color text
);
create table member_tags (
  org_id uuid not null references organizations(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  tag_id uuid not null references tags(id) on delete cascade,
  primary key (member_id, tag_id)
);
create table notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  author text,
  body text not null,
  created_at timestamptz not null default now()
);
create table interactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  type text not null,
  title text,
  detail text,
  occurred_at timestamptz not null default now()
);
create index on interactions (member_id, occurred_at desc);
create table entitlements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  perk_id uuid references perks(id) on delete cascade,
  source text not null default 'tier',
  status text not null default 'active',
  expires_at timestamptz
);
create table achievements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  label text not null,
  earned_at timestamptz not null default now()
);

-- ── billing ────────────────────────────────────────────────────
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  mode text not null default 'live' check (mode in ('live','test')),
  member_id uuid not null references members(id) on delete cascade,
  tier_id uuid references tiers(id),
  period text not null,
  status text not null default 'active' check (status in ('active','canceled','past_due','pending')),
  current_period_end timestamptz,
  installments int not null default 1,
  auto_renew boolean not null default true,
  method text,
  psp_ref text,                                   -- Asaas subscription/payment id
  created_at timestamptz not null default now()
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  mode text not null default 'live' check (mode in ('live','test')),
  member_id uuid references members(id) on delete cascade,
  subscription_id uuid references subscriptions(id) on delete set null,
  description text,
  method text not null check (method in ('pix','credit_card','boleto')),
  installments int not null default 1,
  plan_value numeric(12,2) not null,
  customer_interest numeric(12,2) not null default 0,
  charged_total numeric(12,2) not null,
  base_commission numeric(12,2) not null default 0,
  psp_fee numeric(12,2) not null default 0,
  psp_anticipation_fee numeric(12,2) not null default 0,
  financing_spread numeric(12,2) not null default 0,
  net_org numeric(12,2) not null default 0,
  status text not null default 'pending' check (status in ('paid','pending','failed','refunded')),
  psp_ref text,                                   -- Asaas payment id (idempotency)
  created_at timestamptz not null default now()
);
create index on transactions (org_id, created_at desc);
create unique index on transactions (psp_ref) where psp_ref is not null;

create table payouts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  amount numeric(12,2) not null,
  period text,
  status text not null default 'scheduled',
  created_at timestamptz not null default now()
);

-- ── passport / eventos ─────────────────────────────────────────
create table passes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  type text not null check (type in ('membership','ticket')),
  platform text check (platform in ('apple','google')),
  serial text,
  auth_token text,
  status text not null default 'active',
  created_at timestamptz not null default now()
);
create table events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  mode text not null default 'live',
  name text not null,
  starts_at timestamptz,
  venue text,
  capacity int,
  min_tier_id uuid references tiers(id),
  price numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);
create table tickets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  event_id uuid references events(id) on delete cascade,
  member_id uuid references members(id) on delete cascade,
  status text not null default 'valid' check (status in ('valid','used')),
  pass_id uuid references passes(id),
  created_at timestamptz not null default now()
);
create table checkins (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  event_id uuid references events(id) on delete set null,
  member_id uuid references members(id) on delete cascade,
  ticket_id uuid references tickets(id),
  operator text,
  at timestamptz not null default now(),
  result text
);

-- ── integrações / plataforma ───────────────────────────────────
create table connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  provider text not null,
  status text not null default 'connected' check (status in ('connected','disconnected','error')),
  account_label text,
  connected_at timestamptz,
  mappings jsonb not null default '[]'::jsonb,
  credentials jsonb not null default '{}'::jsonb,   -- secrets: use Supabase Vault in prod
  created_at timestamptz not null default now(),
  unique (org_id, provider)
);

create table audit_logs (
  id bigint generated always as identity primary key,
  org_id uuid,
  actor text,
  action text not null,
  target text,
  payload jsonb,
  at timestamptz not null default now()
);
create index on audit_logs (org_id, at desc);

create table idempotency_keys (
  org_id uuid,
  endpoint text not null,
  key text not null,
  request_hash text,
  response_status int,
  response_body jsonb,
  status text not null default 'in_progress',
  created_at timestamptz not null default now(),
  primary key (org_id, endpoint, key)
);

-- ── RLS ─────────────────────────────────────────────────────────
-- Org-scoped tables: standard policy org_id = current org from JWT.
do $$
declare t text;
begin
  foreach t in array array[
    'perks','tiers','members','member_profiles','member_metrics','tags','member_tags',
    'notes','interactions','entitlements','achievements','subscriptions','transactions',
    'payouts','passes','events','tickets','checkins','connections'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %1$s_rls on %1$I using (org_id = app.current_org()) with check (org_id = app.current_org())$p$, t);
  end loop;
end $$;

-- organizations: a user sees orgs they belong to.
alter table organizations enable row level security;
alter table organizations force row level security;
create policy organizations_rls on organizations
  using (exists (select 1 from org_users ou where ou.org_id = organizations.id and ou.user_id = auth.uid()))
  with check (exists (select 1 from org_users ou where ou.org_id = organizations.id and ou.user_id = auth.uid()));

-- org_users: see rows of the active org, or your own memberships (for the org selector).
alter table org_users enable row level security;
alter table org_users force row level security;
create policy org_users_rls on org_users
  using (org_id = app.current_org() or user_id = auth.uid())
  with check (org_id = app.current_org());

-- accounts: owner only.
alter table accounts enable row level security;
alter table accounts force row level security;
create policy accounts_rls on accounts using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

-- platform_billing_settings: read for authenticated; writes only via service role (no policy).
alter table platform_billing_settings enable row level security;
create policy platform_billing_read on platform_billing_settings for select using (true);

-- audit_logs / idempotency_keys: service-role only (RLS on, no policies).
alter table audit_logs enable row level security;
alter table idempotency_keys enable row level security;
