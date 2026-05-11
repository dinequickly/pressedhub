-- Once-a-minute fan-out for agent_schedules. Mirrors the existing pattern
-- in 20260101000013: read base url + service role key from `app_settings`,
-- POST a tick request to /functions/v1/schedules/tick. The edge function
-- itself does the actual work (claim due rows, start sessions, advance
-- next_run_at). Keeping the SQL trivial means we don't need to ship a
-- cron-parser inside Postgres.

-- Claim up to N due schedules. FOR UPDATE SKIP LOCKED so concurrent ticks
-- (e.g., a backed-up worker plus this minute's run) never double-fire.
-- Returns the full row so the caller has agent_id, cron, tz, etc. to
-- start the session and advance next_run_at without a second round trip.
create or replace function public.claim_due_schedules(p_limit int default 50)
returns setof public.agent_schedules
language sql
security definer
set search_path = public
as $$
  with claimed as (
    select id
    from public.agent_schedules
    where status = 'active'
      and next_run_at <= now()
    order by next_run_at
    for update skip locked
    limit p_limit
  )
  select s.*
  from public.agent_schedules s
  join claimed c on c.id = s.id;
$$;

-- Only the service-role caller (cron worker) needs this — it does the
-- claim-and-start-session work that bypasses user RLS. Lock it down.
revoke execute on function public.claim_due_schedules(int) from public, anon, authenticated;
grant execute on function public.claim_due_schedules(int) to service_role;


create or replace function public.invoke_agent_schedules_tick() returns void
language plpgsql
security definer
as $$
declare
  v_base_url text;
  v_key text;
begin
  select value into v_base_url from public.app_settings where key = 'edge_functions_base_url';
  select value into v_key from public.app_settings where key = 'service_role_key';
  if v_base_url is null or v_key is null or v_key = '' then
    return;
  end if;
  begin
    perform extensions.http_post(
      url := v_base_url || '/schedules/tick',
      body := '{}'::text,
      params := ''::text,
      headers := ('{"Content-Type": "application/json", "Authorization": "Bearer ' || v_key || '"}')::jsonb,
      timeout_milliseconds := 8000
    );
  exception when others then
    null;
  end;
end;
$$;

select cron.schedule(
  'hubbackend_agent_schedules_tick',
  '* * * * *',
  $$select public.invoke_agent_schedules_tick();$$
);
