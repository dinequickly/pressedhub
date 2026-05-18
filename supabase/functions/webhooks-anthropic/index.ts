// /functions/v1/webhooks-anthropic
// Public endpoint that receives Anthropic Managed Agents webhook events.
// Verifies the X-Webhook-Signature header against ANTHROPIC_WEBHOOK_SIGNING_KEY
// and updates session/vault rows accordingly. Also relays the agent's
// final messages back to Slack for sessions that originated from a Slack
// app_mention (trigger_summary starts with `slack:`).
//
// JWT verification is disabled for this function in supabase/config.toml.

import { wrap } from "../_shared/cors.ts";
import { ok } from "../_shared/errors.ts";
import { AnthropicSessions, AnthropicWebhooks } from "../_shared/anthropic.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { writeAudit } from "../_shared/audit.ts";
import { ctxFromSession, relayOnce } from "../_shared/slack_relay.ts";

Deno.serve(wrap(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const body = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));

  let event: { id: string; created_at: string; data: { type: string; id?: string } };
  try {
    event = AnthropicWebhooks.unwrap(body, headers);
  } catch (err) {
    return new Response(JSON.stringify({ error: "invalid_signature", message: String(err) }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sc = serviceClient();
  const t = event.data.type;
  const externalId = event.data.id;

  // Session lifecycle events: refresh the local sessions row from Anthropic
  // when the state changes, then relay any new agent messages back to Slack
  // when the session originated from an app_mention.
  if (t.startsWith("session.") && externalId) {
    try {
      const remote = await AnthropicSessions.retrieve(externalId);
      const { data: localRow } = await sc
        .from("sessions")
        .update({
          status: remote.status,
          outcome_evaluations: remote.outcome_evaluations ?? [],
          usage: remote.usage ?? {},
          finished_at: ["idle", "terminated"].includes(remote.status)
            ? new Date().toISOString()
            : null,
        })
        .eq("anthropic_id", externalId)
        .select("id,trigger_summary,trigger_payload")
        .single();

      if (localRow) {
        // Close any schedule_run linked to this session when it finishes.
        if (["idle", "terminated"].includes(remote.status)) {
          await sc
            .from("schedule_runs")
            .update({
              status: remote.status === "terminated" ? "failed" : "success",
              finished_at: new Date().toISOString(),
            })
            .eq("session_id", localRow.id as string)
            .in("status", ["running", "pending"]);
        }
        try {
          const ctx = await ctxFromSession(sc, localRow.id as string);
          if (ctx) await relayOnce(sc, ctx);
        } catch (err) {
          console.warn("[slack-relay] threw:", err);
        }
      }
    } catch (err) {
      console.warn("session refresh on webhook failed:", err);
    }
  }

  // Vault credential lifecycle events: mark connections as expired.
  if (t === "vault_credential.refresh_failed" && externalId) {
    await sc
      .from("vault_connections")
      .update({ status: "expired" })
      .eq("anthropic_credential_id", externalId);
  }

  await writeAudit({
    action: `anthropic_webhook.${t}`,
    resource_type: "webhook",
    resource_id: event.id,
    metadata: { external_id: externalId },
  });

  return ok({ received: true });
}));
