

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."app_status" AS ENUM (
    'draft',
    'deployed'
);


ALTER TYPE "public"."app_status" OWNER TO "postgres";


CREATE TYPE "public"."connection_status" AS ENUM (
    'connected',
    'expired',
    'never'
);


ALTER TYPE "public"."connection_status" OWNER TO "postgres";


CREATE TYPE "public"."connector_group" AS ENUM (
    'apps',
    'system',
    'ai'
);


ALTER TYPE "public"."connector_group" OWNER TO "postgres";


CREATE TYPE "public"."dream_status" AS ENUM (
    'pending',
    'running',
    'completed',
    'failed',
    'canceled',
    'approved',
    'rejected'
);


ALTER TYPE "public"."dream_status" OWNER TO "postgres";


CREATE TYPE "public"."file_kind" AS ENUM (
    'pdf',
    'doc',
    'transcript',
    'sheet',
    'report',
    'image',
    'email',
    'other'
);


ALTER TYPE "public"."file_kind" OWNER TO "postgres";


CREATE TYPE "public"."file_status" AS ENUM (
    'uploaded',
    'extracted',
    'chunked',
    'embedded',
    'failed'
);


ALTER TYPE "public"."file_status" OWNER TO "postgres";


CREATE TYPE "public"."memory_scope" AS ENUM (
    'workflow',
    'user',
    'shared'
);


ALTER TYPE "public"."memory_scope" OWNER TO "postgres";


CREATE TYPE "public"."node_kind" AS ENUM (
    'trigger',
    'action',
    'condition',
    'agent'
);


ALTER TYPE "public"."node_kind" OWNER TO "postgres";


CREATE TYPE "public"."schedule_run_status" AS ENUM (
    'pending',
    'running',
    'success',
    'failed',
    'skipped'
);


ALTER TYPE "public"."schedule_run_status" OWNER TO "postgres";


CREATE TYPE "public"."schedule_status" AS ENUM (
    'active',
    'paused'
);


ALTER TYPE "public"."schedule_status" OWNER TO "postgres";


CREATE TYPE "public"."session_status" AS ENUM (
    'idle',
    'running',
    'rescheduling',
    'terminated'
);


ALTER TYPE "public"."session_status" OWNER TO "postgres";


CREATE TYPE "public"."skill_type" AS ENUM (
    'anthropic',
    'custom'
);


ALTER TYPE "public"."skill_type" OWNER TO "postgres";


CREATE TYPE "public"."trigger_kind" AS ENUM (
    'webhook',
    'schedule',
    'email_inbound',
    'manual'
);


ALTER TYPE "public"."trigger_kind" OWNER TO "postgres";


CREATE TYPE "public"."user_role" AS ENUM (
    'admin',
    'member'
);


ALTER TYPE "public"."user_role" OWNER TO "postgres";


CREATE TYPE "public"."workflow_category" AS ENUM (
    'deterministic',
    'react',
    'multi-agent'
);


