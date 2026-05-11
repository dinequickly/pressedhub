-- Free-form connector-specific metadata on vault_connections. For Slack we
-- stash { team_id, team_name, app_id, default_agent_id } so the events
-- webhook can route an `app_mention` to the right agent without a separate
-- table. Other connectors can use it the same way (e.g. Notion workspace id).
alter table public.vault_connections
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- Lookup index for the slack-events webhook: find the connection that owns
-- a given Slack team_id. Partial so it stays cheap.
create index if not exists vault_connections_slack_team_idx
  on public.vault_connections((metadata->>'team_id'))
  where connector_id = 'slack';
