-- Timeline KB-sync state.
--
-- One row per KB file we ingest into the timeline tables. We compare the
-- KB file's updated_at to last_synced_at on every /timeline GET — if newer,
-- we re-parse the CSV and reload the matching table rows. Cheap, idempotent,
-- self-healing. No cron required.

create table public.timeline_sync_state (
  -- Logical name: 'campaigns' | 'metrics' | 'annotations'.
  resource text primary key,
  -- The kb_file we last pulled this resource from.
  kb_file_id uuid references public.kb_files(id) on delete set null,
  last_synced_at timestamptz,
  last_kb_updated_at timestamptz,
  rows_synced integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Service-role only — sync logic always runs server-side.
alter table public.timeline_sync_state enable row level security;
create policy timeline_sync_state_admin_read on public.timeline_sync_state
  for select using (public.is_admin());
