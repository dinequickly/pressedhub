-- Audit log: append-only record of every mutation. Edge functions write here
-- via the service role; clients can never insert directly.

create table public.audit_log (
  id uuid primary key default extensions.uuid_generate_v4(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_actor_idx on public.audit_log(actor_id);
create index audit_log_resource_idx on public.audit_log(resource_type, resource_id);
create index audit_log_created_idx on public.audit_log(created_at desc);

alter table public.audit_log enable row level security;

create policy audit_log_admin_read on public.audit_log
  for select using (public.is_admin());

-- No client write policies. Service role bypasses RLS.
