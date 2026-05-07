// /functions/v1/environments
//   GET    /          List.
//   GET    /:id       Get one.
//   POST   /          Create local + Anthropic environment.
//   DELETE /:id       Archive locally + on Anthropic.

import { wrap } from "../_shared/cors.ts";
import { Router, readJson } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { BadRequest, NotFound, noContent, ok, Upstream } from "../_shared/errors.ts";
import { EnvironmentCreateSchema } from "../_shared/schemas.ts";
import { AnthropicEnvironments } from "../_shared/anthropic.ts";
import { writeAudit } from "../_shared/audit.ts";

const router = new Router("environments");

router.get("/", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("environments")
    .select("*")
    .is("archived_at", null)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("environments").select("*").eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Environment not found");
  return ok(data);
});

router.post("/", async (req) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const parsed = EnvironmentCreateSchema.parse(body);

  let anthropicId: string | null = null;
  try {
    const created = await AnthropicEnvironments.create({
      name: parsed.name,
      config: parsed.config as Record<string, unknown>,
    });
    anthropicId = created.id;
  } catch (err) {
    throw new Upstream(`Anthropic environments.create failed: ${(err as Error).message}`);
  }
  const { data: row, error } = await user.db
    .from("environments")
    .insert({
      name: parsed.name,
      config: parsed.config,
      anthropic_id: anthropicId,
      created_by: user.id,
    })
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  await writeAudit({
    actor_id: user.id,
    action: "environment.create",
    resource_type: "environment",
    resource_id: row.id,
  });
  return ok(row, 201);
});

router.delete("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data: existing } = await user.db.from("environments").select("anthropic_id").eq(
    "id",
    params.id,
  ).maybeSingle();
  if (!existing) throw new NotFound("Environment not found");
  if (existing.anthropic_id) {
    try {
      await AnthropicEnvironments.archive(existing.anthropic_id);
    } catch (err) {
      console.warn("anthropic archive failed:", err);
    }
  }
  const { error } = await user.db
    .from("environments")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", params.id);
  if (error) throw new Error(error.message);
  await writeAudit({
    actor_id: user.id,
    action: "environment.archive",
    resource_type: "environment",
    resource_id: params.id,
  });
  return noContent();
});

Deno.serve(wrap((req) => router.handle(req)));
