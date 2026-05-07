-- Knowledge base: virtual folder hierarchy, files (in Storage), and chunks.
-- Embeddings are stubbed in v1; the kb_chunks.embedding column is left
-- nullable and the kb-embed function writes a zero vector. Replace the stub
-- with a real embedding call when ready.

create type public.file_status as enum ('uploaded', 'extracted', 'chunked', 'embedded', 'failed');
create type public.file_kind as enum ('pdf', 'doc', 'transcript', 'sheet', 'report', 'image', 'email', 'other');

create table public.kb_folders (
  id uuid primary key default extensions.uuid_generate_v4(),
  parent_id uuid references public.kb_folders(id) on delete cascade,
  name text not null,
  path text not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (parent_id, name)
);

create index kb_folders_parent_idx on public.kb_folders(parent_id);
create index kb_folders_path_idx on public.kb_folders(path);

create trigger kb_folders_touch_updated_at
  before update on public.kb_folders
  for each row execute procedure public.touch_updated_at();

create table public.kb_files (
  id uuid primary key default extensions.uuid_generate_v4(),
  folder_id uuid references public.kb_folders(id) on delete set null,
  name text not null,
  -- Path inside the supabase storage bucket "kb".
  storage_path text not null,
  mime text not null default 'application/octet-stream',
  size_bytes bigint not null default 0,
  kind public.file_kind not null default 'other',
  status public.file_status not null default 'uploaded',
  snippet text not null default '',
  tags text[] not null default '{}',
  uploaded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index kb_files_folder_idx on public.kb_files(folder_id);
create index kb_files_status_idx on public.kb_files(status);
create index kb_files_tags_idx on public.kb_files using gin (tags);

create trigger kb_files_touch_updated_at
  before update on public.kb_files
  for each row execute procedure public.touch_updated_at();

create table public.kb_tags (
  id uuid primary key default extensions.uuid_generate_v4(),
  name text unique not null,
  color text not null default 'neutral',
  created_at timestamptz not null default now()
);

create table public.kb_chunks (
  id uuid primary key default extensions.uuid_generate_v4(),
  file_id uuid not null references public.kb_files(id) on delete cascade,
  ord int not null,
  text text not null,
  -- pgvector(1536). Nullable until kb-embed runs.
  embedding extensions.vector(1536),
  created_at timestamptz not null default now()
);

create index kb_chunks_file_idx on public.kb_chunks(file_id, ord);
-- IVFFlat index over the embedding column. Created with `lists = 100` which is
-- fine for the small v1 corpus; tune at scale.
create index kb_chunks_embedding_idx
  on public.kb_chunks
  using ivfflat (embedding extensions.vector_cosine_ops)
  with (lists = 100);

alter table public.kb_folders enable row level security;
alter table public.kb_files enable row level security;
alter table public.kb_tags enable row level security;
alter table public.kb_chunks enable row level security;

create policy kb_folders_read on public.kb_folders
  for select using (auth.role() = 'authenticated');
create policy kb_folders_write on public.kb_folders
  for all using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

create policy kb_files_read on public.kb_files
  for select using (auth.role() = 'authenticated');
create policy kb_files_write on public.kb_files
  for all using (uploaded_by = auth.uid() or public.is_admin())
  with check (uploaded_by = auth.uid() or public.is_admin());

create policy kb_tags_read on public.kb_tags
  for select using (auth.role() = 'authenticated');
create policy kb_tags_write on public.kb_tags
  for all using (public.is_admin()) with check (public.is_admin());

create policy kb_chunks_inherit on public.kb_chunks
  for all using (
    exists (
      select 1 from public.kb_files f
      where f.id = file_id and (f.uploaded_by = auth.uid() or public.is_admin() or auth.role() = 'authenticated')
    )
  ) with check (
    exists (
      select 1 from public.kb_files f
      where f.id = file_id and (f.uploaded_by = auth.uid() or public.is_admin())
    )
  );

-- Cosine similarity search RPC. Returns the nearest chunks to a query vector,
-- joined to the parent file metadata for citation. Will return uniform results
-- until embeddings are real.
create or replace function public.kb_search(
  query_embedding extensions.vector(1536),
  match_limit int default 8,
  filter_folder_id uuid default null
)
returns table (
  chunk_id uuid,
  file_id uuid,
  file_name text,
  ord int,
  similarity float,
  text text,
  tags text[]
)
language sql
stable
security invoker
as $$
  select
    c.id as chunk_id,
    c.file_id,
    f.name as file_name,
    c.ord,
    1 - (c.embedding <=> query_embedding) as similarity,
    c.text,
    f.tags
  from public.kb_chunks c
  join public.kb_files f on f.id = c.file_id
  where c.embedding is not null
    and (filter_folder_id is null or f.folder_id = filter_folder_id)
  order by c.embedding <=> query_embedding
  limit greatest(match_limit, 1);
$$;

-- Storage bucket for KB files. Created idempotently.
insert into storage.buckets (id, name, public)
values ('kb', 'kb', false)
on conflict (id) do nothing;
