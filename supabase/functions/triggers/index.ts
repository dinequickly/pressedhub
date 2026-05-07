// /functions/v1/triggers — Authenticated CRUD over workflow_triggers.
//   GET    /                List the caller's triggers.
//   POST   /                Create. For webhook kind, an opaque token is generated.
//   GET    /:id             Get one.
//   PATCH  /:id             Update.
//   DELETE /:id             Delete.

import { wrap } from "../_shared/cors.ts";
import { Router, readJson } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { BadRequest, NotFound, noContent, ok } from "../_shared/errors.ts";
import { TriggerCreateSchema, TriggerUpdateSchema } from "../_shared/schemas.ts";

const router = new Router("triggers");

router.get("/", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("workflow_triggers").select("*").order("created_at");
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("workflow_triggers").select("*").eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Trigger not found");
  return ok(data);
});

router.post("/", async (req) => {
  const user = await requireUser(req);
  const parsed = TriggerCreateSchema.parse(await readJson(req));
  // Generate a webhook token if the caller didn't supply one.
  const config = { ...(parsed.config as Record<string, unknown>) };
  if (parsed.kind === "webhook" && !config.token) {
    config.token = crypto.randomUUID().replace(/-/g, "");
  }
  if (parsed.kind === "schedule" && !config.next_run_at) {
    config.next_run_at = new Date(Date.now() + 60_000).toISOString();
  }
  const { data, error } = await user.db
    .from("workflow_triggers")
    .insert({
      workflow_id: parsed.workflow_id,
      kind: parsed.kind,
      config,
      enabled: parsed.enabled,
      created_by: user.id,
    })
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  return ok(data, 201);
});

router.patch("/:id", async (req, params) => {
  const user = await requireUser(req);
  const parsed = TriggerUpdateSchema.parse(await readJson(req));
  const { data, error } = await user.db
    .from("workflow_triggers")
    .update(parsed)
    .eq("id", params.id)
    .select()
    .maybeSingle();
  if (error) throw new BadRequest(error.message);
  if (!data) throw new NotFound("Trigger not found");
  return ok(data);
});

router.delete("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { error } = await user.db.from("workflow_triggers").delete().eq("id", params.id);
  if (error) throw new Error(error.message);
  return noContent();
});

Deno.serve(wrap((req) => router.handle(req)));
