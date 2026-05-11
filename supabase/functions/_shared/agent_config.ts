import { AnthropicAgents } from "./anthropic.ts";
import { KB_TOOL_DEFS, KB_TOOL_NAMES } from "./kb_tools.ts";
import { ROSTER_STATUS_TOOL_DEFS, ROSTER_STATUS_TOOL_NAMES } from "./roster_status_tools.ts";
import type { SupabaseClient } from "./supabase.ts";

const BUILTIN_TOOL_DEFS = [...KB_TOOL_DEFS, ...ROSTER_STATUS_TOOL_DEFS];
const BUILTIN_TOOL_NAMES = [...KB_TOOL_NAMES, ...ROSTER_STATUS_TOOL_NAMES] as const;

// Every general-purpose agent gets the base Anthropic toolset plus our
// platform-native helpers (KB + roster status). We strip built-ins from the
// caller-supplied list first so syncing is idempotent.
export function withBuiltinTools(stored: unknown[]): Record<string, unknown>[] {
  const base = (stored ?? []).filter((t) => {
    if (typeof t !== "object" || t === null) return true;
    const name = (t as Record<string, unknown>).name;
    return !(typeof name === "string" && (BUILTIN_TOOL_NAMES as readonly string[]).includes(name));
  }) as Record<string, unknown>[];
  return [...base, ...BUILTIN_TOOL_DEFS];
}

// Skill entries are stored locally with a `local_id` so the UI can round-trip
// the selection. Anthropic only accepts `type` / `skill_id` / `version`, so we
// strip the local-only fields before forwarding.
export function skillsForAnthropic(stored: unknown[]): Record<string, unknown>[] {
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

// Safety net: sync the current built-in toolset onto the Anthropic agent
// before starting a session, so existing agents pick up new platform-native
// tools even if nobody has manually edited them in the UI.
export async function syncAgentBuiltins(
  sc: SupabaseClient,
  agentId: string,
): Promise<void> {
  const { data: agent, error } = await sc
    .from("agents")
    .select("id,anthropic_id,anthropic_version,name,model,system_prompt,tools,skills,mcp_servers")
    .eq("id", agentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!agent?.anthropic_id) return;

  const baseTools = Array.isArray(agent.tools) ? agent.tools as unknown[] : [];
  const updated = await AnthropicAgents.update(agent.anthropic_id as string, {
    version: (agent.anthropic_version as number | null) ?? 1,
    name: agent.name as string,
    model: agent.model as string,
    system: agent.system_prompt as string,
    tools: withBuiltinTools(
      baseTools.length ? baseTools : [{ type: "agent_toolset_20260401" }],
    ),
    skills: skillsForAnthropic((agent.skills as unknown[] | null) ?? []),
    mcp_servers: ((agent.mcp_servers as Record<string, unknown>[] | null) ?? []),
  } as { version: number });

  if ((updated.version ?? null) !== agent.anthropic_version) {
    await sc.from("agents")
      .update({ anthropic_version: updated.version })
      .eq("id", agent.id as string);
  }
}
