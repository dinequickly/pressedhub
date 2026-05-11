-- Mirror local KB files and memory stores onto Anthropic so they can be
-- attached to sessions as `resources`. Both columns nullable since older
-- rows weren't synced and may never be (e.g. binary files we don't upload).

alter table public.kb_files
  add column anthropic_file_id text;

create index kb_files_anthropic_file_idx
  on public.kb_files(anthropic_file_id)
  where anthropic_file_id is not null;

alter table public.memory_stores
  add column anthropic_id text;

create index memory_stores_anthropic_idx
  on public.memory_stores(anthropic_id)
  where anthropic_id is not null;
