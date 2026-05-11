// /functions/v1/timeline
//   GET /campaigns?from=ISO&to=ISO[&channel=...]
//   GET /metrics?from=ISO&to=ISO[&kind=...]   (kind may repeat)
//   GET /annotations?from=ISO&to=ISO
//
// All three return { data: [...] }. The frontend handles bucketing /
// scale-aware aggregation; this layer is just a typed read.

import { wrap } from "../_shared/cors.ts";
import { Router } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { ok } from "../_shared/errors.ts";
import { maybeSyncTimeline } from "../_shared/timeline_sync.ts";

const router = new Router("timeline");

// Lazy-sync wrapper. Every read path runs this first so KB updates show up
// without an explicit sync call. Errors during sync are logged but don't
// fail the request — falls back to whatever's already in the table.
async function ensureFresh(): Promise<void> {
  try {
    await maybeSyncTimeline(false);
  } catch (err) {
    console.warn("[timeline] lazy sync failed:", (err as Error).message);
  }
}

// Manual full resync. Useful from the frontend after a CSV upload.
router.post("/sync", async (req) => {
  await requireUser(req);
  const result = await maybeSyncTimeline(true);
  return ok(result);
});

router.get("/campaigns", async (req) => {
  const user = await requireUser(req);
  await ensureFresh();
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const channel = url.searchParams.get("channel");

  let query = user.db.from("campaigns").select(
    "id,name,channel,started_at,ended_at,description,metadata,source",
  ).order("started_at", { ascending: true }).limit(2000);
  if (from) query = query.gte("ended_at", from);
  if (to) query = query.lte("started_at", to);
  if (channel) query = query.eq("channel", channel);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/metrics", async (req) => {
  const user = await requireUser(req);
  await ensureFresh();
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const kinds = url.searchParams.getAll("kind");

  let query = user.db.from("metrics").select(
    "kind,occurred_at,value,dimensions,source",
  ).order("occurred_at", { ascending: true }).limit(20000);
  if (from) query = query.gte("occurred_at", from);
  if (to) query = query.lte("occurred_at", to);
  if (kinds.length === 1) query = query.eq("kind", kinds[0]);
  if (kinds.length > 1) query = query.in("kind", kinds);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/annotations", async (req) => {
  const user = await requireUser(req);
  await ensureFresh();
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  let query = user.db.from("annotations").select(
    "id,at,kind,label,description,source",
  ).order("at", { ascending: true }).limit(2000);
  if (from) query = query.gte("at", from);
  if (to) query = query.lte("at", to);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ok({ data });
});

Deno.serve(wrap((req) => router.handle(req)));
