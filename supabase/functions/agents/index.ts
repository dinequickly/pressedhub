// /functions/v1/agents
// Local Agent records that mirror Anthropic agents 1:1.
//   GET    /                 List.
//   GET    /:id              Get one.
//   POST   /                 Create local + Anthropic agent.
//   PATCH  /:id              Update local + sync to Anthropic.
//   DELETE /:id              Archive locally + on Anthropic.

import { wrap } from "../_shared/cors.ts";
import { Router, readJson } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { BadRequest, NotFound, noContent, ok, Upstream } from "../_shared/errors.ts";
import { AgentCreateSchema, AgentUpdateSchema } from "../_shared/schemas.ts";
import { AnthropicAgents } from "../_shared/anthropic.ts";
import { KB_TOOL_DEFS, KB_TOOL_NAMES } from "../_shared/kb_tools.ts";
import { writeAudit } from "../_shared/audit.ts";

const router = new Router("agents");

// Every agent gets the KB toolset for free, on top of whatever toolset the
// caller specified. Strip any pre-existing kb_* entries to keep create/update
// idempotent if the caller round-trips agent.tools through us.
function withKbTools(stored: unknown[]): Record<string, unknown>[] {
  const base = (stored ?? []).filter((t) => {
    if (typeof t !== "object" || t === null) return true;
    const name = (t as Record<string, unknown>).name;
    return !(typeof name === "string" && (KB_TOOL_NAMES as readonly string[]).includes(name));
  }) as Record<string, unknown>[];
  return [...base, ...KB_TOOL_DEFS];
}

// Skill entries are stored locally with a `local_id` so the UI can round-trip
// the selection. Anthropic only accepts `type` / `skill_id` / `version`, so we
// strip the local-only fields before forwarding.
function skillsForAnthropic(stored: unknown[]): Record<string, unknown>[] {
  return (stored ?? [])
    .map((s) => {
      if (typeof s !== "object" || s === null) return null;
      const o = s as Record<string, unknown>;
      const skill_id = o.skill_id ?? o.id;
      const type = o.type;
      if (typeof skill_id !== "string" || (type !== "anthropic" && type !== "custom")) {
        return null;
      }
      const out: Record<string, unknown> = { type, skill_id };
      if (type === "custom") out.version = (o.version as string) ?? "latest";
      return out;
    })
    .filter(Boolean) as Record<string, unknown>[];
}

router.get("/", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("agents")
    .select("*")
    .is("archived_at", null)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("agents").select("*").eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Agent not found");
  return ok(data);
});

router.post("/", async (req) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const parsed = AgentCreateSchema.parse(body);

  // 1) Create the Anthropic agent. We only ever default the toolset; everything
  //    else is whatever the caller provided. Catch upstream errors so we don't
  //    end up with an orphan row in our DB.
  let anthropicId: string | null = null;
  let anthropicVersion = 1;
  try {
    const created = await AnthropicAgents.create({
      name: parsed.name,
      model: parsed.model,
      system: parsed.system_prompt,
      tools: withKbTools(
        parsed.tools.length
          ? (parsed.tools as Record<string, unknown>[])
          : [{ type: "agent_toolset_20260401" }],
      ),
      mcp_servers: parsed.mcp_servers as Record<string, unknown>[],
      skills: skillsForAnthropic(parsed.skills),
    });
    anthropicId = created.id;
    anthropicVersion = created.version ?? 1;
  } catch (err) {
    throw new Upstream(`Anthropic agents.create failed: ${(err as Error).message}`);
  }

  const { data: row, error } = await user.db
    .from("agents")
    .insert({
      anthropic_id: anthropicId,
      anthropic_version: anthropicVersion,
      name: parsed.name,
      role: parsed.role,
      emoji: parsed.emoji,
      accent: parsed.accent,
      model: parsed.model,
      system_prompt: parsed.system_prompt,
      instructions: parsed.instructions,
      tools: parsed.tools,
      skills: parsed.skills,
      mcp_servers: parsed.mcp_servers,
      outcome: parsed.outcome ?? null,
      brain: parsed.brain,
      default_resources: parsed.default_resources ?? { kb_file_ids: [], memory_store_ids: [] },
      created_by: user.id,
    })
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  await writeAudit({
    actor_id: user.id,
    action: "agent.create",
    resource_type: "agent",
    resource_id: row.id,
    metadata: { anthropic_id: anthropicId },
  });
  return ok(row, 201);
});

router.patch("/:id", async (req, params) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const parsed = AgentUpdateSchema.parse(body);

  const { data: existing, error: fetchErr } = await user.db
    .from("agents")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (fetchErr) throw new Error(fetchErr.message);
  if (!existing) throw new NotFound("Agent not found");

  // Sync to Anthropic if anything material changed.
  if (existing.anthropic_id) {
    try {
      const updateInput: Record<string, unknown> = { version: existing.anthropic_version };
      if (parsed.system_prompt !== undefined) updateInput.system = parsed.system_prompt;
      if (parsed.model !== undefined) updateInput.model = parsed.model;
      if (parsed.name !== undefined) updateInput.name = parsed.name;
      // Always re-sync the toolset so existing agents pick up new built-in
      // tools (kb_*). Caller-provided tools take precedence; otherwise we
      // round-trip whatever the local row already had.
      const baseTools = parsed.tools !== undefined
        ? parsed.tools
        : ((existing.tools as unknown[] | null) ?? []);
      updateInput.tools = withKbTools(
        baseTools.length ? baseTools : [{ type: "agent_toolset_20260401" }],
      );
      if (parsed.skills !== undefined) updateInput.skills = skillsForAnthropic(parsed.skills);
      if (parsed.mcp_servers !== undefined) updateInput.mcp_servers = parsed.mcp_servers;
      const updated = await AnthropicAgents.update(
        existing.anthropic_id,
        updateInput as { version: number },
      );
      parsed && (existing.anthropic_version = updated.version ?? existing.anthropic_version);
    } catch (err) {
      throw new Upstream(`Anthropic agents.update failed: ${(err as Error).message}`);
    }
  }

  const update: Record<string, unknown> = { anthropic_version: existing.anthropic_version };
  for (const k of Object.keys(parsed) as Array<keyof typeof parsed>) {
    update[k] = parsed[k] as unknown;
  }
  const { data: row, error } = await user.db
    .from("agents")
    .update(update)
    .eq("id", params.id)
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  await writeAudit({
    actor_id: user.id,
    action: "agent.update",
    resource_type: "agent",
    resource_id: row.id,
  });
  return ok(row);
});

router.delete("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data: existing } = await user.db.from("agents").select("anthropic_id").eq(
    "id",
    params.id,
  ).maybeSingle();
  if (!existing) throw new NotFound("Agent not found");
  if (existing.anthropic_id) {
    try {
      await AnthropicAgents.archive(existing.anthropic_id);
    } catch (err) {
      // If Anthropic archive fails, still archive locally so the user isn't
      // stuck looking at a broken row.
      console.warn("anthropic archive failed:", err);
    }
  }
  const { error } = await user.db
    .from("agents")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", params.id);
  if (error) throw new Error(error.message);
  await writeAudit({
    actor_id: user.id,
    action: "agent.archive",
    resource_type: "agent",
    resource_id: params.id,
  });
  return noContent();
});

Deno.serve(wrap((req) => router.handle(req)));
