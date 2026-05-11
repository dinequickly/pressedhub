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

const MAX_INFLIGHT = 4;
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

export function loadThumb(mediaAssetId: string): Promise<string> {
  const existing = cache.get(mediaAssetId);
  if (existing) return existing;
  const p = (async () => {
    await acquire();
    try {
      const res = await api.getRaw(`/media/${mediaAssetId}/content`);
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } finally {
      release();
    }
  })();
  // If the underlying fetch fails, drop the cache entry so the next caller
  // can retry instead of getting the rejected promise forever.
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
