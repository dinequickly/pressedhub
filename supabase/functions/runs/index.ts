// /functions/v1/runs
//   GET /              List runs.
//   GET /:id           Get one run with events. On read, we *pull* the canonical
//                      event list from Anthropic and upsert it locally so the UI
//                      always sees the latest state without needing the SSE
//                      stream proxy to have been attached.

import { wrap } from "../_shared/cors.ts";
import { Router } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { NotFound, ok } from "../_shared/errors.ts";
import {
  AnthropicFiles,
  AnthropicSessionEvents,
  AnthropicSessions,
} from "../_shared/anthropic.ts";
import {
  dispatchKbTool,
  extractKbToolUses,
  postToolResult,
} from "../_shared/kb_tools.ts";
import {
  dispatchRosterStatusTool,
  extractRosterStatusToolUses,
  postRosterStatusToolResult,
} from "../_shared/roster_status_tools.ts";
import {
  dispatchImageTool,
  extractImageToolUses,
  postImageToolResult,
} from "../_shared/image_tools.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { ENV } from "../_shared/env.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const router = new Router("runs");

router.get("/", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("sessions")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data: session, error } = await user.db.from("sessions").select("*").eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!session) throw new NotFound("Run not found");

  // Fast path: read local DB and return immediately. The expensive Anthropic
  // round-trips (session.retrieve, events.list, files.list) plus the kb tool
  // drain all run in the background via EdgeRuntime.waitUntil. The frontend
  // polls every few seconds, so the next poll will see the fresh state. This
  // is the difference between a 2–6 s response (3 Anthropic calls inline) and
  // a ~100 ms one.
  // Mutable so we can refresh after an inline tool drain (see below).
  let events: Array<Record<string, unknown>> | null = null;
  {
    const { data } = await user.db
      .from("session_events")
      .select("*")
      .eq("session_id", params.id)
      .order("created_at");
    events = data as Array<Record<string, unknown>> | null;
  }

  // Refresh + tool drain. On cloud Supabase, EdgeRuntime.waitUntil keeps
  // the worker alive after the response is sent so this can run async. In
  // supabase-local that API is missing — and the floating promise gets
  // dropped between requests, leaving the agent stuck at its first
  // read_board (campaign harness caught this). Fall back to inline-await
  // so tool dispatch fires reliably in dev. Tradeoff: poll latency goes up
  // by the dispatch time, but the agent actually progresses.
  const anthropicId = session.anthropic_id as string | null;
  const isFinal = session.status === "terminated";
  if (anthropicId && ENV.ANTHROPIC_API_KEY && !isFinal) {
    const work = async () => {
      try { await refreshFromAnthropic(session.id, anthropicId); }
      catch (err) { console.warn("[runs] refreshFromAnthropic failed:", err); }
      try { await drainKbToolCalls(user.db, user.id, session.id, anthropicId); }
      catch (err) { console.warn("[runs] drainKbToolCalls failed:", err); }
      try { await drainRosterStatusToolCalls(user.db, session.id, anthropicId); }
      catch (err) { console.warn("[runs] drainRosterStatusToolCalls failed:", err); }
      try { await drainImageToolCalls(user.db, user.id, session.id, anthropicId); }
      catch (err) { console.warn("[runs] drainImageToolCalls failed:", err); }
    };
    if (hasWaitUntil()) {
      runInBackground(work);
    } else {
      // Inline path — cap with a generous timeout so a stuck Anthropic
      // call can't hang the whole /runs/:id response indefinitely.
      try { await withTimeout(work(), 25_000); }
      catch (err) { console.warn("[runs] inline drain failed/timeout:", (err as Error).message); }
      // After inline drain, re-pull events so the response reflects the
      // latest state (the events query above ran before dispatch).
      const { data: refreshed } = await user.db
        .from("session_events")
        .select("*")
        .eq("session_id", params.id)
        .order("created_at");
      if (refreshed) events = refreshed as Array<Record<string, unknown>>;
    }
  }

  // Outputs: small TTL cache so the 8s frontend poll doesn't round-trip
  // Anthropic Files.list every time. A 4s TTL is short enough that newly
  // generated files appear within ~one poll cycle of when they land,
  // long enough to fully amortize when nothing's changing.
  let outputs: OutputDescriptor[] = [];
  if (anthropicId && ENV.ANTHROPIC_API_KEY) {
    outputs = await getOutputsCached(anthropicId);
  }

  return ok({ session, events: events ?? [], outputs });
});

