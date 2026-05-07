-- Application-level user profile, mirrors the frontend User shape.
-- {id, name, email, role, initial, tint}.
create type public.user_role as enum ('admin', 'member');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null unique,
  role public.user_role not null default 'member',
  initial text not null,
  tint text not null default 'from-violet-400 to-fuchsia-400',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_role_idx on public.profiles(role);

-- Helper for RLS policies and edge functions: is the current JWT an admin?
create or replace function public.is_admin() returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role = 'admin' from public.profiles where id = auth.uid()),
    false
  );
$$;

-- Auto-create a profile row when a Supabase auth user signs up. The default
-- name is the part of the email before the @, the initial is the first letter
-- upper-cased, and the role defaults to 'member'. Edge functions promote the
-- first user to 'admin' (see profiles-bootstrap).
create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  derived_name text;
begin
  derived_name := coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1));
  insert into public.profiles (id, name, email, initial)
  values (
    new.id,
    derived_name,
    new.email,
    upper(substr(derived_name, 1, 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- updated_at trigger helper, used by every table.
create or replace function public.touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute procedure public.touch_updated_at();

alter table public.profiles enable row level security;

-- A user can always read and update their own profile row. Admins can read all.
create policy profiles_self_select on public.profiles
  for select using (auth.uid() = id or public.is_admin());

create policy profiles_self_update on public.profiles
  for update using (auth.uid() = id or public.is_admin())
  with check (auth.uid() = id or public.is_admin());

create policy profiles_admin_insert on public.profiles
  for insert with check (public.is_admin());

create policy profiles_admin_delete on public.profiles
  for delete using (public.is_admin());
