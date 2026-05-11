// /functions/v1/apps
//
// DEPRECATED — superseded by the in-tree Apps framework at
// frontend/src/apps/. The hub's frontend no longer calls this endpoint or
// uses the `apps` table; both are kept only because smoke-phase-f exercises
// them. Cleanup plan (see To-Do.md → "Apps backend cleanup"):
//   1. Update smoke-phase-f to drop the apps section
//   2. Drop this file
//   3. Write a migration to drop the `apps` + `app_deployments` tables
//
// Until that lands this file is harmless dead code.
//
//   GET    /                List apps visible to the caller.
//   POST   /                Create.
//   GET    /:id             Get one.
//   PATCH  /:id             Update fields.
//   DELETE /:id             Delete.
//   POST   /:id/deploy      { deployed_to: [user_id] } — replaces deployments.

import { wrap } from "../_shared/cors.ts";
import { Router, readJson } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { BadRequest, NotFound, noContent, ok } from "../_shared/errors.ts";
import { AppCreateSchema, AppDeploySchema, AppUpdateSchema } from "../_shared/schemas.ts";
import { writeAudit } from "../_shared/audit.ts";

const router = new Router("apps");

async function shape(user: { db: any }, app: any): Promise<Record<string, unknown>> {
  const { data: deps } = await user.db.from("app_deployments").select("user_id").eq("app_id", app.id);
  return {
    ...app,
    deployed_to: (deps ?? []).map((d: any) => d.user_id),
  };
}

router.get("/", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("apps").select("*").order("updated_at", {
    ascending: false,
  });
  if (error) throw new Error(error.message);
  const shaped = await Promise.all((data ?? []).map((a) => shape(user, a)));
  return ok({ data: shaped });
});

router.get("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("apps").select("*").eq("id", params.id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("App not found");
  return ok(await shape(user, data));
});

router.post("/", async (req) => {
  const user = await requireUser(req);
  const parsed = AppCreateSchema.parse(await readJson(req));
  const { data, error } = await user.db
    .from("apps")
    .insert({ ...parsed, created_by: user.id })
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  return ok(await shape(user, data), 201);
});

router.patch("/:id", async (req, params) => {
  const user = await requireUser(req);
  const parsed = AppUpdateSchema.parse(await readJson(req));
  const { data, error } = await user.db
    .from("apps")
    .update(parsed)
    .eq("id", params.id)
    .select()
    .maybeSingle();
  if (error) throw new BadRequest(error.message);
  if (!data) throw new NotFound("App not found");
  return ok(await shape(user, data));
});

router.delete("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { error } = await user.db.from("apps").delete().eq("id", params.id);
  if (error) throw new Error(error.message);
  return noContent();
});

router.post("/:id/deploy", async (req, params) => {
  const user = await requireUser(req);
  const parsed = AppDeploySchema.parse(await readJson(req));
  // Replace deployments atomically.
  await user.db.from("app_deployments").delete().eq("app_id", params.id);
  if (parsed.deployed_to.length > 0) {
    const rows = parsed.deployed_to.map((uid) => ({ app_id: params.id, user_id: uid }));
    const { error } = await user.db.from("app_deployments").insert(rows);
    if (error) throw new BadRequest(error.message);
  }
  // Flip status when first deployed.
  await user.db.from("apps").update({
    status: parsed.deployed_to.length > 0 ? "deployed" : "draft",
  }).eq("id", params.id);
  await writeAudit({
    actor_id: user.id,
    action: "app.deploy",
    resource_type: "app",
    resource_id: params.id,
    metadata: { deployed_to: parsed.deployed_to },
  });
  const { data: app } = await user.db.from("apps").select("*").eq("id", params.id).single();
  return ok(await shape(user, app));
});

Deno.serve(wrap((req) => router.handle(req)));