// Defer work past the response. EdgeRuntime.waitUntil keeps the worker alive
// after the response is sent; if it's missing (e.g. local dev with a stripped
// runtime) we fall back to a floating promise that swallows errors so an
// unhandled rejection can't take down the worker.
function runInBackground(fn: () => Promise<void>): void {
  const promise = fn().catch((err) => {
    console.warn("[runs] background task error:", err);
  });
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(promise);
}

function hasWaitUntil(): boolean {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  return !!(rt && typeof rt.waitUntil === "function");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(id); resolve(v); }, (e) => { clearTimeout(id); reject(e); });
  });
}

type OutputDescriptor = {
  file_id: string;
  name: string | null;
  mime: string | null;
  size: number | null;
};

// Per-process TTL cache keyed by anthropic session id. Avoids hammering
// Anthropic's Files API on every poll. 4 seconds: newly generated images
// appear within a poll cycle (~8s) of landing, never older than that.
const OUTPUTS_TTL_MS = 4000;
const outputsCache = new Map<string, { at: number; outputs: OutputDescriptor[] }>();

async function getOutputsCached(anthropicId: string): Promise<OutputDescriptor[]> {
  const hit = outputsCache.get(anthropicId);
  if (hit && Date.now() - hit.at < OUTPUTS_TTL_MS) return hit.outputs;
  try {
    const list = await withTimeout(AnthropicFiles.list({ scope_id: anthropicId }), 1500);
    const outputs: OutputDescriptor[] = (list.data ?? []).map((f) => ({
      file_id: f.id,
      name: (f.filename as string) ?? null,
      mime: (f.mime_type as string) ?? null,
      size: typeof f.size_bytes === "number" ? f.size_bytes : null,
    }));
    outputsCache.set(anthropicId, { at: Date.now(), outputs });
    return outputs;
  } catch (err) {
    console.warn("[runs] AnthropicFiles.list failed/timeout:", (err as Error).message);
    // Return stale cache rather than nothing — better UX than a blank panel.
    return hit?.outputs ?? [];
  }
}

// Pull the canonical session + events from Anthropic, merge into the local
// tables. Idempotent thanks to the (session_id, anthropic_event_id) unique
// index on session_events.
async function refreshFromAnthropic(localId: string, anthropicId: string): Promise<void> {
  const sc = serviceClient();
  const [sessionRes, eventsRes] = await Promise.all([
    AnthropicSessions.retrieve(anthropicId),
    AnthropicSessionEvents.list(anthropicId),
  ]);

  await sc.from("sessions")
    .update({
      status: sessionRes.status,
      outcome_evaluations: sessionRes.outcome_evaluations ?? [],
      usage: sessionRes.usage ?? {},
      finished_at: ["idle", "terminated"].includes(sessionRes.status)
        ? new Date().toISOString()
        : null,
    })
    .eq("id", localId);

  const events = (eventsRes.data ?? []) as Array<Record<string, unknown>>;
  if (events.length === 0) return;
  // Anthropic is source of truth. Skip events we already persisted (matched
  // by anthropic_event_id) and insert the rest. Postgrest's `upsert` with a
  // partial-unique-index onConflict is finicky, so we do an existence check
  // then a plain insert.
  const ids = events.map((e) => e.id as string).filter(Boolean);
  const { data: existing } = await sc
    .from("session_events")
    .select("anthropic_event_id")
    .eq("session_id", localId)
    .in("anthropic_event_id", ids);
  const seen = new Set((existing ?? []).map((r: any) => r.anthropic_event_id));
  const fresh = events.filter((e) => !seen.has(e.id));
  if (fresh.length === 0) return;
  const rows = fresh.map((e) => ({
    session_id: localId,
    anthropic_event_id: (e.id as string) ?? null,
    event_type: (e.type as string) ?? "unknown",
    payload: e,
    processed_at: (e.processed_at as string) ?? new Date().toISOString(),
  }));
  const { error: insErr } = await sc.from("session_events").insert(rows);
  if (insErr) console.warn("[runs] event insert failed:", insErr);
}

