-- Connector registry: the catalog of every integration the app supports.
-- Seeded from the frontend's data/connectors.tsx — keep ids/names in sync.
create type public.connector_group as enum ('apps', 'system', 'ai');

create table public.connectors (
  id text primary key,
  name text not null,
  "group" public.connector_group not null,
  icon_class text not null default '',
  tint text not null default '',
  -- operations: { [op_id]: { id, label, filterableFields?, configFields? } }
  operations jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index connectors_group_idx on public.connectors("group");

create trigger connectors_touch_updated_at
  before update on public.connectors
  for each row execute procedure public.touch_updated_at();

alter table public.connectors enable row level security;

-- Connector catalog is readable by every authenticated user.
create policy connectors_read_all on public.connectors
  for select using (auth.role() = 'authenticated' or auth.role() = 'anon');

-- Only admins can mutate the registry.
create policy connectors_admin_write on public.connectors
  for all using (public.is_admin()) with check (public.is_admin());
