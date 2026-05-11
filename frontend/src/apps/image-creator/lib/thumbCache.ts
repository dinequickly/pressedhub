// Shared thumbnail loader with bounded concurrency.
//
// We have multiple places that render thumbnails for media assets — the
// canvas image bodies, the toolbar sidebar, the library picker — and they
// were each firing their own `api.getRaw` on mount. On a board with even
// modest content (or the library picker open against 100+ assets), that
// fan-out instantly exceeded the local supabase edge runtime's worker
// budget, producing a cascade of 503s.
//
// This module solves both problems:
//   - `loadThumb(id)` is memoized by id, so the same asset is fetched once
//     and reused. Returns a stable Promise<string> resolving to a blob URL.
//   - Fetches go through a semaphore that caps in-flight requests. Default
//     limit is conservative; raise it for production cloud edge functions
//     where worker capacity is much larger.

import { api } from "../../../lib/api";
import { supabase } from "../../../lib/supabase";

const MAX_INFLIGHT = 8;
let inflight = 0;
const queue: Array<() => void> = [];
const cache = new Map<string, Promise<string>>();

function acquire(): Promise<void> {
  if (inflight < MAX_INFLIGHT) {
    inflight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    queue.push(() => { inflight++; resolve(); });
  });
}
function release(): void {
  inflight--;
  const next = queue.shift();
  if (next) next();
}

const SIGN_BATCH = 20;

/** Batch-sign all storage paths in chunks and warm the cache.
 *  Falls back to individual createSignedUrl per asset when the batch call
 *  fails so a single bad chunk doesn't leave half the library unloaded. */
export async function preloadThumbs(
  assets: Array<{ id: string; storage_path?: string | null }>,
): Promise<void> {
  const todo = assets.filter((a) => a.storage_path && !cache.has(a.id));
  if (todo.length === 0) return;

  for (let start = 0; start < todo.length; start += SIGN_BATCH) {
    const chunk = todo.slice(start, start + SIGN_BATCH);
    const paths = chunk.map((a) => a.storage_path as string);

    const { data, error } = await supabase.storage
      .from("media")
      .createSignedUrls(paths, 60 * 60 * 24);

    if (!error && data) {
      for (let i = 0; i < chunk.length; i++) {
        const row = data[i];
        const url = (row as { signedUrl?: string; signedURL?: string })?.signedUrl
          ?? (row as { signedUrl?: string; signedURL?: string })?.signedURL;
        if (url && !cache.has(chunk[i].id)) {
          cache.set(chunk[i].id, Promise.resolve(url));
        }
      }
    } else {
      // Batch call failed — fall back to individual signing for this chunk.
      await Promise.all(chunk.map(async (asset) => {
        if (cache.has(asset.id)) return;
        const { data: signed, error: signErr } = await supabase.storage
          .from("media")
          .createSignedUrl(asset.storage_path as string, 60 * 60 * 24);
        if (!signErr && signed?.signedUrl) {
          cache.set(asset.id, Promise.resolve(signed.signedUrl));
        }
      }));
    }
  }
}

// Pass `storagePath` when available to skip an extra DB round-trip.
export function loadThumb(mediaAssetId: string, storagePath?: string | null): Promise<string> {
  const existing = cache.get(mediaAssetId);
  if (existing) return existing;
  const p = (async () => {
    await acquire();
    try {
      const path = storagePath ?? await (async () => {
        const { data: asset, error } = await supabase
          .from("media_assets")
          .select("storage_path")
          .eq("id", mediaAssetId)
          .maybeSingle();
        return (!error && asset?.storage_path) ? asset.storage_path : null;
      })();

      if (path) {
        const { data: signed, error: signedErr } = await supabase.storage
          .from("media")
          .createSignedUrl(path, 60 * 60 * 24);
        if (!signedErr && signed?.signedUrl) return signed.signedUrl;
      }

      // Fallback: fetch bytes through auth-protected media proxy.
      const res = await api.getRaw(`/media/${mediaAssetId}/content`);
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } finally {
      release();
    }
  })();
  p.catch(() => { cache.delete(mediaAssetId); });
  cache.set(mediaAssetId, p);
  return p;
}

// Forget a thumbnail (e.g. when the asset is replaced). Doesn't revoke the
// blob URL because other consumers may still hold it; the GC handles it
// when the last reference goes away.
export function invalidateThumb(mediaAssetId: string): void {
  cache.delete(mediaAssetId);
}
