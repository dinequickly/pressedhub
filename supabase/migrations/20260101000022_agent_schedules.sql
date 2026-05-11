-- Per-agent recurring schedules. Independent of `workflow_triggers`: those
-- schedule a *workflow*, these schedule a single agent session directly so
-- the user can spin up a roster of always-on workers.

create type public.schedule_status as enum ('active', 'paused');
create type public.schedule_run_status as enum (
  'pending', 'running', 'success', 'failed', 'skipped'
);

create table public.agent_schedules (
  id uuid primary key default extensions.uuid_generate_v4(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  environment_id uuid references public.environments(id) on delete set null,
  name text not null,
  -- Canonical 5-field cron expression (`m h dom mon dow`). The frontend
  -- compiles preset frequencies into this, but we store nothing fancier so
  -- the worker can use a single library to compute next ticks.
  cron text not null,
  timezone text not null default 'UTC',
  -- The kickoff message we send to the session as the first user.message.
  -- Optional — if null the agent just wakes with no input.
  trigger_message text,
  trigger_payload jsonb not null default '{}'::jsonb,
  status public.schedule_status not null default 'active',
  -- If true and the previous run is still running/idle (not terminated), the
  -- worker logs a 'skipped' run and advances next_run_at without starting.
  skip_if_running boolean not null default true,
  last_run_at timestamptz,
  last_session_id uuid references public.sessions(id) on delete set null,
  next_run_at timestamptz not null,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index agent_schedules_due_idx
  on public.agent_schedules(next_run_at)
  where status = 'active';
create index agent_schedules_agent_idx on public.agent_schedules(agent_id);
create index agent_schedules_owner_idx on public.agent_schedules(created_by);

create trigger agent_schedules_touch_updated_at
  before update on public.agent_schedules
  for each row execute procedure public.touch_updated_at();

create table public.schedule_runs (
  id uuid primary key default extensions.uuid_generate_v4(),
  schedule_id uuid not null references public.agent_schedules(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  -- The wall-clock tick this run was meant to satisfy. Used so a user can
  -- see "missed runs" if the worker was down — `started_at - scheduled_for`
  -- is the lateness.
  scheduled_for timestamptz not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status public.schedule_run_status not null default 'pending',
  error text
);

create index schedule_runs_schedule_idx
  on public.schedule_runs(schedule_id, started_at desc);

alter table public.agent_schedules enable row level security;
alter table public.schedule_runs enable row level security;

-- Owner of the schedule = owner of the agent in 99% of cases. We gate via
-- `created_by` to keep the policy cheap; admins always allowed.
create policy agent_schedules_read on public.agent_schedules
  for select using (created_by = auth.uid() or public.is_admin());
create policy agent_schedules_write on public.agent_schedules
  for all using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

create policy schedule_runs_read on public.schedule_runs
  for select using (
    public.is_admin()
    or exists (
      select 1 from public.agent_schedules s
      where s.id = schedule_id and s.created_by = auth.uid()
    )
  );
-- No user-side write policy: only the worker (service role) writes here.
