// /functions/v1/skills
//   GET    /          List skills.
//   GET    /:id       Get one.
//   POST   /          Create. For type=custom, also creates an Anthropic skill
//                     and uploads the SKILL.md as v1.
//   PATCH  /:id       Update local + (for custom) upload a new version.
//   DELETE /:id       Archive locally + on Anthropic.

import { wrap } from "../_shared/cors.ts";
import { Router, readJson } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { BadRequest, NotFound, noContent, ok, Upstream } from "../_shared/errors.ts";
import { SkillCreateSchema, SkillUpdateSchema } from "../_shared/schemas.ts";
import { AnthropicSkills } from "../_shared/anthropic.ts";
import { writeAudit } from "../_shared/audit.ts";

const router = new Router("skills");

function skillFile(name: string, content_md: string): Blob {
  // The Skill upload accepts a SKILL.md or a tarball. Sending a single
  // SKILL.md blob is the simplest path for v1 custom skills.
  const body = `# ${name}\n\n${content_md}`;
  return new Blob([body], { type: "text/markdown" });
}

router.get("/", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("skills")
    .select("*")
    .is("archived_at", null)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("skills").select("*").eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Skill not found");
  return ok(data);
});

router.post("/", async (req) => {
  const user = await requireUser(req);
  const parsed = SkillCreateSchema.parse(await readJson(req));

  let anthropic_skill_id = parsed.anthropic_skill_id ?? null;

  if (parsed.type === "custom") {
    try {
      const created = await AnthropicSkills.create({
        display_name: parsed.name,
        description: parsed.description,
      });
      anthropic_skill_id = created.id;
      await AnthropicSkills.upload_version(created.id, skillFile(parsed.name, parsed.content_md));
    } catch (err) {
      throw new Upstream(`Anthropic skill create failed: ${(err as Error).message}`);
    }
  }

  const { data: row, error } = await user.db
    .from("skills")
    .insert({
      type: parsed.type,
      name: parsed.name,
      description: parsed.description,
      content_md: parsed.content_md,
      pinned: parsed.pinned,
      anthropic_skill_id,
      created_by: user.id,
    })
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  await writeAudit({
    actor_id: user.id,
    action: "skill.create",
    resource_type: "skill",
    resource_id: row.id,
  });
  return ok(row, 201);
});

router.patch("/:id", async (req, params) => {
  const user = await requireUser(req);
  const parsed = SkillUpdateSchema.parse(await readJson(req));
  const { data: existing } = await user.db.from("skills").select("*").eq("id", params.id)
    .maybeSingle();
  if (!existing) throw new NotFound("Skill not found");

  // For custom skills, upload a new version when the markdown body changes.
  if (existing.type === "custom" && parsed.content_md && existing.anthropic_skill_id) {
    try {
      await AnthropicSkills.upload_version(
        existing.anthropic_skill_id,
        skillFile(parsed.name ?? existing.name, parsed.content_md),
      );
    } catch (err) {
      throw new Upstream(`Anthropic skill upload failed: ${(err as Error).message}`);
    }
  }

  const { data: row, error } = await user.db
    .from("skills")
    .update(parsed)
    .eq("id", params.id)
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  await writeAudit({
    actor_id: user.id,
    action: "skill.update",
    resource_type: "skill",
    resource_id: params.id,
  });
  return ok(row);
});

router.delete("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data: existing } = await user.db.from("skills").select("anthropic_skill_id,type").eq(
    "id",
    params.id,
  ).maybeSingle();
  if (!existing) throw new NotFound("Skill not found");
  if (existing.type === "custom" && existing.anthropic_skill_id) {
    try {
      await AnthropicSkills.archive(existing.anthropic_skill_id);
    } catch (err) {
      console.warn("anthropic skill archive failed:", err);
    }
  }
  const { error } = await user.db
    .from("skills")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", params.id);
  if (error) throw new Error(error.message);
  return noContent();
});

Deno.serve(wrap((req) => router.handle(req)));
