-- MKB Growth Portal — initial schema
-- Supabase / Postgres 15+

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────
-- Accounts
-- ─────────────────────────────────────────────────────────────

create table accounts (
  id             uuid primary key default gen_random_uuid(),
  company_name   text not null,
  website        text,
  industry       text,
  status         text not null default 'onboarding'
                 check (status in ('onboarding','active','paused','churned')),
  avg_deal_value numeric,          -- gemiddelde klantwaarde in euro
  conv_rate      numeric,          -- 0-1, uit GA4 of handmatig
  created_at     timestamptz not null default now()
);

create table account_users (
  account_id uuid references accounts(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete cascade,
  role       text not null default 'member' check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  primary key (account_id, user_id)
);

create table onboarding_steps (
  account_id   uuid references accounts(id) on delete cascade,
  step         text not null,
  completed_at timestamptz,
  primary key (account_id, step)
);

-- ─────────────────────────────────────────────────────────────
-- Google koppelingen
-- ─────────────────────────────────────────────────────────────

create table google_connections (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references accounts(id) on delete cascade,
  google_email   text not null,
  refresh_token  bytea not null,   -- AES-256-GCM, app-side versleuteld
  scopes         text[] not null default '{}',
  status         text not null default 'active'
                 check (status in ('active','revoked','error')),
  last_error     text,
  last_synced_at timestamptz,
  created_at     timestamptz not null default now()
);
create index on google_connections (account_id);

create table gsc_properties (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  connection_id uuid not null references google_connections(id) on delete cascade,
  site_url      text not null,     -- 'sc-domain:example.nl'
  permission    text,
  is_active     boolean not null default true,
  backfilled_at timestamptz,
  created_at    timestamptz not null default now(),
  unique (connection_id, site_url)
);
create index on gsc_properties (account_id) where is_active;

create table ga4_properties (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  connection_id uuid not null references google_connections(id) on delete cascade,
  property_id   text not null,     -- 'properties/123456789'
  display_name  text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (connection_id, property_id)
);

-- Welke GA4-events tellen als aanvraag
create table ga4_conversion_events (
  account_id  uuid references accounts(id) on delete cascade,
  event_name  text not null,
  is_lead     boolean not null default true,
  primary key (account_id, event_name)
);

-- ─────────────────────────────────────────────────────────────
-- Metrics
-- ─────────────────────────────────────────────────────────────

create table gsc_query_daily (
  id          bigserial primary key,
  account_id  uuid not null references accounts(id) on delete cascade,
  property_id uuid not null references gsc_properties(id) on delete cascade,
  date        date not null,
  query       text not null,
  device      text,
  clicks      int  not null default 0,
  impressions int  not null default 0,
  position    numeric(6,2),
  ctr         numeric(6,4)
);
create unique index gsc_query_daily_uniq on gsc_query_daily
  (property_id, date, md5(query), coalesce(device,''));
create index on gsc_query_daily (account_id, date);

create table gsc_page_daily (
  id          bigserial primary key,
  account_id  uuid not null references accounts(id) on delete cascade,
  property_id uuid not null references gsc_properties(id) on delete cascade,
  date        date not null,
  page        text not null,
  clicks      int  not null default 0,
  impressions int  not null default 0,
  position    numeric(6,2),
  ctr         numeric(6,4)
);
create unique index gsc_page_daily_uniq on gsc_page_daily
  (property_id, date, md5(page));
create index on gsc_page_daily (account_id, date);

-- query x page: alleen recent, groeit hard
create table gsc_query_page_recent (
  id          bigserial primary key,
  account_id  uuid not null references accounts(id) on delete cascade,
  property_id uuid not null references gsc_properties(id) on delete cascade,
  date        date not null,
  query       text not null,
  page        text not null,
  clicks      int  not null default 0,
  impressions int  not null default 0,
  position    numeric(6,2)
);
create unique index gsc_qp_uniq on gsc_query_page_recent
  (property_id, date, md5(query), md5(page));
create index on gsc_query_page_recent (account_id, date);

create table ga4_daily (
  id               bigserial primary key,
  account_id       uuid not null references accounts(id) on delete cascade,
  property_id      uuid not null references ga4_properties(id) on delete cascade,
  date             date not null,
  channel_group    text,
  landing_page     text,
  sessions         int  not null default 0,
  users            int  not null default 0,
  engaged_sessions int  not null default 0,
  conversions      numeric not null default 0,
  revenue          numeric not null default 0
);
create unique index ga4_daily_uniq on ga4_daily
  (property_id, date, coalesce(channel_group,''), md5(coalesce(landing_page,'')));
create index on ga4_daily (account_id, date);

-- ─────────────────────────────────────────────────────────────
-- Kansen en acties
-- ─────────────────────────────────────────────────────────────

create table opportunities (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  type          text not null check (type in
                 ('striking_distance','low_ctr','missing_page',
                  'decay','cannibalisation','conv_gap')),
  query         text,
  page          text,
  impressions   int,
  position      numeric(6,2),
  current_ctr   numeric(6,4),
  extra_clicks  int,
  value_eur     numeric,
  effort        text not null default 'medium'
                 check (effort in ('low','medium','high')),
  priority      numeric,
  status        text not null default 'open'
                 check (status in ('open','in_progress','done','dismissed')),
  evidence      jsonb,
  first_seen_at timestamptz not null default now(),
  resolved_at   timestamptz
);
create index on opportunities (account_id, status, priority desc);
create unique index opportunities_open_uniq on opportunities
  (account_id, type, md5(coalesce(query,'')), md5(coalesce(page,'')))
  where status = 'open';

create table actions (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references accounts(id) on delete cascade,
  opportunity_id uuid references opportunities(id) on delete set null,
  kind           text not null check (kind in
                  ('new_page','rewrite','meta_fix','merge_pages')),
  status         text not null default 'queued' check (status in
                  ('queued','generating','review','approved','published','failed')),
  brief          jsonb,
  document_id    uuid,             -- Blogfinity document
  published_url  text,
  error          text,
  created_at     timestamptz not null default now(),
  published_at   timestamptz
);
create index on actions (account_id, status);

create table action_outcomes (
  action_id       uuid primary key references actions(id) on delete cascade,
  baseline_clicks int,
  baseline_pos    numeric(6,2),
  after_clicks    int,
  after_pos       numeric(6,2),
  delta_value_eur numeric,
  measured_at     timestamptz
);

-- ─────────────────────────────────────────────────────────────
-- Job logging
-- ─────────────────────────────────────────────────────────────

create table sync_runs (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid references accounts(id) on delete cascade,
  job          text not null,
  status       text not null default 'running'
               check (status in ('running','ok','failed')),
  rows_written int default 0,
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index on sync_runs (account_id, job, started_at desc);

-- ─────────────────────────────────────────────────────────────
-- RLS
-- account_id komt als claim in de JWT bij login
-- ─────────────────────────────────────────────────────────────

create or replace function current_account_id() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'account_id', '')::uuid;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'accounts','account_users','onboarding_steps',
    'google_connections','gsc_properties','ga4_properties',
    'ga4_conversion_events','gsc_query_daily','gsc_page_daily',
    'gsc_query_page_recent','ga4_daily','opportunities','actions','sync_runs'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- accounts matcht op id, de rest op account_id
create policy account_self on accounts
  for select using (id = current_account_id());

do $$
declare t text;
begin
  foreach t in array array[
    'account_users','onboarding_steps','google_connections',
    'gsc_properties','ga4_properties','ga4_conversion_events',
    'gsc_query_daily','gsc_page_daily','gsc_query_page_recent',
    'ga4_daily','opportunities','actions','sync_runs'
  ] loop
    execute format(
      'create policy account_isolation on %I for select using (account_id = current_account_id())', t);
  end loop;
end $$;

-- action_outcomes via de action
create policy outcome_isolation on action_outcomes for select using (
  exists (select 1 from actions a
          where a.id = action_outcomes.action_id
            and a.account_id = current_account_id())
);
alter table action_outcomes enable row level security;

-- Workers gebruiken de service role key en omzeilen RLS.
-- Schrijfrechten voor eindgebruikers lopen via de API, niet direct op tabellen.