// Look at every persisted event for this session, find kb_* tool_use blocks
// that don't yet have a matching user.custom_tool_result, and dispatch them.
// The /runs/:id poll is where this fires, so the agent can call kb tools even
// when the SSE stream isn't attached.
//
// Critical perf detail: dispatch is fire-and-forget. kb_attach can take a
// while (up to a 305 MB lazy upload to Anthropic Files), and we'd otherwise
// block every /runs/:id poll for the full upload duration. We persist a
// `pressed.kb_dispatch_started` marker so subsequent polls don't kick off a
// duplicate dispatch for the same tool_use_id, and use EdgeRuntime.waitUntil
// (when available) to keep the worker alive after the response is sent.
async function drainKbToolCalls(
  userDb: SupabaseClient,
  userId: string,
  localSessionId: string,
  anthropicSessionId: string,
): Promise<void> {
  const { data: events } = await userDb
    .from("session_events")
    .select("event_type,payload")
    .eq("session_id", localSessionId);
  if (!events?.length) return;

  // Re-fetch with created_at so we can age out stale dispatch markers. If a
  // background dispatch died (e.g. waitUntil killed mid-upload), we want the
  // next poll to retry rather than block forever.
  const { data: eventsWithTime } = await userDb
    .from("session_events")
    .select("event_type,payload,created_at")
    .eq("session_id", localSessionId);
  const STALE_MS = 30 * 1000;
  const now = Date.now();

  const answered = new Set<string>(); // tool_use_ids already responded to
  const inFlight = new Set<string>(); // tool_use_ids with a fresh start marker
  for (const e of eventsWithTime ?? []) {
    const p = e.payload as Record<string, unknown> | null;
    if (!p) continue;
    if (p.type === "user.custom_tool_result" && typeof p.custom_tool_use_id === "string") {
      answered.add(p.custom_tool_use_id);
    }
    if (e.event_type === "pressed.kb_dispatch_started" && typeof p.tool_use_id === "string") {
      const createdAt = e.created_at ? new Date(e.created_at as string).getTime() : 0;
      if (now - createdAt < STALE_MS) {
        inFlight.add(p.tool_use_id);
      }
    }
  }

  const pending: ReturnType<typeof extractKbToolUses> = [];
  const seenIds = new Set<string>();
  for (const e of events) {
    for (const ref of extractKbToolUses(e.payload)) {
      if (answered.has(ref.tool_use_id)) continue;
      if (inFlight.has(ref.tool_use_id)) continue;
      if (seenIds.has(ref.tool_use_id)) continue;
      seenIds.add(ref.tool_use_id);
      pending.push(ref);
    }
  }
  if (pending.length === 0) return;

  // Run all tools inline. kb_list/kb_search are sub-second DB queries.
  // kb_attach can do a file upload but the 100 MB size guard inside the tool
  // keeps wall-clock comfortably under the 150s function timeout, and inline
  // dispatch is the only way to be reliable in a dev setup where the file
  // watcher kills the worker every few seconds. Markers are still inserted
  // so concurrent polls don't double-fire mid-flight.
  const sc = serviceClient();
  await sc.from("session_events").insert(
    pending.map((ref) => ({
      session_id: localSessionId,
      event_type: "pressed.kb_dispatch_started",
      payload: { tool_use_id: ref.tool_use_id, name: ref.name },
      processed_at: new Date().toISOString(),
    })),
  );

  await Promise.all(pending.map(async (ref) => {
    try {
      const text = await dispatchKbTool(ref, {
        userDb,
        userId,
        anthropicSessionId,
      });
      await postToolResult(anthropicSessionId, ref.tool_use_id, text);
    } catch (err) {
      console.warn(`[runs] dispatch ${ref.name} failed:`, err);
      try {
        await postToolResult(
          anthropicSessionId,
          ref.tool_use_id,
          `[ERROR] ${(err as Error).message}`,
        );
      } catch (_) { /* ignore */ }
    }
  }));
}

