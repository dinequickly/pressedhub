-- Storage RLS for the kb bucket. Uploads happen via signed URLs (which
-- bypass RLS) but downloads from the frontend hit the storage API directly.

drop policy if exists "kb_owner_read" on storage.objects;
drop policy if exists "kb_owner_delete" on storage.objects;

create policy "kb_owner_read"
on storage.objects for select to authenticated
using (
  bucket_id = 'kb' and (
    public.is_admin()
    or position(('users/' || auth.uid()::text) in name) = 1
  )
);

create policy "kb_owner_delete"
on storage.objects for delete to authenticated
using (
  bucket_id = 'kb' and (
    public.is_admin()
    or position(('users/' || auth.uid()::text) in name) = 1
  )
);
