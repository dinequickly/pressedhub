// Shared helper: post any new agent.message events from an Anthropic
// session back to the originating Slack thread. Idempotent — a
// `pressed.slack_relayed` row in session_events records each posted
// message keyed by the Anthropic event id, so re-running the relay
// (from a poller, a webhook, or both at once) never double-posts.

import { AnthropicSessionEvents } from "./anthropic.ts";
import type { SupabaseClient } from "./supabase.ts";

export type RelayContext = {
  localSessionId: string;
  anthropicSessionId: string;
  channel: string;
  threadTs: string | null;
  botToken: string;
};

export async function ctxFromSession(
  sc: SupabaseClient,
  localSessionId: string,
): Promise<RelayContext | null> {
  const { data: session } = await sc
    .from("sessions")
    .select("id,anthropic_id,trigger_summary,trigger_payload")
    .eq("id", localSessionId)
    .maybeSingle();
  if (!session?.anthropic_id) return null;
  const ts = (session.trigger_summary as string | null) ?? "";
  if (!ts.startsWith("slack:")) return null;
  const payload = (session.trigger_payload as Record<string, unknown> | null) ?? null;
  const channel = payload?.channel as string | undefined;
  const teamId = payload?.team_id as string | undefined;
  if (!channel || !teamId) return null;

  const { data: conn } = await sc
    .from("vault_connections")
    .select("metadata")
    .eq("connector_id", "slack")
    .eq("metadata->>team_id", teamId)
    .maybeSingle();
  const botToken = (conn?.metadata as Record<string, unknown> | undefined)?.bot_token as
    | string
    | undefined;
  if (!botToken) return null;

  return {
    localSessionId,
    anthropicSessionId: session.anthropic_id as string,
    channel,
    threadTs: (payload?.thread_ts as string | null | undefined) ?? null,
    botToken,
  };
}

export async function relayOnce(
  sc: SupabaseClient,
  ctx: RelayContext,
): Promise<{ posted: number; sessionStatus: string | null }> {
  const { data: relayedRows } = await sc
    .from("session_events")
    .select("payload")
    .eq("session_id", ctx.localSessionId)
    .eq("event_type", "pressed.slack_relayed");
  // deno-lint-ignore no-explicit-any
  const relayed = new Set(
    (relayedRows ?? [])
      // deno-lint-ignore no-explicit-any
      .map((r: any) => r.payload?.anthropic_event_id as string | undefined)
      .filter((s): s is string => !!s),
  );

  let events: Array<Record<string, unknown>> = [];
  let sessionStatus: string | null = null;
  try {
    const res = await AnthropicSessionEvents.list(ctx.anthropicSessionId);
    events = (res.data as Array<Record<string, unknown>>) ?? [];
    // The session.status_* events tell us when the agent is done. The
    // poller stops once we see `_idle` or `_terminated`.
    for (const e of events) {
      const t = (e.type as string) ?? "";
      if (t.startsWith("session.status_")) sessionStatus = t.replace("session.status_", "");
    }
  } catch (err) {
    console.warn("[slack-relay] events.list failed:", err);
    return { posted: 0, sessionStatus };
  }

  let posted = 0;
  for (const e of events) {
    const id = e.id as string | undefined;
    const type = (e.type as string) ?? "";
    if (!id || relayed.has(id)) continue;
    if (type !== "agent.message") continue;

    const blocks = (e.content as Array<Record<string, unknown>>) ?? [];
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("")
      .trim();
    if (!text) continue;

    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${ctx.botToken}`,
      },
      body: JSON.stringify({ channel: ctx.channel, text, thread_ts: ctx.threadTs }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!json.ok) {
      console.warn(`[slack-relay] chat.postMessage failed: ${json.error ?? resp.status}`);
      continue;
    }
    await sc.from("session_events").insert({
      session_id: ctx.localSessionId,
      event_type: "pressed.slack_relayed",
      payload: { anthropic_event_id: id, slack_ts: json.ts, channel: ctx.channel },
      processed_at: new Date().toISOString(),
    });
    posted++;
    console.log(`[slack-relay] posted to ${ctx.channel} (slack ts=${json.ts})`);
  }
  return { posted, sessionStatus };
}

// Poll the session until the agent goes idle/terminated, posting any new
// messages each tick. Bounded so a stuck session can't run forever; the
// Anthropic webhook (if configured) covers the case where the agent
// finishes after our deadline.
export async function pollAndRelay(
  sc: SupabaseClient,
  localSessionId: string,
  opts?: { maxSeconds?: number; intervalMs?: number },
): Promise<void> {
  const deadline = Date.now() + (opts?.maxSeconds ?? 120) * 1000;
  const interval = opts?.intervalMs ?? 4000;
  while (Date.now() < deadline) {
    const ctx = await ctxFromSession(sc, localSessionId);
    if (!ctx) return;
    const { sessionStatus } = await relayOnce(sc, ctx);
    if (sessionStatus === "idle" || sessionStatus === "terminated") {
      // Final pass after status flipped, in case the agent.message arrived
      // in the same window as the status event.
      await new Promise((r) => setTimeout(r, 1500));
      await relayOnce(sc, ctx);
      return;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
