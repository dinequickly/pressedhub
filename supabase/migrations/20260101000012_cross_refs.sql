-- Cross-reference foreign keys that couldn't be set during initial table creation
-- because the referenced tables didn't exist yet.

alter table public.workflows
  add constraint workflows_memory_store_id_fkey
  foreign key (memory_store_id) references public.memory_stores(id)
  on delete set null;
