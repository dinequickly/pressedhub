// /functions/v1/slack-events — Slack Events API webhook.
//
// Slack POSTs JSON to this endpoint for every subscribed event. The first
// payload after creating a Slack app is a `url_verification` challenge — we
// echo `challenge` back. After that, all `event_callback` payloads are
// authenticated with an HMAC-SHA256 signature in `x-slack-signature`.
//
// For now we route a single event type:
//   app_mention  → start an agent session with the message text. The
//                  vault_connection's metadata.default_agent_id picks which
//                  agent answers (set from the hub UI). Channel + thread_ts
//                  are stashed in trigger_payload so the agent can post a
//                  reply via the Slack MCP at runtime.
//
// Slack expects a 200 within ~3s; everything past the signature check is
// async so the response goes out fast.

import { wrap } from "../_shared/cors.ts";
import { ENV } from "../_shared/env.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { bootstrapSession } from "../_shared/session_bootstrap.ts";
import { ctxFromSession, pollAndRelay, relayOnce } from "../_shared/slack_relay.ts";
import { AnthropicSessionEvents } from "../_shared/anthropic.ts";

// Edge runtime exposes `EdgeRuntime.waitUntil` for keeping the worker alive
// after the Response is returned. Falls back to a no-op so types compile.
// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void } | undefined;

async function verifySlackSignature(req: Request, raw: string): Promise<boolean> {
  if (!ENV.SLACK_SIGNING_SECRET) return false;
  const ts = req.headers.get("x-slack-request-timestamp");
  const sig = req.headers.get("x-slack-signature");
  if (!ts || !sig) return false;
  // Reject anything older than 5 minutes — replay defense.
  if (Math.abs(Date.now() / 1000 - parseInt(ts)) > 300) return false;
  const base = `v0:${ts}:${raw}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(ENV.SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const macBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base)),
  );
  const expected = "v0=" + Array.from(macBytes)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  // Constant-time compare.
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

type SlackEnvelope = {
  type: string;
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event?: SlackEvent;
};

type SlackEvent = {
  type: string;
  text?: string;
  user?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
};

async function handleSlackEvent(env: SlackEnvelope) {
  const ev = env.event;
  if (!ev || !env.team_id) {
    console.warn(`[slack-events] skipping — missing event/team_id`);
    return;
  }

  const isMention = ev.type === "app_mention";
  const isDm = ev.type === "message" && ev.channel_type === "im";
  // A thread reply in a public/private channel only matters when we already
  // own the thread — otherwise it's chatter we should ignore.
  const isChannelThreadReply = ev.type === "message"
    && (ev.channel_type === "channel" || ev.channel_type === "group")
    && !!ev.thread_ts;
  if (!isMention && !isDm && !isChannelThreadReply) {
    console.log(`[slack-events] skipping — type=${ev.type} channel_type=${ev.channel_type}`);
    return;
  }
  if (ev.bot_id || ev.subtype === "bot_message") {
    console.log("[slack-events] skipping — bot_id/bot_message");
    return;
  }
  if (!ev.channel || !ev.text) {
    console.warn(`[slack-events] skipping — channel or text missing`);
    return;
  }

  const sc = serviceClient();
  const { data: conn, error: lookupErr } = await sc
    .from("vault_connections")
    .select("id,user_id,metadata")
    .eq("connector_id", "slack")
    .eq("metadata->>team_id", env.team_id)
    .maybeSingle();
  if (lookupErr) {
    console.error(`[slack-events] vault_connections lookup failed: ${lookupErr.message}`);
    return;
  }
  if (!conn) {
    console.warn(`[slack-events] no vault_connection for team_id=${env.team_id}`);
    return;
  }
  const meta = (conn.metadata as Record<string, unknown>) ?? {};
  const defaultAgentId = meta.default_agent_id as string | undefined;
  if (!defaultAgentId) {
    console.warn(`[slack-events] team ${env.team_id} has no default_agent_id`);
    return;
  }

  const cleaned = ev.text.replace(/^\s*<@[A-Z0-9]+>\s*/i, "").trim();
  if (!cleaned) {
    console.log("[slack-events] skipping — empty cleaned text");
    return;
  }

  // Thread key for continuation. For mentions Slack sets `thread_ts` only
  // when the user replies INSIDE a thread; the original mention itself
  // uses `ts` as the thread root. Either way, look for any session whose
  // payload's thread_ts matches `thread_ts` or `ts`.
  const threadCandidates = [ev.thread_ts, ev.ts].filter(Boolean) as string[];

  // Try thread continuation first — applies equally to a re-mention in a
  // thread the bot already owns and to a plain reply with no @-mention.
  // 24h cap so we don't resurrect a stale archived session.
  let continueOf: { id: string; anthropicId: string } | null = null;
  if (threadCandidates.length > 0) {
    const { data: existing } = await sc
      .from("sessions")
      .select("id,anthropic_id,trigger_payload,started_at,status")
      .eq("agent_id", defaultAgentId)
      .eq("trigger_summary", `slack:${env.team_id}:${ev.channel}`)
      .gt("started_at", new Date(Date.now() - 24 * 3600_000).toISOString())
      .order("started_at", { ascending: false })
      .limit(10);
    const match = (existing ?? []).find((s) => {
      const p = (s.trigger_payload as Record<string, unknown> | null) ?? {};
      const tt = p.thread_ts as string | null | undefined;
      return tt && threadCandidates.includes(tt);
    });
    if (match) continueOf = { id: match.id as string, anthropicId: match.anthropic_id as string };
  }

  if (continueOf) {
    console.log(`[slack-events] continuing session ${continueOf.id} (thread reply / re-mention)`);
    try {
      await AnthropicSessionEvents.send(continueOf.anthropicId, [{
        type: "user.message",
        content: [{ type: "text", text: `[Slack thread reply]\n${cleaned}` }],
      }]);
    } catch (err) {
      console.error(`[slack-events] events.send failed: ${(err as Error).message}`);
      return;
    }
    const job = pollAndRelay(sc, continueOf.id, { maxSeconds: 180, intervalMs: 4000 })
      .catch((err) => console.error(`[slack-events] poller threw: ${(err as Error).message}`));
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(job);
    }
    return;
  }

  // No active session in this thread.
  // - mention or DM → bootstrap a fresh one.
  // - channel thread reply with no owning session → ignore (require
  //   @-mention to start fresh).
  if (isChannelThreadReply) {
    console.log(`[slack-events] thread ${ev.thread_ts} has no active session — ignoring (re-mention to start)`);
    return;
  }

  console.log(`[slack-events] ${isDm ? "DM" : "mention"} → agent ${defaultAgentId}`);

  const replyThread = isMention ? (ev.thread_ts ?? ev.ts ?? null) : null;
  const session = await bootstrapSession(sc, {
    agentId: defaultAgentId,
    environmentId: null,
    startedBy: conn.user_id as string,
    title: isDm ? `Slack DM · ${ev.user ?? ""}` : `Slack mention · #${ev.channel}`,
    triggerSummary: `slack:${env.team_id}:${ev.channel}`,
    triggerPayload: {
      source: "slack",
      kind: isDm ? "dm" : "mention",
      team_id: env.team_id,
      channel: ev.channel,
      thread_ts: replyThread,
      user: ev.user ?? null,
      app_id: env.api_app_id ?? null,
      original_text: ev.text,
    },
    initialMessage: isDm
      ? `[Slack DM]\n${cleaned}`
      : `[Slack #${ev.channel} · thread ${ev.thread_ts ?? ev.ts}]\n${cleaned}`,
  });

  const job = pollAndRelay(sc, session.localId, { maxSeconds: 180, intervalMs: 4000 })
    .catch((err) => console.error(`[slack-events] poller threw: ${(err as Error).message}`));
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(job);
  }
}

