-- Marketing timeline tables: campaigns, metrics, annotations.
--
-- These are workspace-shared data — every authed user can read; only admins
-- can write (the bulk seed script + future connectors will run service-role).
-- This is the data backing the visual timeline on the vibe board, the
-- agent's list_campaigns / get_metrics tools, and (eventually) the marketing
-- brain memory store.

create table public.campaigns (
  id uuid primary key default extensions.uuid_generate_v4(),
  name text not null,
  channel text not null check (channel in ('email','paid','organic','in_store','retail','other')),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  description text not null default '',
  -- Free-form metadata so connectors can attach source-specific fields
  -- (audience size, ad creative ids, klaviyo flow id, etc.) without us
  -- having to migrate every time a new source is wired.
  metadata jsonb not null default '{}',
  source text not null default 'seed',
  source_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index campaigns_channel_idx on public.campaigns(channel);
create index campaigns_started_idx on public.campaigns(started_at);

create trigger campaigns_touch_updated_at
  before update on public.campaigns
  for each row execute procedure public.touch_updated_at();

create table public.metrics (
  id uuid primary key default extensions.uuid_generate_v4(),
  -- sessions | revenue | ctr | conversion | orders | spend | impressions ...
  kind text not null,
  occurred_at timestamptz not null,
  value double precision not null,
  -- { channel: 'email', campaign_id: '...', location: 'NYC', ... }
  dimensions jsonb not null default '{}',
  source text not null default 'seed',
  created_at timestamptz not null default now()
);

create index metrics_kind_time_idx on public.metrics(kind, occurred_at);

create table public.annotations (
  id uuid primary key default extensions.uuid_generate_v4(),
  at timestamptz not null,
  label text not null,
  -- product | holiday | weather | competition | team | other
  kind text not null check (kind in ('product','holiday','weather','competition','team','other')),
  description text not null default '',
  source text not null default 'seed',
  created_at timestamptz not null default now()
);

create index annotations_at_idx on public.annotations(at);

alter table public.campaigns enable row level security;
alter table public.metrics enable row level security;
alter table public.annotations enable row level security;

-- All authed users can read marketing data. Admin-only writes for now.
create policy campaigns_read on public.campaigns for select using (auth.role() = 'authenticated');
create policy metrics_read on public.metrics for select using (auth.role() = 'authenticated');
create policy annotations_read on public.annotations for select using (auth.role() = 'authenticated');

create policy campaigns_admin_write on public.campaigns
  for all using (public.is_admin()) with check (public.is_admin());
create policy metrics_admin_write on public.metrics
  for all using (public.is_admin()) with check (public.is_admin());
create policy annotations_admin_write on public.annotations
  for all using (public.is_admin()) with check (public.is_admin());
