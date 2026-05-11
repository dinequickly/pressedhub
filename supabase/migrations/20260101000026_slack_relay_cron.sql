-- Durable Slack relay sweeper. Backstop for the in-worker poller: every
-- minute, pg_cron pings /functions/v1/slack-events/relay-sweep, which
-- walks every recent slack-originated session and runs relayOnce() on it
-- (idempotent). Workers dying mid-poll (deploys, restarts) no longer
-- strand replies — they get picked up within 60s.

create or replace function public.invoke_slack_relay_sweep() returns void
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
    url := v_base_url || '/slack-events/relay-sweep',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    timeout_milliseconds := 8000
  );
exception when others then
  raise warning 'invoke_slack_relay_sweep failed: %', sqlerrm;
end;
$$;

select cron.schedule(
  'hubbackend_slack_relay_sweep',
  '* * * * *',
  $$select public.invoke_slack_relay_sweep();$$
);
