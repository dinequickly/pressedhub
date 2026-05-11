-- Explicitly classify media assets so canonical Pressed library imagery,
-- board-local uploads, and generated outputs stop collapsing into one flat
-- tag soup.

alter table public.media_assets
  add column if not exists source_kind text not null default 'board_upload',
  add column if not exists collection_key text,
  add column if not exists product_key text,
  add column if not exists shot_key text,
  add column if not exists board_id uuid references public.vibe_boards(id) on delete set null,
  add column if not exists status text not null default 'ready';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'media_assets_source_kind_check'
  ) then
    alter table public.media_assets
      add constraint media_assets_source_kind_check
      check (source_kind in ('pressed_library', 'board_upload', 'board_generated'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'media_assets_status_check'
  ) then
    alter table public.media_assets
      add constraint media_assets_status_check
      check (status in ('pending', 'ready', 'failed'));
  end if;
end $$;

update public.media_assets
set
  source_kind = case
    when tags @> array['pressed-assets']::text[] then 'pressed_library'
    when tags @> array['board-generated']::text[] then 'board_generated'
    else 'board_upload'
  end,
  collection_key = case
    when tags @> array['pressed-assets']::text[] then coalesce(collection_key, 'pressed-assets')
    when tags @> array['board-generated']::text[] then coalesce(collection_key, 'board-generated')
    else coalesce(collection_key, 'board-uploads')
  end,
  shot_key = case
    when shot_key is not null then shot_key
    when tags @> array['lifestyle']::text[] then 'lifestyle'
    when tags @> array['front']::text[] then 'front'
    when tags @> array['back']::text[] then 'back'
    when tags @> array['blue']::text[] then 'blue-shot'
    else null
  end,
  status = coalesce(status, 'ready');

create index if not exists media_assets_source_kind_idx on public.media_assets(source_kind);
create index if not exists media_assets_collection_key_idx on public.media_assets(collection_key);
create index if not exists media_assets_product_key_idx on public.media_assets(product_key);
create index if not exists media_assets_shot_key_idx on public.media_assets(shot_key);
create index if not exists media_assets_board_id_idx on public.media_assets(board_id);
