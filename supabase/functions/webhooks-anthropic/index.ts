// /functions/v1/webhooks-anthropic
// Public endpoint that receives Anthropic Managed Agents webhook events.
// Verifies the X-Webhook-Signature header against ANTHROPIC_WEBHOOK_SIGNING_KEY
// and updates session/vault rows accordingly.
//
// JWT verification is disabled for this function in supabase/config.toml.

import { wrap } from "../_shared/cors.ts";
import { ok } from "../_shared/errors.ts";
import { AnthropicSessions, AnthropicWebhooks } from "../_shared/anthropic.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { writeAudit } from "../_shared/audit.ts";

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
  // when the state changes.
  if (t.startsWith("session.") && externalId) {
    try {
      const session = await AnthropicSessions.retrieve(externalId);
      await sc
        .from("sessions")
        .update({
          status: session.status,
          outcome_evaluations: session.outcome_evaluations ?? [],
          usage: session.usage ?? {},
          finished_at: ["idle", "terminated"].includes(session.status)
            ? new Date().toISOString()
            : null,
        })
        .eq("anthropic_id", externalId);
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
