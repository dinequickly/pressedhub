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
import {
  SkillCreateSchema,
  SkillDraftSchema,
  SkillTestRunSchema,
  SkillUpdateSchema,
} from "../_shared/schemas.ts";
import { AnthropicMessages, AnthropicSkills } from "../_shared/anthropic.ts";
import { writeAudit } from "../_shared/audit.ts";
import { zipSync } from "npm:fflate@0.8.2";

const router = new Router("skills");

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "skill";
}

function skillMarkdown(name: string, description: string, content_md: string): string {
  // Anthropic's skills API extracts `name` and `description` from a YAML
  // frontmatter block at the top of SKILL.md. If the user-authored markdown
  // already has frontmatter we keep it; otherwise we wrap their content in
  // the minimum required preamble.
  const hasFrontmatter = /^---\s*\n[\s\S]*?\n---\s*\n/.test(content_md);
  if (hasFrontmatter) return content_md;
  return `---\nname: ${slugify(name)}\ndescription: ${description.replaceAll("\n", " ")}\n---\n\n${content_md}`;
}

// Anthropic's API rejects a bare SKILL.md ("must be exactly in the top-level
// folder"). It expects a zip whose top-level entry is a single directory
// containing SKILL.md. Build that zip in-memory.
function skillZip(name: string, description: string, content_md: string): Blob {
  const dir = slugify(name);
  const md = skillMarkdown(name, description, content_md);
  const bytes = zipSync({
    [dir]: {
      "SKILL.md": new TextEncoder().encode(md),
    },
  });
  return new Blob([bytes], { type: "application/zip" });
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

// Draft a SKILL.md from a chat conversation. Stateless: caller passes the full
// transcript and the in-progress markdown; we return the next assistant turn
// plus an updated SKILL.md. The model is told to wrap the markdown in a fenced
// block tagged ```skill so we can extract it deterministically.
router.post("/draft", async (req) => {
  const user = await requireUser(req);
  const parsed = SkillDraftSchema.parse(await readJson(req));

  const system = [
    "You are an expert at authoring Anthropic Skills.",
    "A SKILL.md is a concise, instruction-style markdown file that an agent reads to learn how to perform a task. The body should include: a short title (#), a one-sentence purpose, when to invoke, step-by-step instructions, and any important constraints or examples.",
    "Do NOT include YAML frontmatter (no `---` block). The user maintains the description in a separate field; you'll return it on its own line.",
    "On every turn, return EXACTLY three sections in this order, with no extra prose:",
    "1) A single line: REPLY: <one short sentence to the user about what you changed or are asking>",
    "2) A single line: DESCRIPTION: <one sentence — when should an agent reach for this skill?>",
    "3) A fenced code block tagged `skill` containing the full updated body of the SKILL.md (markdown only, no frontmatter, full file not a diff).",
    "If the user has not given you enough to draft yet, still return all three sections — put a stub body in the fence, a placeholder DESCRIPTION, and a clarifying question in REPLY.",
    parsed.current_md
      ? `\nCurrent SKILL.md body the user has been editing:\n\n${parsed.current_md}`
      : "",
  ].join("\n");

  let text: string;
  try {
    const res = await AnthropicMessages.create({
      system,
      messages: parsed.messages,
    });
    text = res.text;
  } catch (err) {
    throw new Upstream(`Anthropic messages.create failed: ${(err as Error).message}`);
  }

  const replyMatch = text.match(/REPLY:\s*(.+?)(?:\n|$)/);
  const descMatch = text.match(/DESCRIPTION:\s*(.+?)(?:\n|$)/);
  const fenceMatch = text.match(/```(?:skill|markdown|md)?\s*\n([\s\S]*?)\n```/);
  const assistant_message = replyMatch?.[1]?.trim() ?? "Updated the skill.";
  const description = descMatch?.[1]?.trim() ?? "";
  const content_md = (fenceMatch?.[1] ?? parsed.current_md).trim();

  await writeAudit({
    actor_id: user.id,
    action: "skill.draft",
    resource_type: "skill",
    resource_id: null,
  });

  return ok({ assistant_message, content_md, description });
});

// One-shot test of an in-progress SKILL.md: load it as the system prompt and
// reply to the user's prompt. This intentionally does NOT create an Anthropic
// skill — it's a fast preview, not a full session.
router.post("/test-run", async (req) => {
  await requireUser(req);
  const parsed = SkillTestRunSchema.parse(await readJson(req));

  const system = [
    "You are an agent that has been given the following skill. Follow it exactly.",
    "",
    "--- BEGIN SKILL.md ---",
    parsed.content_md,
    "--- END SKILL.md ---",
  ].join("\n");

  try {
    const res = await AnthropicMessages.create({
      system,
      messages: [{ role: "user", content: parsed.prompt }],
    });
    return ok({ output: res.text });
  } catch (err) {
    throw new Upstream(`Anthropic messages.create failed: ${(err as Error).message}`);
  }
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
    // The Skills API does create+v1 in a single multipart POST. We send a
    // SKILL.md with the YAML frontmatter the API expects so the version
    // metadata (name/description) gets populated.
    try {
      const created = await AnthropicSkills.create({
        display_title: parsed.name,
        file: skillZip(parsed.name, parsed.description, parsed.content_md),
        filename: `${slugify(parsed.name)}.zip`,
      });
      anthropic_skill_id = created.id;
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
  // Anthropic requires the SKILL.md frontmatter `name:` (the internal slug)
  // to stay stable across all versions of a skill. Renaming a skill in the
  // UI only changes our local label — for the upload we look up the slug
  // used by the most recent existing version and reuse it verbatim.
  if (existing.type === "custom" && parsed.content_md && existing.anthropic_skill_id) {
    try {
      let canonicalSlug = slugify(existing.name as string);
      try {
        const versions = await AnthropicSkills.list_versions(existing.anthropic_skill_id, {
          limit: 1,
        });
        const latest = versions.data?.[0];
        if (latest?.name) canonicalSlug = latest.name;
        else if (latest?.directory) canonicalSlug = latest.directory;
      } catch (_e) { /* fall back to local-name slug */ }
      await AnthropicSkills.upload_version(
        existing.anthropic_skill_id,
        skillZip(
          canonicalSlug,
          parsed.description ?? existing.description,
          parsed.content_md,
        ),
        `${canonicalSlug}.zip`,
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
      await AnthropicSkills.delete(existing.anthropic_skill_id);
    } catch (err) {
      console.warn("anthropic skill delete failed:", err);
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
