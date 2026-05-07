-- Fix: the apps SELECT policy and the app_deployments WRITE policy referenced
-- each other's tables, which Postgres flags as infinite recursion. Wrap the
-- cross-table checks in SECURITY DEFINER helpers so the policies don't loop.

create or replace function public.user_can_see_app(app_uuid uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select created_by = auth.uid()
      from public.apps where id = app_uuid
    ),
    false
  ) or exists (
    select 1 from public.app_deployments
    where app_id = app_uuid and user_id = auth.uid()
  );
$$;

create or replace function public.user_owns_app(app_uuid uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select created_by = auth.uid() from public.apps where id = app_uuid),
    false
  );
$$;

drop policy if exists apps_read on public.apps;
create policy apps_read on public.apps
  for select using (public.is_admin() or public.user_can_see_app(id));

drop policy if exists app_deployments_write on public.app_deployments;
create policy app_deployments_write on public.app_deployments
  for all using (public.is_admin() or public.user_owns_app(app_id))
  with check (public.is_admin() or public.user_owns_app(app_id));
