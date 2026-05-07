// /functions/v1/triggers-webhook/<token>
// Public endpoint. Looks up a workflow_triggers row by token, then starts a
// session for the bound workflow's first agent node.
//
// JWT verification is disabled for this function in config.toml.

import { wrap } from "../_shared/cors.ts";
import { ok, BadRequest, NotFound, Upstream } from "../_shared/errors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { AnthropicSessions, AnthropicSessionEvents } from "../_shared/anthropic.ts";
import { writeAudit } from "../_shared/audit.ts";

Deno.serve(wrap(async (req) => {
  const url = new URL(req.url);
  // Path layout: /functions/v1/triggers-webhook/<token>
  const parts = url.pathname.split("/");
  const token = parts[parts.length - 1];
  if (!token) throw new BadRequest("Missing webhook token");

  const sc = serviceClient();
  const { data: trigger } = await sc
    .from("workflow_triggers")
    .select("*, workflows!inner(*)")
    .eq("kind", "webhook")
    .eq("config->>token", token)
    .maybeSingle();
  if (!trigger || !trigger.enabled) throw new NotFound("Webhook not found or disabled");

  const workflow = trigger.workflows as { id: string; graph: any; enabled: boolean; created_by: string };
  if (!workflow.enabled) throw new BadRequest("Workflow is disabled");

  const payload = req.method === "POST" ? await safeJson(req) : Object.fromEntries(url.searchParams);
  await runWorkflow(sc, workflow, payload, `webhook ${token.slice(0, 6)}…`);
  await writeAudit({
    action: "trigger.webhook",
    resource_type: "workflow",
    resource_id: workflow.id,
    metadata: { trigger_id: trigger.id },
  });
  return ok({ accepted: true });
}));

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

async function runWorkflow(
  sc: ReturnType<typeof serviceClient>,
  workflow: { id: string; graph: any; created_by: string },
  payload: unknown,
  triggerSummary: string,
): Promise<void> {
  const nodes: any[] = workflow.graph?.nodes ?? [];
  const agentNode = nodes.find((n) => n.type === "agent");
  if (!agentNode) {
    console.warn("workflow has no agent node, nothing to run", workflow.id);
    return;
  }
  // Resolve a default agent + environment for the workflow owner. Picks the
  // most recently updated row owned by the workflow creator.
  const { data: agent } = await sc
    .from("agents")
    .select("id, anthropic_id, model, system_prompt")
    .eq("created_by", workflow.created_by)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!agent?.anthropic_id) throw new BadRequest("No agent available for workflow owner");
  const { data: environment } = await sc
    .from("environments")
    .select("id, anthropic_id")
    .eq("created_by", workflow.created_by)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!environment?.anthropic_id) throw new BadRequest("No environment available");

  let session: any;
  try {
    session = await AnthropicSessions.create({
      agent: agent.anthropic_id,
      environment_id: environment.anthropic_id,
      title: `${triggerSummary}: ${(workflow as any).name ?? workflow.id}`,
    });
  } catch (err) {
    throw new Upstream(`Anthropic sessions.create failed: ${(err as Error).message}`);
  }
  // Persist the row.
  const { data: localSession } = await sc.from("sessions").insert({
    anthropic_id: session.id,
    workflow_id: workflow.id,
    agent_id: agent.id,
    environment_id: environment.id,
    title: triggerSummary,
    status: "idle",
    trigger_payload: payload as Record<string, unknown>,
    trigger_summary: triggerSummary,
    started_by: workflow.created_by,
  }).select().single();

  // Kick off with a user.message that includes the agent's instructions and
  // the trigger payload as JSON.
  const messageParts: string[] = [];
  if (agentNode.instructions) messageParts.push(agentNode.instructions);
  messageParts.push("\n\nTrigger payload:\n" + JSON.stringify(payload, null, 2));
  const userMessage = messageParts.join("\n");

  const events: any[] = [];
  if (agentNode.outcome) {
    events.push({
      type: "user.define_outcome",
      description: agentNode.outcome.description,
      rubric: { type: "text", content: agentNode.outcome.rubric_md },
      max_iterations: agentNode.outcome.max_iterations,
    });
  }
  events.push({ type: "user.message", content: [{ type: "text", text: userMessage }] });

  try {
    await AnthropicSessionEvents.send(session.id, events);
  } catch (err) {
    console.warn("kickoff events failed:", err);
  }
  await writeAudit({
    actor_id: workflow.created_by,
    action: "session.start",
    resource_type: "session",
    resource_id: localSession?.id ?? session.id,
    metadata: { workflow_id: workflow.id, trigger: triggerSummary },
  });
}
