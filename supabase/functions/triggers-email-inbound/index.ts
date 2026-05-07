// /functions/v1/triggers-email-inbound
// Public endpoint that accepts inbound-email webhooks (Postmark / SendGrid
// shape: { from, to, subject, text, html, attachments? }). Routes the message
// to the trigger whose config.local_part matches the local part of the
// recipient address, then kicks off a session like the webhook trigger.

import { wrap } from "../_shared/cors.ts";
import { ok } from "../_shared/errors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { AnthropicSessions, AnthropicSessionEvents } from "../_shared/anthropic.ts";

Deno.serve(wrap(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const payload = await req.json().catch(() => ({}));
  const to: string | undefined = (payload as any).To ?? (payload as any).to;
  if (!to) return ok({ accepted: false, reason: "Missing recipient" });
  const localPart = to.split("@")[0]?.toLowerCase();
  if (!localPart) return ok({ accepted: false, reason: "Invalid recipient" });

  const sc = serviceClient();
  const { data: trigger } = await sc
    .from("workflow_triggers")
    .select("*, workflows!inner(*)")
    .eq("kind", "email_inbound")
    .eq("config->>local_part", localPart)
    .maybeSingle();
  if (!trigger || !trigger.enabled) return ok({ accepted: false, reason: "No matching trigger" });

  const workflow = trigger.workflows as any;
  if (!workflow.enabled) return ok({ accepted: false, reason: "Workflow disabled" });

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
  if (!agent?.anthropic_id || !environment?.anthropic_id) {
    return ok({ accepted: false, reason: "No agent/environment for workflow owner" });
  }
  const subject = (payload as any).Subject ?? (payload as any).subject ?? "(no subject)";
  const session = await AnthropicSessions.create({
    agent: agent.anthropic_id,
    environment_id: environment.anthropic_id,
    title: `Email: ${subject}`,
  });
  await sc.from("sessions").insert({
    anthropic_id: session.id,
    workflow_id: workflow.id,
    agent_id: agent.id,
    environment_id: environment.id,
    title: `Email: ${subject}`,
    status: "idle",
    trigger_summary: `email from ${(payload as any).From ?? (payload as any).from ?? "unknown"}`,
    trigger_payload: payload as Record<string, unknown>,
    started_by: workflow.created_by,
  });
  const text = (payload as any).TextBody ?? (payload as any).text ?? "";
  await AnthropicSessionEvents.send(session.id, [{
    type: "user.message",
    content: [{
      type: "text",
      text: `Inbound email\nFrom: ${(payload as any).From ?? (payload as any).from}\nSubject: ${subject}\n\n${text}`,
    }],
  }]);
  return ok({ accepted: true });
}));
