-- pg_cron job that fires once a minute and asks the triggers-schedule edge
-- function to fan out due schedule triggers. The function URL and service
-- role key are read from a tiny app_settings table so we don't need to
-- redeploy the migration just to change them.

create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Defaults: edge function URL relative to the local stack. In production,
-- the deploy script overwrites these to the real values.
insert into public.app_settings (key, value) values
  ('edge_functions_base_url', 'http://host.docker.internal:54321/functions/v1'),
  ('service_role_key', '')
on conflict (key) do nothing;

create or replace function public.invoke_triggers_schedule() returns void
language plpgsql
security definer
as $$
declare
  base_url text;
  key text;
  request_id bigint;
begin
  select value into base_url from public.app_settings where key = 'edge_functions_base_url';
  select value into key from public.app_settings where key = 'service_role_key';
  if base_url is null or key is null or key = '' then
    return;
  end if;
  -- pg_net is bundled with Supabase. Fall back silently if it's not installed.
  begin
    perform extensions.http_post(
      url := base_url || '/triggers-schedule',
      body := '{}'::text,
      params := ''::text,
      headers := ('{"Content-Type": "application/json", "Authorization": "Bearer ' || key || '"}')::jsonb,
      timeout_milliseconds := 8000
    );
  exception when others then
    -- pg_net.http_post is the supabase-default extension; fall back when missing.
    null;
  end;
end;
$$;

-- Schedule every minute.
select cron.schedule(
  'hubbackend_schedule_fanout',
  '* * * * *',
  $$select public.invoke_triggers_schedule();$$
);