// Image-tool drain. Same shape as drainKbToolCalls but for the Image Studio
// Director's tools (read_board, update_board, generate_image_*, list_media,
// attach_media_as_reference, prompt_via_card). Lets the agent's tool calls
// resolve from the /runs/:id poll path, so the SSE stream doesn't have to
// pin a worker for the full duration of a multi-second image generation.
async function drainImageToolCalls(
  userDb: SupabaseClient,
  userId: string,
  localSessionId: string,
  anthropicSessionId: string,
): Promise<void> {
  const { data: events } = await userDb
    .from("session_events")
    .select("event_type,payload")
    .eq("session_id", localSessionId);
  if (!events?.length) return;

  const { data: eventsWithTime } = await userDb
    .from("session_events")
    .select("event_type,payload,created_at")
    .eq("session_id", localSessionId);
  // Image gen calls can take 30s+ so the in-flight window is longer than
  // kb_tools' 30s. A stuck dispatch retries after 2 minutes.
  const STALE_MS = 2 * 60 * 1000;
  const now = Date.now();

  const answered = new Set<string>();
  const inFlight = new Set<string>();
  for (const e of eventsWithTime ?? []) {
    const p = e.payload as Record<string, unknown> | null;
    if (!p) continue;
    if (p.type === "user.custom_tool_result" && typeof p.custom_tool_use_id === "string") {
      answered.add(p.custom_tool_use_id);
    }
    if (e.event_type === "pressed.image_dispatch_started" && typeof p.tool_use_id === "string") {
      const createdAt = e.created_at ? new Date(e.created_at as string).getTime() : 0;
      if (now - createdAt < STALE_MS) inFlight.add(p.tool_use_id);
    }
  }

  const pending: ReturnType<typeof extractImageToolUses> = [];
  const seenIds = new Set<string>();
  for (const e of events) {
    for (const ref of extractImageToolUses(e.payload)) {
      if (answered.has(ref.tool_use_id)) continue;
      if (inFlight.has(ref.tool_use_id)) continue;
      if (seenIds.has(ref.tool_use_id)) continue;
      seenIds.add(ref.tool_use_id);
      pending.push(ref);
    }
  }
  if (pending.length === 0) return;

  const sc = serviceClient();
  await sc.from("session_events").insert(
    pending.map((ref) => ({
      session_id: localSessionId,
      event_type: "pressed.image_dispatch_started",
      payload: { tool_use_id: ref.tool_use_id, name: ref.name },
      processed_at: new Date().toISOString(),
    })),
  );

  await Promise.all(pending.map(async (ref) => {
    try {
      const result = await dispatchImageTool(ref, {
        userDb,
        userId,
        anthropicSessionId,
      });
      await postImageToolResult(anthropicSessionId, ref.tool_use_id, result);
    } catch (err) {
      console.warn(`[runs] image dispatch ${ref.name} failed:`, err);
      try {
        await postImageToolResult(
          anthropicSessionId,
          ref.tool_use_id,
          `[ERROR] ${(err as Error).message}`,
        );
      } catch (_) { /* ignore */ }
    }
  }));
}

// Roster-status tool drain. Lets any agent explicitly author the note shown on
// /roster instead of relying on us to infer intent from freeform chat text.
async function drainRosterStatusToolCalls(
  userDb: SupabaseClient,
  localSessionId: string,
  anthropicSessionId: string,
): Promise<void> {
  const { data: events } = await userDb
    .from("session_events")
    .select("event_type,payload,created_at")
    .eq("session_id", localSessionId);
  if (!events?.length) return;

  const STALE_MS = 30 * 1000;
  const now = Date.now();
  const answered = new Set<string>();
  const inFlight = new Set<string>();
  for (const e of events) {
    const p = e.payload as Record<string, unknown> | null;
    if (!p) continue;
    if (p.type === "user.custom_tool_result" && typeof p.custom_tool_use_id === "string") {
      answered.add(p.custom_tool_use_id);
    }
    if (e.event_type === "pressed.roster_status_dispatch_started" && typeof p.tool_use_id === "string") {
      const createdAt = e.created_at ? new Date(e.created_at as string).getTime() : 0;
      if (now - createdAt < STALE_MS) inFlight.add(p.tool_use_id);
    }
  }

  const pending: ReturnType<typeof extractRosterStatusToolUses> = [];
  const seenIds = new Set<string>();
  for (const e of events) {
    for (const ref of extractRosterStatusToolUses(e.payload)) {
      if (answered.has(ref.tool_use_id)) continue;
      if (inFlight.has(ref.tool_use_id)) continue;
      if (seenIds.has(ref.tool_use_id)) continue;
      seenIds.add(ref.tool_use_id);
      pending.push(ref);
    }
  }
  if (pending.length === 0) return;

  const sc = serviceClient();
  await sc.from("session_events").insert(
    pending.map((ref) => ({
      session_id: localSessionId,
      event_type: "pressed.roster_status_dispatch_started",
      payload: { tool_use_id: ref.tool_use_id, name: ref.name },
      processed_at: new Date().toISOString(),
    })),
  );

  await Promise.all(pending.map(async (ref) => {
    try {
      const text = await dispatchRosterStatusTool(ref, {
        userDb,
        localSessionId,
      });
      await postRosterStatusToolResult(anthropicSessionId, ref.tool_use_id, text);
    } catch (err) {
      console.warn(`[runs] dispatch ${ref.name} failed:`, err);
      try {
        await postRosterStatusToolResult(
          anthropicSessionId,
          ref.tool_use_id,
          `[ERROR] ${(err as Error).message}`,
        );
      } catch (_) { /* ignore */ }
    }
  }));
}

Deno.serve(wrap((req) => router.handle(req)));
