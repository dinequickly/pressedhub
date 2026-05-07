-- Workflows + denormalised nodes/edges. The full Workflow JSON is also persisted
-- on workflows.graph for round-trip parity with the frontend.
create type public.workflow_category as enum ('deterministic', 'react', 'multi-agent');
create type public.node_kind as enum ('trigger', 'action', 'condition', 'agent');

create table public.workflows (
  id uuid primary key default extensions.uuid_generate_v4(),
  name text not null,
  description text not null default '',
  category public.workflow_category not null,
  -- Optional default memory store referenced by the workflow.
  memory_store_id uuid,
  -- Full denormalised graph (nodes + edges) as the frontend posts/expects it.
  graph jsonb not null default jsonb_build_object('nodes', '[]'::jsonb, 'edges', '[]'::jsonb),
  -- Owner profile that created the workflow. Used for RLS.
  created_by uuid not null references public.profiles(id) on delete restrict,
  -- Workflow-level toggle, drives whether trigger fires execute it.
  enabled boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index workflows_created_by_idx on public.workflows(created_by);
create index workflows_category_idx on public.workflows(category);
create index workflows_enabled_idx on public.workflows(enabled) where enabled = true;

create trigger workflows_touch_updated_at
  before update on public.workflows
  for each row execute procedure public.touch_updated_at();

-- Denormalised nodes for query/index. Source of truth is workflows.graph; the
-- workflows-crud function rewrites these rows on every workflow update inside
-- a single transaction.
create table public.workflow_nodes (
  id text not null,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  kind public.node_kind not null,
  -- All fields from the AgentNode/TriggerNode/etc shape live in body.
  body jsonb not null,
  position int not null default 0,
  created_at timestamptz not null default now(),
  primary key (workflow_id, id)
);

create index workflow_nodes_workflow_idx on public.workflow_nodes(workflow_id);
create index workflow_nodes_kind_idx on public.workflow_nodes(kind);

create table public.workflow_edges (
  id uuid primary key default extensions.uuid_generate_v4(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  from_node text not null,
  to_node text not null,
  label text,
  created_at timestamptz not null default now()
);

create index workflow_edges_workflow_idx on public.workflow_edges(workflow_id);

alter table public.workflows enable row level security;
alter table public.workflow_nodes enable row level security;
alter table public.workflow_edges enable row level security;

-- Members see workflows they created; admins see all.
create policy workflows_read on public.workflows
  for select using (created_by = auth.uid() or public.is_admin());

create policy workflows_insert on public.workflows
  for insert with check (created_by = auth.uid() or public.is_admin());

create policy workflows_update on public.workflows
  for update using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

create policy workflows_delete on public.workflows
  for delete using (created_by = auth.uid() or public.is_admin());

-- Nodes/edges visibility follows the parent workflow.
create policy workflow_nodes_visible_with_workflow on public.workflow_nodes
  for all using (
    exists (
      select 1 from public.workflows w
      where w.id = workflow_id and (w.created_by = auth.uid() or public.is_admin())
    )
  ) with check (
    exists (
      select 1 from public.workflows w
      where w.id = workflow_id and (w.created_by = auth.uid() or public.is_admin())
    )
  );

create policy workflow_edges_visible_with_workflow on public.workflow_edges
  for all using (
    exists (
      select 1 from public.workflows w
      where w.id = workflow_id and (w.created_by = auth.uid() or public.is_admin())
    )
  ) with check (
    exists (
      select 1 from public.workflows w
      where w.id = workflow_id and (w.created_by = auth.uid() or public.is_admin())
    )
  );
