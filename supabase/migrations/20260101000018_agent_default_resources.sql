-- Default per-session resources an agent attaches when a chat is started
-- without explicit picks. Shape:
--   { kb_file_ids: uuid[], memory_store_ids: uuid[] }
alter table public.agents
  add column default_resources jsonb not null default '{"kb_file_ids":[],"memory_store_ids":[]}'::jsonb;
