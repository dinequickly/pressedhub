// Service-role helper that creates an Anthropic session, mirrors the local
// `sessions` row, and (optionally) sends an initial user.message kickoff.
// Used by trigger surfaces — schedules, Slack webhook, future webhook-based
// triggers — that need to start a session without a user JWT in scope.
//
// User-facing chat sessions go through /functions/v1/sessions instead so
// they can resolve KB/memory/vault resources from the user's RLS view.

import {
  AnthropicSessionEvents,
  AnthropicSessions,
  type UserEvent,
} from "./anthropic.ts";
import type { SupabaseClient } from "./supabase.ts";

export type BootstrapInput = {
  agentId: string;
  /** If null, falls back to the most-recently-created environment. */
  environmentId: string | null;
  /** Profile id to credit as `started_by`. */
  startedBy: string;
  /** Free-form text used as the local trigger label so the worker can
   *  recognize sessions it owns (skip_if_running etc). */
  triggerSummary: string;
  /** Stored as-is on the local session row. */
  triggerPayload?: Record<string, unknown>;
  /** Visible title on the session list / Roster tile. */
  title: string;
  /** First user message sent into the new session. Skipped when null. */
  initialMessage?: string | null;
};

export async function bootstrapSession(
  sc: SupabaseClient,
  input: BootstrapInput,
): Promise<{ localId: string; anthropicId: string }> {
  const { data: agent } = await sc
    .from("agents").select("anthropic_id").eq("id", input.agentId).maybeSingle();
  if (!agent?.anthropic_id) throw new Error("agent has no anthropic_id");

  let envId = input.environmentId;
  if (!envId) {
    const { data: envs } = await sc
      .from("environments")
      .select("id,anthropic_id")
      .order("created_at", { ascending: false })
      .limit(1);
    if (!envs?.length || !envs[0].anthropic_id) {
      throw new Error("no environment available — create one before triggering this agent");
    }
    envId = envs[0].id as string;
  }
  const { data: env } = await sc
    .from("environments").select("anthropic_id").eq("id", envId).maybeSingle();
  if (!env?.anthropic_id) throw new Error("environment has no anthropic_id");

  const created = await AnthropicSessions.create({
    agent: agent.anthropic_id as string,
    environment_id: env.anthropic_id as string,
    title: input.title,
  });

  const { data: localSession, error } = await sc.from("sessions").insert({
    anthropic_id: created.id,
    agent_id: input.agentId,
    environment_id: envId,
    title: input.title,
    status: "idle",
    trigger_payload: input.triggerPayload ?? null,
    trigger_summary: input.triggerSummary,
    started_by: input.startedBy,
  }).select().single();
  if (error) throw new Error(`session insert: ${error.message}`);

  if (input.initialMessage) {
    const events: UserEvent[] = [{
      type: "user.message",
      content: [{ type: "text", text: input.initialMessage }],
    }];
    try {
      await AnthropicSessionEvents.send(created.id, events);
    } catch (err) {
      // Local row exists; surface but don't unwind.
      console.warn("[bootstrapSession] events.send failed:", err);
    }
  }
  return { localId: localSession.id as string, anthropicId: created.id };
}
