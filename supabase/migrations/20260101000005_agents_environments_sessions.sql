-- Agents, Environments, Sessions, Session events. Each row maps 1:1 with the
-- corresponding Anthropic Managed Agents API resource. anthropic_id is what
-- the API returns; the local uuid is what the frontend/RLS reference.

create type public.session_status as enum (
  'idle', 'running', 'rescheduling', 'terminated'
);

create table public.agents (
  id uuid primary key default extensions.uuid_generate_v4(),
  -- Anthropic agent_xxx id returned by POST /v1/agents.
  anthropic_id text unique,
  anthropic_version int not null default 1,
  name text not null,
  role text not null default '',
  emoji text not null default '🤖',
  accent text not null default 'violet',
  -- The model id passed to Anthropic, eg claude-opus-4-7.
  model text not null default 'claude-opus-4-7',
  system_prompt text not null default '',
  instructions text not null default '',
  tools jsonb not null default '[]'::jsonb,
  skills jsonb not null default '[]'::jsonb,
  mcp_servers jsonb not null default '[]'::jsonb,
  -- Optional outcome rubric. Stored locally; sent on session.define_outcome.
  outcome jsonb,
  brain jsonb not null default '[]'::jsonb,
  used_in_workflows jsonb not null default '[]'::jsonb,
  created_by uuid not null references public.profiles(id) on delete restrict,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index agents_created_by_idx on public.agents(created_by);
create index agents_anthropic_id_idx on public.agents(anthropic_id);

create trigger agents_touch_updated_at
  before update on public.agents
  for each row execute procedure public.touch_updated_at();

create table public.environments (
  id uuid primary key default extensions.uuid_generate_v4(),
  anthropic_id text unique,
  name text not null,
  -- The Anthropic config payload (cloud type, networking, packages).
  config jsonb not null default jsonb_build_object(
    'type', 'cloud',
    'networking', jsonb_build_object('type', 'unrestricted')
  ),
  created_by uuid not null references public.profiles(id) on delete restrict,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index environments_created_by_idx on public.environments(created_by);
create index environments_anthropic_id_idx on public.environments(anthropic_id);

create trigger environments_touch_updated_at
  before update on public.environments
  for each row execute procedure public.touch_updated_at();

create table public.sessions (
  id uuid primary key default extensions.uuid_generate_v4(),
  -- Anthropic sesn_xxx id returned by POST /v1/sessions.
  anthropic_id text unique,
  workflow_id uuid references public.workflows(id) on delete set null,
  agent_id uuid not null references public.agents(id) on delete restrict,
  environment_id uuid not null references public.environments(id) on delete restrict,
  -- vault_ids: array of public.vault_connections.id rows referenced at session start.
  vault_connection_ids uuid[] not null default '{}',
  title text,
  status public.session_status not null default 'idle',
  outcome_grade text,
  outcome_evaluations jsonb not null default '[]'::jsonb,
  iteration_count int not null default 0,
  usage jsonb not null default '{}'::jsonb,
  -- The user.message text that started the run, when the session was started by a workflow.
  trigger_payload jsonb,
  trigger_summary text,
  started_by uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index sessions_workflow_idx on public.sessions(workflow_id);
create index sessions_agent_idx on public.sessions(agent_id);
create index sessions_status_idx on public.sessions(status);
create index sessions_anthropic_id_idx on public.sessions(anthropic_id);
create index sessions_started_at_idx on public.sessions(started_at desc);

create trigger sessions_touch_updated_at
  before update on public.sessions
  for each row execute procedure public.touch_updated_at();

-- Append-only event log mirroring the Anthropic SSE stream for this session.
create table public.session_events (
  id uuid primary key default extensions.uuid_generate_v4(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  -- The Anthropic event id (event_xxx). Unique-per-session for dedupe.
  anthropic_event_id text,
  -- {domain}.{action}, eg "agent.message", "session.status_idle".
  event_type text not null,
  -- Full event JSON as proxied from Anthropic.
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index session_events_dedupe_idx
  on public.session_events(session_id, anthropic_event_id)
  where anthropic_event_id is not null;
create index session_events_session_idx on public.session_events(session_id, created_at);
create index session_events_type_idx on public.session_events(event_type);

alter table public.agents enable row level security;
alter table public.environments enable row level security;
alter table public.sessions enable row level security;
alter table public.session_events enable row level security;

-- Members: see what they created. Admins: see all.
create policy agents_read on public.agents
  for select using (created_by = auth.uid() or public.is_admin());
create policy agents_write on public.agents
  for all using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

create policy environments_read on public.environments
  for select using (created_by = auth.uid() or public.is_admin());
create policy environments_write on public.environments
  for all using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

create policy sessions_read on public.sessions
  for select using (
    started_by = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.workflows w
      where w.id = workflow_id and w.created_by = auth.uid()
    )
  );

create policy sessions_write on public.sessions
  for all using (started_by = auth.uid() or public.is_admin())
  with check (started_by = auth.uid() or public.is_admin());

create policy session_events_visible_with_session on public.session_events
  for all using (
    exists (
      select 1 from public.sessions s
      where s.id = session_id and (
        s.started_by = auth.uid()
        or public.is_admin()
        or exists (
          select 1 from public.workflows w where w.id = s.workflow_id and w.created_by = auth.uid()
        )
      )
    )
  ) with check (true);

-- runs view: alias over sessions for the /runs gallery. Joins basic counts.
create or replace view public.runs as
  select
    s.id,
    s.workflow_id,
    s.anthropic_id as session_id,
    s.status,
    s.title as trigger_summary,
    s.trigger_summary as trigger_summary_text,
    s.started_at,
    s.finished_at,
    s.outcome_grade,
    s.iteration_count,
    s.usage,
    extract(epoch from (coalesce(s.finished_at, now()) - s.started_at)) * 1000 as duration_ms
  from public.sessions s;
