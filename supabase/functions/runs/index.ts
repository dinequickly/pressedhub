// /functions/v1/runs
//   GET /              List runs (admin: all; member: their own).
//   GET /:id           Get one run with iterations + events.

import { wrap } from "../_shared/cors.ts";
import { Router } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { NotFound, ok } from "../_shared/errors.ts";

const router = new Router("runs");

router.get("/", async (req) => {
  const user = await requireUser(req);
  // sessions table is the authoritative source for runs.
  const { data, error } = await user.db
    .from("sessions")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data: session, error } = await user.db.from("sessions").select("*").eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!session) throw new NotFound("Run not found");
  const { data: events } = await user.db
    .from("session_events")
    .select("*")
    .eq("session_id", params.id)
    .order("created_at");
  return ok({ session, events: events ?? [] });
});

Deno.serve(wrap((req) => router.handle(req)));
