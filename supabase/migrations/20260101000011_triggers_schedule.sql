-- Workflow triggers: webhook tokens, schedule cron rows, inbound email addresses.
-- pg_cron schedules a server-side fan-out function once a minute that calls the
-- triggers-schedule edge function for each due row.

create type public.trigger_kind as enum ('webhook', 'schedule', 'email_inbound', 'manual');

create table public.workflow_triggers (
  id uuid primary key default extensions.uuid_generate_v4(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  kind public.trigger_kind not null,
  -- For webhook: { token, path }
  -- For schedule: { mode: "interval"|"cron", interval_minutes?, cron?, last_run_at, next_run_at }
  -- For email_inbound: { local_part } (the @app inbox local part)
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index workflow_triggers_workflow_idx on public.workflow_triggers(workflow_id);
create index workflow_triggers_kind_idx on public.workflow_triggers(kind);
create unique index workflow_triggers_webhook_token_idx
  on public.workflow_triggers((config->>'token'))
  where kind = 'webhook' and config ? 'token';
create unique index workflow_triggers_email_local_part_idx
  on public.workflow_triggers((config->>'local_part'))
  where kind = 'email_inbound' and config ? 'local_part';

create trigger workflow_triggers_touch_updated_at
  before update on public.workflow_triggers
  for each row execute procedure public.touch_updated_at();

alter table public.workflow_triggers enable row level security;

create policy workflow_triggers_read on public.workflow_triggers
  for select using (
    created_by = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.workflows w where w.id = workflow_id and w.created_by = auth.uid())
  );

create policy workflow_triggers_write on public.workflow_triggers
  for all using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

-- Server-side fan-out: pg_cron runs every minute, picks all due triggers, and
-- enqueues a one-shot HTTP call to the triggers-schedule edge function. The
-- edge function itself does the workflow run.
create or replace function public.due_schedule_triggers(now_ts timestamptz default now())
returns table (
  trigger_id uuid,
  workflow_id uuid,
  config jsonb
)
language sql
stable
security invoker
as $$
  select
    t.id as trigger_id,
    t.workflow_id,
    t.config
  from public.workflow_triggers t
  join public.workflows w on w.id = t.workflow_id
  where t.kind = 'schedule'
    and t.enabled
    and w.enabled
    and (
      (t.config->>'next_run_at')::timestamptz is null
      or (t.config->>'next_run_at')::timestamptz <= now_ts
    );
$$;

-- Mark a schedule trigger as run, advancing next_run_at by interval_minutes.
create or replace function public.advance_schedule_trigger(p_trigger_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg jsonb;
  interval_min int;
begin
  select config into cfg from public.workflow_triggers where id = p_trigger_id;
  if cfg is null then return; end if;
  interval_min := coalesce((cfg->>'interval_minutes')::int, 60);
  update public.workflow_triggers
  set config = jsonb_set(
    jsonb_set(cfg, '{last_run_at}', to_jsonb(now()::text)),
    '{next_run_at}',
    to_jsonb((now() + (interval_min || ' minutes')::interval)::text)
  )
  where id = p_trigger_id;
end;
$$;
