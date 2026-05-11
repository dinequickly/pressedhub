-- Vibe boards for the Image Creator app.
--
-- Each board is a per-user JSON document of canvas items (images, prompts,
-- references, notes) plus an anthropic session id once the user has started
-- chatting on this board with the Director agent. The session is persistent
-- per board so the conversation carries across visits.
--
-- The state shape is intentionally schemaless on the DB side — items are a
-- JSON array. The frontend + a TS type in api.ts are the source of truth for
-- the shape; let the canvas evolve without migrations.

create table public.vibe_boards (
  id uuid primary key default extensions.uuid_generate_v4(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null default 'Untitled board',
  state jsonb not null default '{"items": []}'::jsonb,
  -- The Anthropic session id (sesn_…) the Director agent uses for this board.
  -- Lazy-created the first time the user sends a message on the board.
  session_id uuid references public.sessions(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index vibe_boards_owner_idx on public.vibe_boards(owner_id);
create index vibe_boards_session_idx on public.vibe_boards(session_id);

create trigger vibe_boards_touch_updated_at
  before update on public.vibe_boards
  for each row execute procedure public.touch_updated_at();

alter table public.vibe_boards enable row level security;

-- Users only see and manage their own boards. Admins read all (matches the
-- pattern used for memory_stores / kb_files).
create policy vibe_boards_read on public.vibe_boards
  for select using (
    owner_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

create policy vibe_boards_write on public.vibe_boards
  for all using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
