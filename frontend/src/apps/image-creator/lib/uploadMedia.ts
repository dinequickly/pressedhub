// Shared helper for uploading user files into the media library. Used by
// both the canvas drag-drop handler and the toolbar "Add image" modal so
// they stay in sync (same multipart shape, same auth headers).

import { FN_URL, supabase } from "../../../lib/supabase";

export type UploadedAsset = {
  id: string;
  storage_path: string;
  mime: string;
};

/** POST a single File to /media as multipart form data. Tagged so the user's
 *  media library can later filter by source. Throws on non-2xx. */
export async function uploadFileToMedia(
  file: File,
  tag = "board-uploads",
): Promise<UploadedAsset> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("tag", tag);
  const sessData = (await supabase.auth.getSession()).data.session;
  const res = await fetch(`${FN_URL}/media`, {
    method: "POST",
    headers: {
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${sessData?.access_token ?? ""}`,
    },
    body: fd,
  });
  if (!res.ok) throw new Error(`upload ${res.status}`);
  return await res.json();
}
