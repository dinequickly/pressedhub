-- Fix the cron fan-out helpers. pg_net's http_post lives in the `net`
-- schema in current Supabase builds (the older `extensions.http_post`
-- alias doesn't exist), and its signature is `(url text, body jsonb,
-- params jsonb, headers jsonb, timeout_milliseconds int)`. The original
-- migrations called `extensions.http_post` with text bodies, threw,
-- and got silently swallowed by `exception when others then null` — so
-- both jobs ran every minute and did nothing. Re-creating both helpers
-- against the correct schema/signature, and surfacing the exception
-- message via raise warning so future breakage is visible in
-- cron.job_run_details rather than vanishing.

create or replace function public.invoke_triggers_schedule() returns void
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
  perform net.http_post(
    url := v_base_url || '/triggers-schedule',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    timeout_milliseconds := 8000
  );
exception when others then
  raise warning 'invoke_triggers_schedule failed: %', sqlerrm;
end;
$$;

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
  perform net.http_post(
    url := v_base_url || '/schedules/tick',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    timeout_milliseconds := 8000
  );
exception when others then
  raise warning 'invoke_agent_schedules_tick failed: %', sqlerrm;
end;
$$;
