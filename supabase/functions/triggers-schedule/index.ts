// /functions/v1/triggers-schedule
// Internal cron fan-out. pg_cron calls this once a minute, the function picks
// every due schedule trigger and starts a session for it. The endpoint
// requires the service role key in the Authorization header (service-role
// bypasses RLS). It is otherwise public — JWT verification is disabled in
// config.toml.

import { wrap } from "../_shared/cors.ts";
import { ok, Forbidden } from "../_shared/errors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { ENV } from "../_shared/env.ts";
import { AnthropicSessionEvents, AnthropicSessions } from "../_shared/anthropic.ts";

Deno.serve(wrap(async (req) => {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.includes(ENV.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Forbidden("triggers-schedule requires the service role key");
  }
  const sc = serviceClient();
  const { data: due } = await sc.rpc("due_schedule_triggers");
  const fired: string[] = [];
  for (const row of due ?? []) {
    try {
      await fireSchedule(sc, row);
      await sc.rpc("advance_schedule_trigger", { p_trigger_id: row.trigger_id });
      fired.push(row.trigger_id);
    } catch (err) {
      console.warn("schedule trigger fire failed:", row.trigger_id, err);
    }
  }
  return ok({ fired_count: fired.length, fired });
}));

async function fireSchedule(
  sc: ReturnType<typeof serviceClient>,
  row: { trigger_id: string; workflow_id: string; config: Record<string, unknown> },
): Promise<void> {
  const { data: workflow } = await sc.from("workflows").select("*").eq("id", row.workflow_id)
    .maybeSingle();
  if (!workflow || !workflow.enabled) return;
  const { data: agent } = await sc
    .from("agents")
    .select("id, anthropic_id")
    .eq("created_by", workflow.created_by)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: environment } = await sc
    .from("environments")
    .select("id, anthropic_id")
    .eq("created_by", workflow.created_by)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!agent?.anthropic_id || !environment?.anthropic_id) return;
  const session = await AnthropicSessions.create({
    agent: agent.anthropic_id,
    environment_id: environment.anthropic_id,
    title: `Scheduled: ${workflow.name}`,
  });
  await sc.from("sessions").insert({
    anthropic_id: session.id,
    workflow_id: workflow.id,
    agent_id: agent.id,
    environment_id: environment.id,
    title: `Scheduled: ${workflow.name}`,
    status: "idle",
    trigger_summary: "schedule",
    started_by: workflow.created_by,
  });
  const agentNode = (workflow.graph?.nodes ?? []).find((n: any) => n.type === "agent");
  const events: any[] = [];
  if (agentNode?.outcome) {
    events.push({
      type: "user.define_outcome",
      description: agentNode.outcome.description,
      rubric: { type: "text", content: agentNode.outcome.rubric_md },
      max_iterations: agentNode.outcome.max_iterations,
    });
  }
  events.push({
    type: "user.message",
    content: [{
      type: "text",
      text: agentNode?.instructions ?? "Run the scheduled task.",
    }],
  });
  await AnthropicSessionEvents.send(session.id, events);
}
