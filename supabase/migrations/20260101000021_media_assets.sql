-- Media assets: brand imagery, video, and any visual reference material the
-- user wants the Image Creator (and future apps) to draw from. Distinct from
-- the KB on purpose — KB is for text documents the agent reads; this is for
-- visual references that get attached to image gen + canvases. Different
-- access patterns, different storage bucket, different agent tools.

create table public.media_assets (
  id uuid primary key default extensions.uuid_generate_v4(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  -- Path inside the supabase storage bucket "media".
  storage_path text not null,
  mime text not null default 'application/octet-stream',
  size_bytes bigint not null default 0,
  width integer,
  height integer,
  tags text[] not null default '{}',
  -- Lazy-uploaded to Anthropic Files the first time an agent attaches this
  -- asset to a session as a reference. Cached forever — Anthropic file_ids
  -- are immutable for the lifetime of the file.
  anthropic_file_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index media_assets_owner_idx on public.media_assets(owner_id);
create index media_assets_tags_idx on public.media_assets using gin(tags);

create trigger media_assets_touch_updated_at
  before update on public.media_assets
  for each row execute procedure public.touch_updated_at();

alter table public.media_assets enable row level security;

create policy media_assets_read on public.media_assets
  for select using (
    owner_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

create policy media_assets_write on public.media_assets
  for all using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Storage bucket. Private; all reads go through signed URLs or service-role
-- proxies (the same approach we use for kb).
insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;

-- Storage RLS — owner can read/delete their own objects under
-- users/<uid>/... .  Service role bypasses RLS so the bulk upload script
-- and edge functions write freely.
drop policy if exists "media_owner_read" on storage.objects;
drop policy if exists "media_owner_delete" on storage.objects;

create policy "media_owner_read"
on storage.objects for select to authenticated
using (
  bucket_id = 'media' and (
    public.is_admin()
    or position(('users/' || auth.uid()::text) in name) = 1
  )
);

create policy "media_owner_delete"
on storage.objects for delete to authenticated
using (
  bucket_id = 'media' and (
    public.is_admin()
    or position(('users/' || auth.uid()::text) in name) = 1
  )
);