ALTER TYPE "public"."workflow_category" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."advance_schedule_trigger"("p_trigger_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  cfg jsonb;
  interval_min int;
begin
  select config into cfg from public.workflow_triggers where id = p_trigger_id;
  if cfg is null then return; end if;
  interval_min := coalesce((cfg->>'interval_minutes')::int, 60);
  update public.workflow_triggers
  set config = jsonb_set(
    jsonb_set(cfg, '{last_run_at}', to_jsonb(now()::text)),
    '{next_run_at}',
    to_jsonb((now() + (interval_min || ' minutes')::interval)::text)
  )
  where id = p_trigger_id;
end;
$$;


ALTER FUNCTION "public"."advance_schedule_trigger"("p_trigger_id" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."agent_schedules" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "agent_id" "uuid" NOT NULL,
    "environment_id" "uuid",
    "name" "text" NOT NULL,
    "cron" "text" NOT NULL,
    "timezone" "text" DEFAULT 'UTC'::"text" NOT NULL,
    "trigger_message" "text",
    "trigger_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "public"."schedule_status" DEFAULT 'active'::"public"."schedule_status" NOT NULL,
    "skip_if_running" boolean DEFAULT true NOT NULL,
    "last_run_at" timestamp with time zone,
    "last_session_id" "uuid",
    "next_run_at" timestamp with time zone NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agent_schedules" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_due_schedules"("p_limit" integer DEFAULT 50) RETURNS SETOF "public"."agent_schedules"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."claim_due_schedules"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."due_schedule_triggers"("now_ts" timestamp with time zone DEFAULT "now"()) RETURNS TABLE("trigger_id" "uuid", "workflow_id" "uuid", "config" "jsonb")
    LANGUAGE "sql" STABLE
    AS $$
  select
    t.id as trigger_id,
    t.workflow_id,
    t.config
  from public.workflow_triggers t
  join public.workflows w on w.id = t.workflow_id
  where t.kind = 'schedule'
    and t.enabled
    and w.enabled
    and (
      (t.config->>'next_run_at')::timestamptz is null
      or (t.config->>'next_run_at')::timestamptz <= now_ts
    );
$$;


ALTER FUNCTION "public"."due_schedule_triggers"("now_ts" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
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


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_memory_store_versions"("p_store_id" "uuid") RETURNS "void"
    LANGUAGE "sql"
    AS $$
  update public.memory_stores
  set total_versions = total_versions + 1, updated_at = now()
  where id = p_store_id;
$$;


ALTER FUNCTION "public"."increment_memory_store_versions"("p_store_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."invoke_agent_schedules_tick"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


ALTER FUNCTION "public"."invoke_agent_schedules_tick"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."invoke_slack_relay_sweep"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


ALTER FUNCTION "public"."invoke_slack_relay_sweep"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."invoke_triggers_schedule"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


ALTER FUNCTION "public"."invoke_triggers_schedule"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    (select role = 'admin' from public.profiles where id = auth.uid()),
    false
  );
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."kb_search"("query_embedding" "extensions"."vector", "match_limit" integer DEFAULT 8, "filter_folder_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("chunk_id" "uuid", "file_id" "uuid", "file_name" "text", "ord" integer, "similarity" double precision, "text" "text", "tags" "text"[])
    LANGUAGE "sql" STABLE
    AS $$
  select
    c.id as chunk_id,
    c.file_id,
    f.name as file_name,
    c.ord,
    1 - (c.embedding <=> query_embedding) as similarity,
    c.text,
    f.tags
  from public.kb_chunks c
  join public.kb_files f on f.id = c.file_id
  where c.embedding is not null
    and (filter_folder_id is null or f.folder_id = filter_folder_id)
  order by c.embedding <=> query_embedding
  limit greatest(match_limit, 1);
$$;


ALTER FUNCTION "public"."kb_search"("query_embedding" "extensions"."vector", "match_limit" integer, "filter_folder_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."short_id"("prefix" "text") RETURNS "text"
    LANGUAGE "sql"
    AS $$
  select prefix || '_' || replace(extensions.uuid_generate_v4()::text, '-', '');
$$;


ALTER FUNCTION "public"."short_id"("prefix" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_can_see_app"("app_uuid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."user_can_see_app"("app_uuid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_owns_app"("app_uuid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    (select created_by = auth.uid() from public.apps where id = app_uuid),
    false
  );
$$;


ALTER FUNCTION "public"."user_owns_app"("app_uuid" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agents" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "anthropic_id" "text",
    "anthropic_version" integer DEFAULT 1 NOT NULL,
    "name" "text" NOT NULL,
    "role" "text" DEFAULT ''::"text" NOT NULL,
    "emoji" "text" DEFAULT '🤖'::"text" NOT NULL,
    "accent" "text" DEFAULT 'violet'::"text" NOT NULL,
    "model" "text" DEFAULT 'claude-opus-4-7'::"text" NOT NULL,
    "system_prompt" "text" DEFAULT ''::"text" NOT NULL,
    "instructions" "text" DEFAULT ''::"text" NOT NULL,
    "tools" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "skills" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "mcp_servers" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "outcome" "jsonb",
    "brain" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "used_in_workflows" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "archived_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "default_resources" "jsonb" DEFAULT '{"kb_file_ids": [], "memory_store_ids": []}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."agents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."annotations" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "at" timestamp with time zone NOT NULL,
    "label" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "source" "text" DEFAULT 'seed'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "annotations_kind_check" CHECK (("kind" = ANY (ARRAY['product'::"text", 'holiday'::"text", 'weather'::"text", 'competition'::"text", 'team'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."annotations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app_deployments" (
    "app_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "deployed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."app_deployments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app_settings" (
    "key" "text" NOT NULL,
    "value" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."app_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."apps" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "tagline" "text" DEFAULT ''::"text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "icon" "text" DEFAULT 'sparkles'::"text" NOT NULL,
    "color" "text" DEFAULT 'violet'::"text" NOT NULL,
    "status" "public"."app_status" DEFAULT 'draft'::"public"."app_status" NOT NULL,
    "content_md" "text" DEFAULT ''::"text" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."apps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_log" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "actor_id" "uuid",
    "action" "text" NOT NULL,
    "resource_type" "text" NOT NULL,
    "resource_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaigns" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "started_at" timestamp with time zone NOT NULL,
    "ended_at" timestamp with time zone NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "source" "text" DEFAULT 'seed'::"text" NOT NULL,
    "source_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "campaigns_channel_check" CHECK (("channel" = ANY (ARRAY['email'::"text", 'paid'::"text", 'organic'::"text", 'in_store'::"text", 'retail'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."campaigns" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."connectors" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "group" "public"."connector_group" NOT NULL,
    "icon_class" "text" DEFAULT ''::"text" NOT NULL,
    "tint" "text" DEFAULT ''::"text" NOT NULL,
    "operations" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."connectors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dreams" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "store_id" "uuid" NOT NULL,
    "status" "public"."dream_status" DEFAULT 'pending'::"public"."dream_status" NOT NULL,
    "old_snapshot" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "new_snapshot" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "diff" "jsonb",
    "instructions" "text",
    "session_count" integer DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ended_at" timestamp with time zone
);


ALTER TABLE "public"."dreams" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."environments" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "anthropic_id" "text",
    "name" "text" NOT NULL,
    "config" "jsonb" DEFAULT "jsonb_build_object"('type', 'cloud', 'networking', "jsonb_build_object"('type', 'unrestricted')) NOT NULL,
    "created_by" "uuid" NOT NULL,
    "archived_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."environments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."kb_chunks" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "file_id" "uuid" NOT NULL,
    "ord" integer NOT NULL,
    "text" "text" NOT NULL,
    "embedding" "extensions"."vector"(1536),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."kb_chunks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."kb_files" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "folder_id" "uuid",
    "name" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "mime" "text" DEFAULT 'application/octet-stream'::"text" NOT NULL,
    "size_bytes" bigint DEFAULT 0 NOT NULL,
    "kind" "public"."file_kind" DEFAULT 'other'::"public"."file_kind" NOT NULL,
    "status" "public"."file_status" DEFAULT 'uploaded'::"public"."file_status" NOT NULL,
    "snippet" "text" DEFAULT ''::"text" NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "uploaded_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "anthropic_file_id" "text"
);


ALTER TABLE "public"."kb_files" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."kb_folders" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "parent_id" "uuid",
    "name" "text" NOT NULL,
    "path" "text" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."kb_folders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."kb_tags" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "color" "text" DEFAULT 'neutral'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."kb_tags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mcp_servers" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "url" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."mcp_servers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."media_assets" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "mime" "text" DEFAULT 'application/octet-stream'::"text" NOT NULL,
    "size_bytes" bigint DEFAULT 0 NOT NULL,
    "width" integer,
    "height" integer,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "anthropic_file_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."media_assets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."memory_documents" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "store_id" "uuid" NOT NULL,
    "path" "text" NOT NULL,
    "content" "text" DEFAULT ''::"text" NOT NULL,
    "size_bytes" integer DEFAULT 0 NOT NULL,
    "version_count" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."memory_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."memory_stores" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "scope" "public"."memory_scope" NOT NULL,
    "workflow_id" "uuid",
    "owner_id" "uuid" NOT NULL,
    "total_versions" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "anthropic_id" "text"
);


ALTER TABLE "public"."memory_stores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."memory_table_rows" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "table_id" "uuid" NOT NULL,
    "row" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."memory_table_rows" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."memory_tables" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "store_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "schema" "jsonb" DEFAULT '{"columns": []}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."memory_tables" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."metrics" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "kind" "text" NOT NULL,
    "occurred_at" timestamp with time zone NOT NULL,
    "value" double precision NOT NULL,
    "dimensions" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "source" "text" DEFAULT 'seed'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "role" "public"."user_role" DEFAULT 'member'::"public"."user_role" NOT NULL,
    "initial" "text" NOT NULL,
    "tint" "text" DEFAULT 'from-violet-400 to-fuchsia-400'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sessions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "anthropic_id" "text",
    "workflow_id" "uuid",
    "agent_id" "uuid" NOT NULL,
    "environment_id" "uuid" NOT NULL,
    "vault_connection_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "title" "text",
    "status" "public"."session_status" DEFAULT 'idle'::"public"."session_status" NOT NULL,
    "outcome_grade" "text",
    "outcome_evaluations" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "iteration_count" integer DEFAULT 0 NOT NULL,
    "usage" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "trigger_payload" "jsonb",
    "trigger_summary" "text",
    "started_by" "uuid",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sessions" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."runs" AS
 SELECT "s"."id",
    "s"."workflow_id",
    "s"."anthropic_id" AS "session_id",
    "s"."status",
    "s"."title" AS "trigger_summary",
    "s"."trigger_summary" AS "trigger_summary_text",
    "s"."started_at",
    "s"."finished_at",
    "s"."outcome_grade",
    "s"."iteration_count",
    "s"."usage",
    (EXTRACT(epoch FROM (COALESCE("s"."finished_at", "now"()) - "s"."started_at")) * (1000)::numeric) AS "duration_ms"
   FROM "public"."sessions" "s";


ALTER TABLE "public"."runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."schedule_runs" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "schedule_id" "uuid" NOT NULL,
    "session_id" "uuid",
    "scheduled_for" timestamp with time zone NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "status" "public"."schedule_run_status" DEFAULT 'pending'::"public"."schedule_run_status" NOT NULL,
    "error" "text"
);


ALTER TABLE "public"."schedule_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."session_events" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "anthropic_event_id" "text",
    "event_type" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "processed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."session_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."skills" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "anthropic_skill_id" "text",
    "type" "public"."skill_type" DEFAULT 'custom'::"public"."skill_type" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "version" "text" DEFAULT 'latest'::"text" NOT NULL,
    "content_md" "text" DEFAULT ''::"text" NOT NULL,
    "pinned" boolean DEFAULT false NOT NULL,
    "used_in_workflows" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "archived_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."skills" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."timeline_sync_state" (
    "resource" "text" NOT NULL,
    "kb_file_id" "uuid",
    "last_synced_at" timestamp with time zone,
    "last_kb_updated_at" timestamp with time zone,
    "rows_synced" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."timeline_sync_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vault_connections" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "connector_id" "text" NOT NULL,
    "account_label" "text" NOT NULL,
    "status" "public"."connection_status" DEFAULT 'never'::"public"."connection_status" NOT NULL,
    "scopes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "mcp_server_url" "text",
    "anthropic_vault_id" "text",
    "anthropic_credential_id" "text",
    "connected_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "last_used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."vault_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vibe_boards" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "name" "text" DEFAULT 'Untitled board'::"text" NOT NULL,
    "state" "jsonb" DEFAULT '{"items": []}'::"jsonb" NOT NULL,
    "session_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."vibe_boards" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workflow_edges" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "workflow_id" "uuid" NOT NULL,
    "from_node" "text" NOT NULL,
    "to_node" "text" NOT NULL,
    "label" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."workflow_edges" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workflow_nodes" (
    "id" "text" NOT NULL,
    "workflow_id" "uuid" NOT NULL,
    "kind" "public"."node_kind" NOT NULL,
    "body" "jsonb" NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."workflow_nodes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workflow_triggers" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "workflow_id" "uuid" NOT NULL,
    "kind" "public"."trigger_kind" NOT NULL,
    "config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."workflow_triggers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workflows" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "category" "public"."workflow_category" NOT NULL,
    "memory_store_id" "uuid",
    "graph" "jsonb" DEFAULT "jsonb_build_object"('nodes', '[]'::"jsonb", 'edges', '[]'::"jsonb") NOT NULL,
    "created_by" "uuid" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "archived_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."workflows" OWNER TO "postgres";


ALTER TABLE ONLY "public"."agent_schedules"
    ADD CONSTRAINT "agent_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agents"
    ADD CONSTRAINT "agents_anthropic_id_key" UNIQUE ("anthropic_id");



ALTER TABLE ONLY "public"."agents"
    ADD CONSTRAINT "agents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."annotations"
    ADD CONSTRAINT "annotations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app_deployments"
    ADD CONSTRAINT "app_deployments_pkey" PRIMARY KEY ("app_id", "user_id");



ALTER TABLE ONLY "public"."app_settings"
    ADD CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."apps"
    ADD CONSTRAINT "apps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."connectors"
    ADD CONSTRAINT "connectors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dreams"
    ADD CONSTRAINT "dreams_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."environments"
    ADD CONSTRAINT "environments_anthropic_id_key" UNIQUE ("anthropic_id");



ALTER TABLE ONLY "public"."environments"
    ADD CONSTRAINT "environments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_chunks"
    ADD CONSTRAINT "kb_chunks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_files"
    ADD CONSTRAINT "kb_files_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_folders"
    ADD CONSTRAINT "kb_folders_parent_id_name_key" UNIQUE ("parent_id", "name");



ALTER TABLE ONLY "public"."kb_folders"
    ADD CONSTRAINT "kb_folders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kb_tags"
    ADD CONSTRAINT "kb_tags_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."kb_tags"
    ADD CONSTRAINT "kb_tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mcp_servers"
    ADD CONSTRAINT "mcp_servers_created_by_name_key" UNIQUE ("created_by", "name");



ALTER TABLE ONLY "public"."mcp_servers"
    ADD CONSTRAINT "mcp_servers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."media_assets"
    ADD CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."memory_documents"
    ADD CONSTRAINT "memory_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."memory_documents"
    ADD CONSTRAINT "memory_documents_store_id_path_key" UNIQUE ("store_id", "path");



ALTER TABLE ONLY "public"."memory_stores"
    ADD CONSTRAINT "memory_stores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."memory_table_rows"
    ADD CONSTRAINT "memory_table_rows_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."memory_tables"
    ADD CONSTRAINT "memory_tables_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."memory_tables"
    ADD CONSTRAINT "memory_tables_store_id_name_key" UNIQUE ("store_id", "name");



ALTER TABLE ONLY "public"."metrics"
    ADD CONSTRAINT "metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedule_runs"
    ADD CONSTRAINT "schedule_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."session_events"
    ADD CONSTRAINT "session_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_anthropic_id_key" UNIQUE ("anthropic_id");



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."skills"
    ADD CONSTRAINT "skills_anthropic_skill_id_key" UNIQUE ("anthropic_skill_id");



ALTER TABLE ONLY "public"."skills"
    ADD CONSTRAINT "skills_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."timeline_sync_state"
    ADD CONSTRAINT "timeline_sync_state_pkey" PRIMARY KEY ("resource");



ALTER TABLE ONLY "public"."vault_connections"
    ADD CONSTRAINT "vault_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vault_connections"
    ADD CONSTRAINT "vault_connections_user_id_connector_id_account_label_key" UNIQUE ("user_id", "connector_id", "account_label");



ALTER TABLE ONLY "public"."vibe_boards"
    ADD CONSTRAINT "vibe_boards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workflow_edges"
    ADD CONSTRAINT "workflow_edges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workflow_nodes"
    ADD CONSTRAINT "workflow_nodes_pkey" PRIMARY KEY ("workflow_id", "id");



ALTER TABLE ONLY "public"."workflow_triggers"
    ADD CONSTRAINT "workflow_triggers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workflows"
    ADD CONSTRAINT "workflows_pkey" PRIMARY KEY ("id");



CREATE INDEX "agent_schedules_agent_idx" ON "public"."agent_schedules" USING "btree" ("agent_id");



CREATE INDEX "agent_schedules_due_idx" ON "public"."agent_schedules" USING "btree" ("next_run_at") WHERE ("status" = 'active'::"public"."schedule_status");



CREATE INDEX "agent_schedules_owner_idx" ON "public"."agent_schedules" USING "btree" ("created_by");



CREATE INDEX "agents_anthropic_id_idx" ON "public"."agents" USING "btree" ("anthropic_id");



CREATE INDEX "agents_created_by_idx" ON "public"."agents" USING "btree" ("created_by");



CREATE INDEX "annotations_at_idx" ON "public"."annotations" USING "btree" ("at");



CREATE INDEX "app_deployments_user_idx" ON "public"."app_deployments" USING "btree" ("user_id");



CREATE INDEX "apps_created_by_idx" ON "public"."apps" USING "btree" ("created_by");



CREATE INDEX "apps_status_idx" ON "public"."apps" USING "btree" ("status");



CREATE INDEX "audit_log_actor_idx" ON "public"."audit_log" USING "btree" ("actor_id");



CREATE INDEX "audit_log_created_idx" ON "public"."audit_log" USING "btree" ("created_at" DESC);



CREATE INDEX "audit_log_resource_idx" ON "public"."audit_log" USING "btree" ("resource_type", "resource_id");



CREATE INDEX "campaigns_channel_idx" ON "public"."campaigns" USING "btree" ("channel");



CREATE INDEX "campaigns_started_idx" ON "public"."campaigns" USING "btree" ("started_at");



CREATE INDEX "connectors_group_idx" ON "public"."connectors" USING "btree" ("group");



CREATE INDEX "dreams_status_idx" ON "public"."dreams" USING "btree" ("status");



CREATE INDEX "dreams_store_idx" ON "public"."dreams" USING "btree" ("store_id");



CREATE INDEX "environments_anthropic_id_idx" ON "public"."environments" USING "btree" ("anthropic_id");



CREATE INDEX "environments_created_by_idx" ON "public"."environments" USING "btree" ("created_by");



CREATE INDEX "kb_chunks_embedding_idx" ON "public"."kb_chunks" USING "ivfflat" ("embedding" "extensions"."vector_cosine_ops") WITH ("lists"='100');



CREATE INDEX "kb_chunks_file_idx" ON "public"."kb_chunks" USING "btree" ("file_id", "ord");



CREATE INDEX "kb_files_anthropic_file_idx" ON "public"."kb_files" USING "btree" ("anthropic_file_id") WHERE ("anthropic_file_id" IS NOT NULL);



CREATE INDEX "kb_files_folder_idx" ON "public"."kb_files" USING "btree" ("folder_id");



CREATE INDEX "kb_files_status_idx" ON "public"."kb_files" USING "btree" ("status");



CREATE INDEX "kb_files_tags_idx" ON "public"."kb_files" USING "gin" ("tags");



CREATE INDEX "kb_folders_parent_idx" ON "public"."kb_folders" USING "btree" ("parent_id");



CREATE INDEX "kb_folders_path_idx" ON "public"."kb_folders" USING "btree" ("path");



CREATE INDEX "mcp_servers_created_by_idx" ON "public"."mcp_servers" USING "btree" ("created_by");



CREATE INDEX "media_assets_owner_idx" ON "public"."media_assets" USING "btree" ("owner_id");



CREATE INDEX "media_assets_tags_idx" ON "public"."media_assets" USING "gin" ("tags");



CREATE INDEX "memory_documents_store_idx" ON "public"."memory_documents" USING "btree" ("store_id");



CREATE INDEX "memory_stores_anthropic_idx" ON "public"."memory_stores" USING "btree" ("anthropic_id") WHERE ("anthropic_id" IS NOT NULL);



CREATE INDEX "memory_stores_owner_idx" ON "public"."memory_stores" USING "btree" ("owner_id");



CREATE INDEX "memory_stores_scope_idx" ON "public"."memory_stores" USING "btree" ("scope");



CREATE INDEX "memory_stores_workflow_idx" ON "public"."memory_stores" USING "btree" ("workflow_id");



CREATE INDEX "memory_table_rows_row_idx" ON "public"."memory_table_rows" USING "gin" ("row" "jsonb_path_ops");



CREATE INDEX "memory_table_rows_table_idx" ON "public"."memory_table_rows" USING "btree" ("table_id");



CREATE INDEX "memory_tables_store_idx" ON "public"."memory_tables" USING "btree" ("store_id");



CREATE INDEX "metrics_kind_time_idx" ON "public"."metrics" USING "btree" ("kind", "occurred_at");



CREATE INDEX "profiles_role_idx" ON "public"."profiles" USING "btree" ("role");



CREATE INDEX "schedule_runs_schedule_idx" ON "public"."schedule_runs" USING "btree" ("schedule_id", "started_at" DESC);



CREATE UNIQUE INDEX "session_events_dedupe_idx" ON "public"."session_events" USING "btree" ("session_id", "anthropic_event_id") WHERE ("anthropic_event_id" IS NOT NULL);



CREATE INDEX "session_events_session_idx" ON "public"."session_events" USING "btree" ("session_id", "created_at");



CREATE INDEX "session_events_type_idx" ON "public"."session_events" USING "btree" ("event_type");



CREATE INDEX "sessions_agent_idx" ON "public"."sessions" USING "btree" ("agent_id");



CREATE INDEX "sessions_anthropic_id_idx" ON "public"."sessions" USING "btree" ("anthropic_id");



CREATE INDEX "sessions_started_at_idx" ON "public"."sessions" USING "btree" ("started_at" DESC);



CREATE INDEX "sessions_status_idx" ON "public"."sessions" USING "btree" ("status");



CREATE INDEX "sessions_workflow_idx" ON "public"."sessions" USING "btree" ("workflow_id");



CREATE INDEX "skills_anthropic_skill_id_idx" ON "public"."skills" USING "btree" ("anthropic_skill_id");



CREATE INDEX "skills_type_idx" ON "public"."skills" USING "btree" ("type");



CREATE INDEX "vault_connections_connector_idx" ON "public"."vault_connections" USING "btree" ("connector_id");



CREATE INDEX "vault_connections_slack_team_idx" ON "public"."vault_connections" USING "btree" ((("metadata" ->> 'team_id'::"text"))) WHERE ("connector_id" = 'slack'::"text");



CREATE INDEX "vault_connections_status_idx" ON "public"."vault_connections" USING "btree" ("status");



CREATE INDEX "vault_connections_user_idx" ON "public"."vault_connections" USING "btree" ("user_id");



CREATE INDEX "vibe_boards_owner_idx" ON "public"."vibe_boards" USING "btree" ("owner_id");



CREATE INDEX "vibe_boards_session_idx" ON "public"."vibe_boards" USING "btree" ("session_id");



CREATE INDEX "workflow_edges_workflow_idx" ON "public"."workflow_edges" USING "btree" ("workflow_id");



CREATE INDEX "workflow_nodes_kind_idx" ON "public"."workflow_nodes" USING "btree" ("kind");



CREATE INDEX "workflow_nodes_workflow_idx" ON "public"."workflow_nodes" USING "btree" ("workflow_id");



CREATE UNIQUE INDEX "workflow_triggers_email_local_part_idx" ON "public"."workflow_triggers" USING "btree" ((("config" ->> 'local_part'::"text"))) WHERE (("kind" = 'email_inbound'::"public"."trigger_kind") AND ("config" ? 'local_part'::"text"));



CREATE INDEX "workflow_triggers_kind_idx" ON "public"."workflow_triggers" USING "btree" ("kind");



CREATE UNIQUE INDEX "workflow_triggers_webhook_token_idx" ON "public"."workflow_triggers" USING "btree" ((("config" ->> 'token'::"text"))) WHERE (("kind" = 'webhook'::"public"."trigger_kind") AND ("config" ? 'token'::"text"));



CREATE INDEX "workflow_triggers_workflow_idx" ON "public"."workflow_triggers" USING "btree" ("workflow_id");



CREATE INDEX "workflows_category_idx" ON "public"."workflows" USING "btree" ("category");



CREATE INDEX "workflows_created_by_idx" ON "public"."workflows" USING "btree" ("created_by");



CREATE INDEX "workflows_enabled_idx" ON "public"."workflows" USING "btree" ("enabled") WHERE ("enabled" = true);



CREATE OR REPLACE TRIGGER "agent_schedules_touch_updated_at" BEFORE UPDATE ON "public"."agent_schedules" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "agents_touch_updated_at" BEFORE UPDATE ON "public"."agents" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "apps_touch_updated_at" BEFORE UPDATE ON "public"."apps" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "campaigns_touch_updated_at" BEFORE UPDATE ON "public"."campaigns" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "connectors_touch_updated_at" BEFORE UPDATE ON "public"."connectors" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "environments_touch_updated_at" BEFORE UPDATE ON "public"."environments" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "kb_files_touch_updated_at" BEFORE UPDATE ON "public"."kb_files" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "kb_folders_touch_updated_at" BEFORE UPDATE ON "public"."kb_folders" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "mcp_servers_touch_updated_at" BEFORE UPDATE ON "public"."mcp_servers" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "media_assets_touch_updated_at" BEFORE UPDATE ON "public"."media_assets" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "memory_documents_touch_updated_at" BEFORE UPDATE ON "public"."memory_documents" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "memory_stores_touch_updated_at" BEFORE UPDATE ON "public"."memory_stores" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "memory_table_rows_touch_updated_at" BEFORE UPDATE ON "public"."memory_table_rows" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "memory_tables_touch_updated_at" BEFORE UPDATE ON "public"."memory_tables" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "profiles_touch_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "sessions_touch_updated_at" BEFORE UPDATE ON "public"."sessions" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "skills_touch_updated_at" BEFORE UPDATE ON "public"."skills" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "vault_connections_touch_updated_at" BEFORE UPDATE ON "public"."vault_connections" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "vibe_boards_touch_updated_at" BEFORE UPDATE ON "public"."vibe_boards" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "workflow_triggers_touch_updated_at" BEFORE UPDATE ON "public"."workflow_triggers" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "workflows_touch_updated_at" BEFORE UPDATE ON "public"."workflows" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



ALTER TABLE ONLY "public"."agent_schedules"
    ADD CONSTRAINT "agent_schedules_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_schedules"
    ADD CONSTRAINT "agent_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_schedules"
    ADD CONSTRAINT "agent_schedules_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_schedules"
    ADD CONSTRAINT "agent_schedules_last_session_id_fkey" FOREIGN KEY ("last_session_id") REFERENCES "public"."sessions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agents"
    ADD CONSTRAINT "agents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."app_deployments"
    ADD CONSTRAINT "app_deployments_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."app_deployments"
    ADD CONSTRAINT "app_deployments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."apps"
    ADD CONSTRAINT "apps_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dreams"
    ADD CONSTRAINT "dreams_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dreams"
    ADD CONSTRAINT "dreams_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."memory_stores"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."environments"
    ADD CONSTRAINT "environments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."kb_chunks"
    ADD CONSTRAINT "kb_chunks_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."kb_files"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."kb_files"
    ADD CONSTRAINT "kb_files_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "public"."kb_folders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."kb_files"
    ADD CONSTRAINT "kb_files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."kb_folders"
    ADD CONSTRAINT "kb_folders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."kb_folders"
    ADD CONSTRAINT "kb_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."kb_folders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mcp_servers"
    ADD CONSTRAINT "mcp_servers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."media_assets"
    ADD CONSTRAINT "media_assets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."memory_documents"
    ADD CONSTRAINT "memory_documents_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."memory_stores"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."memory_stores"
    ADD CONSTRAINT "memory_stores_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."memory_stores"
    ADD CONSTRAINT "memory_stores_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."memory_table_rows"
    ADD CONSTRAINT "memory_table_rows_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."memory_tables"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."memory_tables"
    ADD CONSTRAINT "memory_tables_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."memory_stores"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_runs"
    ADD CONSTRAINT "schedule_runs_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "public"."agent_schedules"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_runs"
    ADD CONSTRAINT "schedule_runs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."session_events"
    ADD CONSTRAINT "session_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_started_by_fkey" FOREIGN KEY ("started_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."skills"
    ADD CONSTRAINT "skills_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."timeline_sync_state"
    ADD CONSTRAINT "timeline_sync_state_kb_file_id_fkey" FOREIGN KEY ("kb_file_id") REFERENCES "public"."kb_files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vault_connections"
    ADD CONSTRAINT "vault_connections_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."vault_connections"
    ADD CONSTRAINT "vault_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vibe_boards"
    ADD CONSTRAINT "vibe_boards_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vibe_boards"
    ADD CONSTRAINT "vibe_boards_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."workflow_edges"
    ADD CONSTRAINT "workflow_edges_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workflow_nodes"
    ADD CONSTRAINT "workflow_nodes_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workflow_triggers"
    ADD CONSTRAINT "workflow_triggers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workflow_triggers"
    ADD CONSTRAINT "workflow_triggers_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workflows"
    ADD CONSTRAINT "workflows_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."workflows"
    ADD CONSTRAINT "workflows_memory_store_id_fkey" FOREIGN KEY ("memory_store_id") REFERENCES "public"."memory_stores"("id") ON DELETE SET NULL;



ALTER TABLE "public"."agent_schedules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agent_schedules_read" ON "public"."agent_schedules" FOR SELECT USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



CREATE POLICY "agent_schedules_write" ON "public"."agent_schedules" USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"())) WITH CHECK ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."agents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agents_read" ON "public"."agents" FOR SELECT USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



CREATE POLICY "agents_write" ON "public"."agents" USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"())) WITH CHECK ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."annotations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "annotations_admin_write" ON "public"."annotations" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "annotations_read" ON "public"."annotations" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."app_deployments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "app_deployments_read" ON "public"."app_deployments" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR "public"."is_admin"()));



CREATE POLICY "app_deployments_write" ON "public"."app_deployments" USING (("public"."is_admin"() OR "public"."user_owns_app"("app_id"))) WITH CHECK (("public"."is_admin"() OR "public"."user_owns_app"("app_id")));



ALTER TABLE "public"."apps" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "apps_read" ON "public"."apps" FOR SELECT USING (("public"."is_admin"() OR "public"."user_can_see_app"("id")));



CREATE POLICY "apps_write" ON "public"."apps" USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"())) WITH CHECK ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_log_admin_read" ON "public"."audit_log" FOR SELECT USING ("public"."is_admin"());



ALTER TABLE "public"."campaigns" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "campaigns_admin_write" ON "public"."campaigns" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "campaigns_read" ON "public"."campaigns" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."connectors" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "connectors_admin_write" ON "public"."connectors" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "connectors_read_all" ON "public"."connectors" FOR SELECT USING ((("auth"."role"() = 'authenticated'::"text") OR ("auth"."role"() = 'anon'::"text")));



ALTER TABLE "public"."dreams" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dreams_inherit" ON "public"."dreams" USING ((EXISTS ( SELECT 1
   FROM "public"."memory_stores" "s"
  WHERE (("s"."id" = "dreams"."store_id") AND (("s"."owner_id" = "auth"."uid"()) OR ("s"."scope" = 'shared'::"public"."memory_scope") OR "public"."is_admin"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."memory_stores" "s"
  WHERE (("s"."id" = "dreams"."store_id") AND (("s"."owner_id" = "auth"."uid"()) OR "public"."is_admin"())))));



ALTER TABLE "public"."environments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "environments_read" ON "public"."environments" FOR SELECT USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



CREATE POLICY "environments_write" ON "public"."environments" USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"())) WITH CHECK ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."kb_chunks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "kb_chunks_inherit" ON "public"."kb_chunks" USING ((EXISTS ( SELECT 1
   FROM "public"."kb_files" "f"
  WHERE (("f"."id" = "kb_chunks"."file_id") AND (("f"."uploaded_by" = "auth"."uid"()) OR "public"."is_admin"() OR ("auth"."role"() = 'authenticated'::"text")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."kb_files" "f"
  WHERE (("f"."id" = "kb_chunks"."file_id") AND (("f"."uploaded_by" = "auth"."uid"()) OR "public"."is_admin"())))));



ALTER TABLE "public"."kb_files" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "kb_files_read" ON "public"."kb_files" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "kb_files_write" ON "public"."kb_files" USING ((("uploaded_by" = "auth"."uid"()) OR "public"."is_admin"())) WITH CHECK ((("uploaded_by" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."kb_folders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "kb_folders_read" ON "public"."kb_folders" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "kb_folders_write" ON "public"."kb_folders" USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"())) WITH CHECK ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."kb_tags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "kb_tags_read" ON "public"."kb_tags" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "kb_tags_write" ON "public"."kb_tags" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."mcp_servers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mcp_servers_read" ON "public"."mcp_servers" FOR SELECT USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



CREATE POLICY "mcp_servers_write" ON "public"."mcp_servers" USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"())) WITH CHECK ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."media_assets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "media_assets_read" ON "public"."media_assets" FOR SELECT USING ((("owner_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"public"."user_role"))))));



CREATE POLICY "media_assets_write" ON "public"."media_assets" USING (("owner_id" = "auth"."uid"())) WITH CHECK (("owner_id" = "auth"."uid"()));



ALTER TABLE "public"."memory_documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "memory_documents_inherit" ON "public"."memory_documents" USING ((EXISTS ( SELECT 1
   FROM "public"."memory_stores" "s"
  WHERE (("s"."id" = "memory_documents"."store_id") AND (("s"."owner_id" = "auth"."uid"()) OR ("s"."scope" = 'shared'::"public"."memory_scope") OR "public"."is_admin"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."memory_stores" "s"
  WHERE (("s"."id" = "memory_documents"."store_id") AND (("s"."owner_id" = "auth"."uid"()) OR "public"."is_admin"())))));



ALTER TABLE "public"."memory_stores" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "memory_stores_read" ON "public"."memory_stores" FOR SELECT USING ((("owner_id" = "auth"."uid"()) OR ("scope" = 'shared'::"public"."memory_scope") OR "public"."is_admin"()));



CREATE POLICY "memory_stores_write" ON "public"."memory_stores" USING ((("owner_id" = "auth"."uid"()) OR "public"."is_admin"())) WITH CHECK ((("owner_id" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."memory_table_rows" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "memory_table_rows_inherit" ON "public"."memory_table_rows" USING ((EXISTS ( SELECT 1
   FROM ("public"."memory_tables" "t"
     JOIN "public"."memory_stores" "s" ON (("s"."id" = "t"."store_id")))
  WHERE (("t"."id" = "memory_table_rows"."table_id") AND (("s"."owner_id" = "auth"."uid"()) OR ("s"."scope" = 'shared'::"public"."memory_scope") OR "public"."is_admin"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."memory_tables" "t"
     JOIN "public"."memory_stores" "s" ON (("s"."id" = "t"."store_id")))
  WHERE (("t"."id" = "memory_table_rows"."table_id") AND (("s"."owner_id" = "auth"."uid"()) OR "public"."is_admin"())))));



ALTER TABLE "public"."memory_tables" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "memory_tables_inherit" ON "public"."memory_tables" USING ((EXISTS ( SELECT 1
   FROM "public"."memory_stores" "s"
  WHERE (("s"."id" = "memory_tables"."store_id") AND (("s"."owner_id" = "auth"."uid"()) OR ("s"."scope" = 'shared'::"public"."memory_scope") OR "public"."is_admin"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."memory_stores" "s"
  WHERE (("s"."id" = "memory_tables"."store_id") AND (("s"."owner_id" = "auth"."uid"()) OR "public"."is_admin"())))));



ALTER TABLE "public"."metrics" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "metrics_admin_write" ON "public"."metrics" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "metrics_read" ON "public"."metrics" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_admin_delete" ON "public"."profiles" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "profiles_admin_insert" ON "public"."profiles" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "profiles_self_select" ON "public"."profiles" FOR SELECT USING ((("auth"."uid"() = "id") OR "public"."is_admin"()));



CREATE POLICY "profiles_self_update" ON "public"."profiles" FOR UPDATE USING ((("auth"."uid"() = "id") OR "public"."is_admin"())) WITH CHECK ((("auth"."uid"() = "id") OR "public"."is_admin"()));



ALTER TABLE "public"."schedule_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "schedule_runs_read" ON "public"."schedule_runs" FOR SELECT USING (("public"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."agent_schedules" "s"
  WHERE (("s"."id" = "schedule_runs"."schedule_id") AND ("s"."created_by" = "auth"."uid"()))))));



ALTER TABLE "public"."session_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "session_events_visible_with_session" ON "public"."session_events" USING ((EXISTS ( SELECT 1
   FROM "public"."sessions" "s"
  WHERE (("s"."id" = "session_events"."session_id") AND (("s"."started_by" = "auth"."uid"()) OR "public"."is_admin"() OR (EXISTS ( SELECT 1
           FROM "public"."workflows" "w"
          WHERE (("w"."id" = "s"."workflow_id") AND ("w"."created_by" = "auth"."uid"()))))))))) WITH CHECK (true);



ALTER TABLE "public"."sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sessions_read" ON "public"."sessions" FOR SELECT USING ((("started_by" = "auth"."uid"()) OR "public"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."workflows" "w"
  WHERE (("w"."id" = "sessions"."workflow_id") AND ("w"."created_by" = "auth"."uid"()))))));



CREATE POLICY "sessions_write" ON "public"."sessions" USING ((("started_by" = "auth"."uid"()) OR "public"."is_admin"())) WITH CHECK ((("started_by" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."skills" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "skills_read" ON "public"."skills" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "skills_write" ON "public"."skills" USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"())) WITH CHECK ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."timeline_sync_state" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "timeline_sync_state_admin_read" ON "public"."timeline_sync_state" FOR SELECT USING ("public"."is_admin"());



ALTER TABLE "public"."vault_connections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vault_connections_read" ON "public"."vault_connections" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR "public"."is_admin"()));



CREATE POLICY "vault_connections_write" ON "public"."vault_connections" USING ((("user_id" = "auth"."uid"()) OR "public"."is_admin"())) WITH CHECK ((("user_id" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."vibe_boards" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vibe_boards_read" ON "public"."vibe_boards" FOR SELECT USING ((("owner_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"public"."user_role"))))));



CREATE POLICY "vibe_boards_write" ON "public"."vibe_boards" USING (("owner_id" = "auth"."uid"())) WITH CHECK (("owner_id" = "auth"."uid"()));



ALTER TABLE "public"."workflow_edges" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workflow_edges_visible_with_workflow" ON "public"."workflow_edges" USING ((EXISTS ( SELECT 1
   FROM "public"."workflows" "w"
  WHERE (("w"."id" = "workflow_edges"."workflow_id") AND (("w"."created_by" = "auth"."uid"()) OR "public"."is_admin"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."workflows" "w"
  WHERE (("w"."id" = "workflow_edges"."workflow_id") AND (("w"."created_by" = "auth"."uid"()) OR "public"."is_admin"())))));



ALTER TABLE "public"."workflow_nodes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workflow_nodes_visible_with_workflow" ON "public"."workflow_nodes" USING ((EXISTS ( SELECT 1
   FROM "public"."workflows" "w"
  WHERE (("w"."id" = "workflow_nodes"."workflow_id") AND (("w"."created_by" = "auth"."uid"()) OR "public"."is_admin"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."workflows" "w"
  WHERE (("w"."id" = "workflow_nodes"."workflow_id") AND (("w"."created_by" = "auth"."uid"()) OR "public"."is_admin"())))));



ALTER TABLE "public"."workflow_triggers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workflow_triggers_read" ON "public"."workflow_triggers" FOR SELECT USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."workflows" "w"
  WHERE (("w"."id" = "workflow_triggers"."workflow_id") AND ("w"."created_by" = "auth"."uid"()))))));



CREATE POLICY "workflow_triggers_write" ON "public"."workflow_triggers" USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"())) WITH CHECK ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."workflows" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workflows_delete" ON "public"."workflows" FOR DELETE USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



CREATE POLICY "workflows_insert" ON "public"."workflows" FOR INSERT WITH CHECK ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



CREATE POLICY "workflows_read" ON "public"."workflows" FOR SELECT USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



CREATE POLICY "workflows_update" ON "public"."workflows" FOR UPDATE USING ((("created_by" = "auth"."uid"()) OR "public"."is_admin"())) WITH CHECK ((("created_by" = "auth"."uid"()) OR "public"."is_admin"()));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."advance_schedule_trigger"("p_trigger_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."advance_schedule_trigger"("p_trigger_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."advance_schedule_trigger"("p_trigger_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."agent_schedules" TO "anon";
GRANT ALL ON TABLE "public"."agent_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_schedules" TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_due_schedules"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_due_schedules"("p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."due_schedule_triggers"("now_ts" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."due_schedule_triggers"("now_ts" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."due_schedule_triggers"("now_ts" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_memory_store_versions"("p_store_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."increment_memory_store_versions"("p_store_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_memory_store_versions"("p_store_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."invoke_agent_schedules_tick"() TO "anon";
GRANT ALL ON FUNCTION "public"."invoke_agent_schedules_tick"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."invoke_agent_schedules_tick"() TO "service_role";



GRANT ALL ON FUNCTION "public"."invoke_slack_relay_sweep"() TO "anon";
GRANT ALL ON FUNCTION "public"."invoke_slack_relay_sweep"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."invoke_slack_relay_sweep"() TO "service_role";



GRANT ALL ON FUNCTION "public"."invoke_triggers_schedule"() TO "anon";
GRANT ALL ON FUNCTION "public"."invoke_triggers_schedule"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."invoke_triggers_schedule"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."kb_search"("query_embedding" "extensions"."vector", "match_limit" integer, "filter_folder_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."kb_search"("query_embedding" "extensions"."vector", "match_limit" integer, "filter_folder_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."kb_search"("query_embedding" "extensions"."vector", "match_limit" integer, "filter_folder_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."short_id"("prefix" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."short_id"("prefix" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."short_id"("prefix" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."user_can_see_app"("app_uuid" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."user_can_see_app"("app_uuid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_can_see_app"("app_uuid" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."user_owns_app"("app_uuid" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."user_owns_app"("app_uuid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_owns_app"("app_uuid" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."agents" TO "anon";
GRANT ALL ON TABLE "public"."agents" TO "authenticated";
GRANT ALL ON TABLE "public"."agents" TO "service_role";



GRANT ALL ON TABLE "public"."annotations" TO "anon";
GRANT ALL ON TABLE "public"."annotations" TO "authenticated";
GRANT ALL ON TABLE "public"."annotations" TO "service_role";



GRANT ALL ON TABLE "public"."app_deployments" TO "anon";
GRANT ALL ON TABLE "public"."app_deployments" TO "authenticated";
GRANT ALL ON TABLE "public"."app_deployments" TO "service_role";



GRANT ALL ON TABLE "public"."app_settings" TO "anon";
GRANT ALL ON TABLE "public"."app_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."app_settings" TO "service_role";



GRANT ALL ON TABLE "public"."apps" TO "anon";
GRANT ALL ON TABLE "public"."apps" TO "authenticated";
GRANT ALL ON TABLE "public"."apps" TO "service_role";



GRANT ALL ON TABLE "public"."audit_log" TO "anon";
GRANT ALL ON TABLE "public"."audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."campaigns" TO "anon";
GRANT ALL ON TABLE "public"."campaigns" TO "authenticated";
GRANT ALL ON TABLE "public"."campaigns" TO "service_role";



GRANT ALL ON TABLE "public"."connectors" TO "anon";
GRANT ALL ON TABLE "public"."connectors" TO "authenticated";
GRANT ALL ON TABLE "public"."connectors" TO "service_role";



GRANT ALL ON TABLE "public"."dreams" TO "anon";
GRANT ALL ON TABLE "public"."dreams" TO "authenticated";
GRANT ALL ON TABLE "public"."dreams" TO "service_role";



GRANT ALL ON TABLE "public"."environments" TO "anon";
GRANT ALL ON TABLE "public"."environments" TO "authenticated";
GRANT ALL ON TABLE "public"."environments" TO "service_role";



GRANT ALL ON TABLE "public"."kb_chunks" TO "anon";
GRANT ALL ON TABLE "public"."kb_chunks" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_chunks" TO "service_role";



GRANT ALL ON TABLE "public"."kb_files" TO "anon";
GRANT ALL ON TABLE "public"."kb_files" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_files" TO "service_role";



GRANT ALL ON TABLE "public"."kb_folders" TO "anon";
GRANT ALL ON TABLE "public"."kb_folders" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_folders" TO "service_role";



GRANT ALL ON TABLE "public"."kb_tags" TO "anon";
GRANT ALL ON TABLE "public"."kb_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."kb_tags" TO "service_role";



GRANT ALL ON TABLE "public"."mcp_servers" TO "anon";
GRANT ALL ON TABLE "public"."mcp_servers" TO "authenticated";
GRANT ALL ON TABLE "public"."mcp_servers" TO "service_role";



GRANT ALL ON TABLE "public"."media_assets" TO "anon";
GRANT ALL ON TABLE "public"."media_assets" TO "authenticated";
GRANT ALL ON TABLE "public"."media_assets" TO "service_role";



GRANT ALL ON TABLE "public"."memory_documents" TO "anon";
GRANT ALL ON TABLE "public"."memory_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."memory_documents" TO "service_role";



GRANT ALL ON TABLE "public"."memory_stores" TO "anon";
GRANT ALL ON TABLE "public"."memory_stores" TO "authenticated";
GRANT ALL ON TABLE "public"."memory_stores" TO "service_role";



GRANT ALL ON TABLE "public"."memory_table_rows" TO "anon";
GRANT ALL ON TABLE "public"."memory_table_rows" TO "authenticated";
GRANT ALL ON TABLE "public"."memory_table_rows" TO "service_role";



GRANT ALL ON TABLE "public"."memory_tables" TO "anon";
GRANT ALL ON TABLE "public"."memory_tables" TO "authenticated";
GRANT ALL ON TABLE "public"."memory_tables" TO "service_role";



GRANT ALL ON TABLE "public"."metrics" TO "anon";
GRANT ALL ON TABLE "public"."metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."metrics" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."sessions" TO "anon";
GRANT ALL ON TABLE "public"."sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."sessions" TO "service_role";



GRANT ALL ON TABLE "public"."runs" TO "anon";
GRANT ALL ON TABLE "public"."runs" TO "authenticated";
GRANT ALL ON TABLE "public"."runs" TO "service_role";



GRANT ALL ON TABLE "public"."schedule_runs" TO "anon";
GRANT ALL ON TABLE "public"."schedule_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."schedule_runs" TO "service_role";



GRANT ALL ON TABLE "public"."session_events" TO "anon";
GRANT ALL ON TABLE "public"."session_events" TO "authenticated";
GRANT ALL ON TABLE "public"."session_events" TO "service_role";



GRANT ALL ON TABLE "public"."skills" TO "anon";
GRANT ALL ON TABLE "public"."skills" TO "authenticated";
GRANT ALL ON TABLE "public"."skills" TO "service_role";



GRANT ALL ON TABLE "public"."timeline_sync_state" TO "anon";
GRANT ALL ON TABLE "public"."timeline_sync_state" TO "authenticated";
GRANT ALL ON TABLE "public"."timeline_sync_state" TO "service_role";



GRANT ALL ON TABLE "public"."vault_connections" TO "anon";
GRANT ALL ON TABLE "public"."vault_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."vault_connections" TO "service_role";



GRANT ALL ON TABLE "public"."vibe_boards" TO "anon";
GRANT ALL ON TABLE "public"."vibe_boards" TO "authenticated";
GRANT ALL ON TABLE "public"."vibe_boards" TO "service_role";



GRANT ALL ON TABLE "public"."workflow_edges" TO "anon";
GRANT ALL ON TABLE "public"."workflow_edges" TO "authenticated";
GRANT ALL ON TABLE "public"."workflow_edges" TO "service_role";



GRANT ALL ON TABLE "public"."workflow_nodes" TO "anon";
GRANT ALL ON TABLE "public"."workflow_nodes" TO "authenticated";
GRANT ALL ON TABLE "public"."workflow_nodes" TO "service_role";



GRANT ALL ON TABLE "public"."workflow_triggers" TO "anon";
GRANT ALL ON TABLE "public"."workflow_triggers" TO "authenticated";
GRANT ALL ON TABLE "public"."workflow_triggers" TO "service_role";



GRANT ALL ON TABLE "public"."workflows" TO "anon";
GRANT ALL ON TABLE "public"."workflows" TO "authenticated";
GRANT ALL ON TABLE "public"."workflows" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "service_role";






