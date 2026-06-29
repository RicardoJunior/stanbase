-- Custom domains per membership (§23.1.8) via Cloudflare for SaaS (Custom Hostnames).
-- The org points a CNAME to the platform fallback origin; Cloudflare issues SSL.
create table custom_domains (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  host text not null unique,                       -- e.g. membros.suacomunidade.com (lowercase)
  target text not null default 'member' check (target in ('member','verify')),
  status text not null default 'pending_dns'
    check (status in ('pending_dns','dns_ok','ssl_issued','active','error','disabled')),
  verification_token text,                          -- TXT/CNAME proof if needed
  cf_hostname_id text,                              -- Cloudflare custom_hostname id
  dns_checked_at timestamptz,
  cert_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index on custom_domains (org_id);
create index on custom_domains (host);
create index on custom_domains (status);

alter table custom_domains enable row level security;
alter table custom_domains force row level security;
create policy custom_domains_rls on custom_domains
  using (org_id = app.current_org()) with check (org_id = app.current_org());
