-- Stanbase — API keys for the public /v1 API (§21). Each key belongs to an org
-- and is authenticated by sha-256 hash (we never store the raw key). Edge
-- Functions use the service role and filter org_id explicitly; the RLS policy
-- below mirrors the org-scoped pattern for any authenticated (JWT) access.

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text,
  hash text not null,
  prefix text,
  scopes text[] not null default '{}',
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index on api_keys (prefix);

-- ── RLS ─────────────────────────────────────────────────────────
-- Org-scoped: same standard policy as the other tenant tables.
alter table api_keys enable row level security;
alter table api_keys force row level security;
create policy api_keys_rls on api_keys
  using (org_id = app.current_org())
  with check (org_id = app.current_org());