// Service-role sweeper: pg_cron pings this every minute. Walks every recent
// Slack-originated session and runs relayOnce, which is idempotent. This is
// the durable backstop for the in-worker poller — if a worker dies mid-poll
// (deploys, restarts, idle timeout), the sweeper picks up the slack within
// 60s without any manual catch-up.
async function handleRelaySweep(): Promise<{ swept: number; posted: number }> {
  const sc = serviceClient();
  // Look at active sessions from the last 24h. Cheap — bounded by how
  // many threads someone @-mentions in. We could trim further by filtering
  // to those without a recent `pressed.slack_relayed` marker, but the
  // marker check is part of relayOnce anyway.
  const { data } = await sc
    .from("sessions")
    .select("id")
    .like("trigger_summary", "slack:%")
    .gt("started_at", new Date(Date.now() - 24 * 3600_000).toISOString())
    .limit(200);
  const sessions = (data ?? []) as Array<{ id: string }>;
  let posted = 0;
  for (const s of sessions) {
    try {
      const ctx = await ctxFromSession(sc, s.id);
      if (!ctx) continue;
      const r = await relayOnce(sc, ctx);
      posted += r.posted;
    } catch (err) {
      console.warn(`[slack-events/relay-sweep] ${s.id} failed: ${(err as Error).message}`);
    }
  }
  return { swept: sessions.length, posted };
}

Deno.serve(wrap(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  console.log(`[slack-events] ${req.method} ${path}`);

  // Cron-driven relay sweep. Service-role auth only; matches the path the
  // pg_cron job posts to (see migration 26).
  if (req.method === "POST" && path.endsWith("/relay-sweep")) {
    const auth = req.headers.get("Authorization");
    if (auth !== `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`) {
      return new Response("forbidden", { status: 403 });
    }
    const result = await handleRelaySweep();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const raw = await req.text();
  const ok = await verifySlackSignature(req, raw);
  if (!ok) {
    console.error(`[slack-events] signature verify FAILED — check SLACK_SIGNING_SECRET matches the value in api.slack.com/apps → Basic Information`);
    return new Response("invalid signature", { status: 401 });
  }
  let body: SlackEnvelope;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  console.log(`[slack-events] body.type=${body.type} event.type=${body.event?.type}`);

  if (body.type === "url_verification" && body.challenge) {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // If Slack is retrying (`x-slack-retry-num` header set), it means we
  // didn't get a 200 out fast enough on the first try. Once we move
  // bootstrapSession off the hot path this should rarely happen, but log
  // when it does so we can spot regressions. We still process the retry —
  // session-creation and event-send are not fully idempotent (we'd need a
  // dedupe table keyed by event_id for that), so a duplicate session is
  // possible if the original eventually succeeded. Best-effort.
  const retryNum = req.headers.get("x-slack-retry-num");
  const retryReason = req.headers.get("x-slack-retry-reason");
  if (retryNum) {
    console.warn(`[slack-events] Slack retry #${retryNum} (${retryReason}) — first ack was slow`);
  }

  if (body.type === "event_callback" && body.event) {
    // Ack Slack first (3-second SLA), do the work in a background job. If
    // EdgeRuntime.waitUntil isn't available we fall back to fire-and-
    // forget — the Promise still runs to completion as long as the worker
    // stays alive (it usually does for a few seconds after the response).
    const job = handleSlackEvent(body)
      .catch((e) =>
        console.error(`[slack-events] handler threw: ${(e as Error).message}\n${(e as Error).stack}`)
      );
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(job);
    }
  }
  return new Response("ok", { status: 200 });
}));
