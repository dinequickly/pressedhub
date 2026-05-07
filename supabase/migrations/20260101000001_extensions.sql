-- Enable required Postgres extensions.
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists "pgcrypto" with schema extensions;
create extension if not exists "vector" with schema extensions;
create extension if not exists "pg_cron" with schema extensions;
create extension if not exists "pg_trgm" with schema extensions;

-- Helper: short ULID-like text id for human-readable rows when uuid is too noisy.
create or replace function public.short_id(prefix text) returns text
language sql
volatile
as $$
  select prefix || '_' || replace(extensions.uuid_generate_v4()::text, '-', '');
$$;
