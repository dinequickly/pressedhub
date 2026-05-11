// Shared helper for uploading user files into the media library. Used by
// both the canvas drag-drop handler and the toolbar "Add image" modal so
// they stay in sync (same multipart shape, same auth headers).

import { FN_URL, supabase } from "../../../lib/supabase";

export type UploadedAsset = {
  id: string;
  storage_path: string;
  mime: string;
};

export type UploadMediaOptions = {
  tag?: string;
  tags?: string[];
  source_kind?: "pressed_library" | "board_upload" | "board_generated";
  collection_key?: string;
  product_key?: string;
  shot_key?: string;
  board_id?: string;
  status?: "pending" | "ready" | "failed";
  name?: string;
};

/** POST a single File to /media as multipart form data. Tagged so the user's
 *  media library can later filter by source. Throws on non-2xx. */
export async function uploadFileToMedia(
  file: File,
  opts: UploadMediaOptions = {},
): Promise<UploadedAsset> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("tag", opts.tag ?? "board-uploads");
  if (opts.tags && opts.tags.length > 0) fd.append("tags", opts.tags.join(","));
  if (opts.source_kind) fd.append("source_kind", opts.source_kind);
  if (opts.collection_key) fd.append("collection_key", opts.collection_key);
  if (opts.product_key) fd.append("product_key", opts.product_key);
  if (opts.shot_key) fd.append("shot_key", opts.shot_key);
  if (opts.board_id) fd.append("board_id", opts.board_id);
  if (opts.status) fd.append("status", opts.status);
  if (opts.name) fd.append("name", opts.name);
  let accessToken: string | null = null;
  try {
    const result = await Promise.race([
      supabase.auth.getSession(),
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error("getSession timeout")), 1200);
      }),
    ]);
    accessToken = result.data.session?.access_token ?? null;
  } catch {
    accessToken = null;
  }
  const res = await fetch(`${FN_URL}/media`, {
    method: "POST",
    headers: {
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: fd,
  });
  if (!res.ok) {
    let detail = `upload ${res.status}`;
    try {
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      const message = json?.error?.message;
      if (typeof message === "string" && message) detail = message;
    } catch {
      // Keep the status-only fallback.
    }
    throw new Error(detail);
  }
  return await res.json();
}
