-- Apps / Mini-apps: small content surfaces that get deployed to specific users.

create type public.app_status as enum ('draft', 'deployed');

create table public.apps (
  id uuid primary key default extensions.uuid_generate_v4(),
  name text not null,
  tagline text not null default '',
  description text not null default '',
  icon text not null default 'sparkles',
  color text not null default 'violet',
  status public.app_status not null default 'draft',
  content_md text not null default '',
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index apps_status_idx on public.apps(status);
create index apps_created_by_idx on public.apps(created_by);

create trigger apps_touch_updated_at
  before update on public.apps
  for each row execute procedure public.touch_updated_at();

create table public.app_deployments (
  app_id uuid not null references public.apps(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  deployed_at timestamptz not null default now(),
  primary key (app_id, user_id)
);

create index app_deployments_user_idx on public.app_deployments(user_id);

alter table public.apps enable row level security;
alter table public.app_deployments enable row level security;

-- Members see apps deployed to them; admins see all.
create policy apps_read on public.apps
  for select using (
    public.is_admin()
    or created_by = auth.uid()
    or exists (
      select 1 from public.app_deployments d where d.app_id = id and d.user_id = auth.uid()
    )
  );

create policy apps_write on public.apps
  for all using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

create policy app_deployments_read on public.app_deployments
  for select using (user_id = auth.uid() or public.is_admin());

create policy app_deployments_write on public.app_deployments
  for all using (
    public.is_admin()
    or exists (select 1 from public.apps a where a.id = app_id and a.created_by = auth.uid())
  ) with check (
    public.is_admin()
    or exists (select 1 from public.apps a where a.id = app_id and a.created_by = auth.uid())
  );
