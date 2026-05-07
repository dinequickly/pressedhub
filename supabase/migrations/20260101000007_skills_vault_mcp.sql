-- Skills, Vault connections (per-user OAuth), MCP servers.

create type public.skill_type as enum ('anthropic', 'custom');
create type public.connection_status as enum ('connected', 'expired', 'never');

create table public.skills (
  id uuid primary key default extensions.uuid_generate_v4(),
  -- Anthropic skill id (skill_xxx) for custom skills, or short name for anthropic skills.
  anthropic_skill_id text unique,
  type public.skill_type not null default 'custom',
  name text not null,
  description text not null default '',
  version text not null default 'latest',
  -- The full SKILL.md body.
  content_md text not null default '',
  pinned boolean not null default false,
  used_in_workflows jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index skills_type_idx on public.skills(type);
create index skills_anthropic_skill_id_idx on public.skills(anthropic_skill_id);

create trigger skills_touch_updated_at
  before update on public.skills
  for each row execute procedure public.touch_updated_at();

-- MCP servers a user has registered. Per-user.
create table public.mcp_servers (
  id uuid primary key default extensions.uuid_generate_v4(),
  name text not null,
  url text not null,
  description text not null default '',
  -- Free-form labels: { auth_type: "oauth"|"static_bearer", scopes: [...] }.
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (created_by, name)
);

create index mcp_servers_created_by_idx on public.mcp_servers(created_by);

create trigger mcp_servers_touch_updated_at
  before update on public.mcp_servers
  for each row execute procedure public.touch_updated_at();

-- Vault connection: a saved OAuth/bearer credential, registered with Anthropic Vaults.
-- Each connection is per-user, per-connector. anthropic_vault_id and
-- anthropic_credential_id reference the Anthropic-side state.
create table public.vault_connections (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  connector_id text not null references public.connectors(id) on delete restrict,
  account_label text not null,
  status public.connection_status not null default 'never',
  scopes text[] not null default '{}',
  mcp_server_url text,
  anthropic_vault_id text,
  anthropic_credential_id text,
  connected_at timestamptz,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, connector_id, account_label)
);

create index vault_connections_user_idx on public.vault_connections(user_id);
create index vault_connections_connector_idx on public.vault_connections(connector_id);
create index vault_connections_status_idx on public.vault_connections(status);

create trigger vault_connections_touch_updated_at
  before update on public.vault_connections
  for each row execute procedure public.touch_updated_at();

alter table public.skills enable row level security;
alter table public.mcp_servers enable row level security;
alter table public.vault_connections enable row level security;

-- Skills are org-level: every authenticated user can read; creators or admins write.
create policy skills_read on public.skills
  for select using (auth.role() = 'authenticated');

create policy skills_write on public.skills
  for all using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

create policy mcp_servers_read on public.mcp_servers
  for select using (created_by = auth.uid() or public.is_admin());

create policy mcp_servers_write on public.mcp_servers
  for all using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

create policy vault_connections_read on public.vault_connections
  for select using (user_id = auth.uid() or public.is_admin());

create policy vault_connections_write on public.vault_connections
  for all using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
