-- Memory stores: scoped key-value/document spaces agents read and write.
create type public.memory_scope as enum ('workflow', 'user', 'shared');
create type public.dream_status as enum ('pending', 'running', 'completed', 'failed', 'canceled', 'approved', 'rejected');

create table public.memory_stores (
  id uuid primary key default extensions.uuid_generate_v4(),
  name text not null,
  description text not null default '',
  scope public.memory_scope not null,
  workflow_id uuid references public.workflows(id) on delete set null,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  total_versions int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index memory_stores_workflow_idx on public.memory_stores(workflow_id);
create index memory_stores_owner_idx on public.memory_stores(owner_id);
create index memory_stores_scope_idx on public.memory_stores(scope);

create trigger memory_stores_touch_updated_at
  before update on public.memory_stores
  for each row execute procedure public.touch_updated_at();

-- Markdown documents living inside a memory store.
create table public.memory_documents (
  id uuid primary key default extensions.uuid_generate_v4(),
  store_id uuid not null references public.memory_stores(id) on delete cascade,
  -- Human-readable path, eg "context/quarterly_goals.md".
  path text not null,
  content text not null default '',
  size_bytes int not null default 0,
  version_count int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, path)
);

create index memory_documents_store_idx on public.memory_documents(store_id);

create trigger memory_documents_touch_updated_at
  before update on public.memory_documents
  for each row execute procedure public.touch_updated_at();

-- Structured tables. memory_tables defines the schema, memory_table_rows holds rows.
create table public.memory_tables (
  id uuid primary key default extensions.uuid_generate_v4(),
  store_id uuid not null references public.memory_stores(id) on delete cascade,
  name text not null,
  -- jsonb schema { columns: [{name, type}] }
  schema jsonb not null default '{"columns": []}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, name)
);

create index memory_tables_store_idx on public.memory_tables(store_id);

create trigger memory_tables_touch_updated_at
  before update on public.memory_tables
  for each row execute procedure public.touch_updated_at();

create table public.memory_table_rows (
  id uuid primary key default extensions.uuid_generate_v4(),
  table_id uuid not null references public.memory_tables(id) on delete cascade,
  row jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index memory_table_rows_table_idx on public.memory_table_rows(table_id);
create index memory_table_rows_row_idx on public.memory_table_rows using gin (row jsonb_path_ops);

create trigger memory_table_rows_touch_updated_at
  before update on public.memory_table_rows
  for each row execute procedure public.touch_updated_at();

-- Dreams: proposed mass-edits to a memory store, awaiting approve/reject.
create table public.dreams (
  id uuid primary key default extensions.uuid_generate_v4(),
  store_id uuid not null references public.memory_stores(id) on delete cascade,
  status public.dream_status not null default 'pending',
  -- Snapshot of every doc before the dream proposes its diff.
  old_snapshot jsonb not null default '[]'::jsonb,
  -- Proposed new state.
  new_snapshot jsonb not null default '[]'::jsonb,
  -- Optional rendered diff payload {added:[], removed:[], changed:[]}.
  diff jsonb,
  instructions text,
  session_count int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

create index dreams_store_idx on public.dreams(store_id);
create index dreams_status_idx on public.dreams(status);

alter table public.memory_stores enable row level security;
alter table public.memory_documents enable row level security;
alter table public.memory_tables enable row level security;
alter table public.memory_table_rows enable row level security;
alter table public.dreams enable row level security;

-- Owner sees own. Shared scope is visible to all authenticated. Admins see all.
create policy memory_stores_read on public.memory_stores
  for select using (
    owner_id = auth.uid()
    or scope = 'shared'
    or public.is_admin()
  );

create policy memory_stores_write on public.memory_stores
  for all using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

-- Children inherit visibility from the parent store.
create policy memory_documents_inherit on public.memory_documents
  for all using (
    exists (
      select 1 from public.memory_stores s
      where s.id = store_id and (
        s.owner_id = auth.uid() or s.scope = 'shared' or public.is_admin()
      )
    )
  ) with check (
    exists (
      select 1 from public.memory_stores s
      where s.id = store_id and (s.owner_id = auth.uid() or public.is_admin())
    )
  );

create policy memory_tables_inherit on public.memory_tables
  for all using (
    exists (
      select 1 from public.memory_stores s
      where s.id = store_id and (
        s.owner_id = auth.uid() or s.scope = 'shared' or public.is_admin()
      )
    )
  ) with check (
    exists (
      select 1 from public.memory_stores s
      where s.id = store_id and (s.owner_id = auth.uid() or public.is_admin())
    )
  );

create policy memory_table_rows_inherit on public.memory_table_rows
  for all using (
    exists (
      select 1
      from public.memory_tables t
      join public.memory_stores s on s.id = t.store_id
      where t.id = table_id and (
        s.owner_id = auth.uid() or s.scope = 'shared' or public.is_admin()
      )
    )
  ) with check (
    exists (
      select 1
      from public.memory_tables t
      join public.memory_stores s on s.id = t.store_id
      where t.id = table_id and (s.owner_id = auth.uid() or public.is_admin())
    )
  );

create policy dreams_inherit on public.dreams
  for all using (
    exists (
      select 1 from public.memory_stores s
      where s.id = store_id and (
        s.owner_id = auth.uid() or s.scope = 'shared' or public.is_admin()
      )
    )
  ) with check (
    exists (
      select 1 from public.memory_stores s
      where s.id = store_id and (s.owner_id = auth.uid() or public.is_admin())
    )
  );
