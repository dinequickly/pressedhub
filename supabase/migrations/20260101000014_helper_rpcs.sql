-- Helper RPCs the edge functions call.

-- increment_memory_store_versions: bumps total_versions on a memory store.
create or replace function public.increment_memory_store_versions(p_store_id uuid)
returns void
language sql
volatile
as $$
  update public.memory_stores
  set total_versions = total_versions + 1, updated_at = now()
  where id = p_store_id;
$$;
