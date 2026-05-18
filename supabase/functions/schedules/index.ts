// /functions/v1/schedules — recurring agent triggers.
//
//   GET    /                List schedules visible to the caller.
//   GET    /:id             One.
//   POST   /                Create.
//   PATCH  /:id             Update (rename, change cron, pause, etc.)
//   DELETE /:id             Hard-delete (cascades schedule_runs).
//   GET    /:id/runs        Recent runs of a schedule.
//
//   POST   /tick            Service-role only. pg_cron fires this every
//                           minute. Picks due rows with FOR UPDATE SKIP
//                           LOCKED, starts a session per row, advances
//                           next_run_at via cron-parser.
//
// Sessions are created here directly (not by re-calling /sessions) to keep
// the worker self-contained — the cron job must not depend on user JWTs.

import { wrap } from "../_shared/cors.ts";
import { Router, readJson } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { BadRequest, NotFound, ok, Upstream } from "../_shared/errors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { ENV } from "../_shared/env.ts";
import { z } from "npm:zod@3.23.8";
import cronParser from "npm:cron-parser@4.9.0";
import { bootstrapSession } from "../_shared/session_bootstrap.ts";
import { writeAudit } from "../_shared/audit.ts";

const router = new Router("schedules");

const ScheduleCreateSchema = z.object({
  agent_id: z.string().uuid(),
  environment_id: z.string().uuid().optional(),
  name: z.string().min(1),
  cron: z.string().min(1),
  timezone: z.string().default("UTC"),
  trigger_message: z.string().optional(),
  trigger_payload: z.record(z.unknown()).optional(),
  status: z.enum(["active", "paused"]).default("active"),
  skip_if_running: z.boolean().default(true),
});

const ScheduleUpdateSchema = ScheduleCreateSchema.partial();

function nextFireFromCron(cron: string, tz: string, after?: Date): Date {
  const it = cronParser.parseExpression(cron, {
    tz,
    currentDate: after ?? new Date(),
  });
  return it.next().toDate();
}

function validateCron(cron: string, tz: string) {
  try {
    nextFireFromCron(cron, tz);
  } catch (e) {
    throw new BadRequest(`Invalid cron expression: ${(e as Error).message}`);
  }
}

// ---- User-facing CRUD --------------------------------------------------

router.get("/", async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agent_id");
  let q = user.db.from("agent_schedules").select("*").order("created_at", { ascending: false });
  if (agentId) q = q.eq("agent_id", agentId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ok({ data });
});

// Joined view powering /roster on the frontend. One row per schedule with
// agent display fields and the most-recent session's status flattened in.
// We also attach the latest agent.message text per session so the roster
// bubble can announce what the agent actually said instead of a static
// "Need input" placeholder.
router.get("/roster", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("agent_schedules")
    .select(`
      id,name,cron,timezone,status,next_run_at,last_run_at,last_session_id,
      trigger_message,
      agent:agents!inner(id,name,role,emoji,accent),
      last_session:sessions!last_session_id(id,status,title,started_at,finished_at,trigger_summary)
    `)
    .order("next_run_at", { ascending: true });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<Record<string, any>>;
  const sessionIds = rows
    .map((r) => r.last_session?.id as string | undefined)
    .filter((id): id is string => !!id);
  if (sessionIds.length > 0) {
    // Pull anything that could carry either spoken text OR a thinking
    // summary. `agent.message` / `agent.message_chunk` may contain mixed
    // content blocks ({type:"text"} and {type:"thinking"}); a discrete
    // thinking event type is also possible. One query, both signals.
    const { data: events } = await user.db
      .from("session_events")
      .select("session_id,event_type,payload,processed_at")
      .in("session_id", sessionIds)
      .or("event_type.like.agent.message%,event_type.ilike.%thinking%,event_type.eq.pressed.roster_status_set")
      .order("processed_at", { ascending: false });
    const latestMessage = new Map<string, string>();
    const latestThinking = new Map<string, string>();
    const latestRosterStatus = new Map<string, Record<string, unknown>>();
    for (const e of (events ?? []) as Array<Record<string, any>>) {
      const sid = e.session_id as string;
      const t = (e.event_type as string) ?? "";
      const p = e.payload ?? {};
      if (t === "pressed.roster_status_set") {
        if (
          !latestRosterStatus.has(sid) &&
          typeof p.summary === "string" &&
          typeof p.tone === "string"
        ) {
          latestRosterStatus.set(sid, {
            tone: p.tone,
            label: typeof p.label === "string" ? p.label : null,
            summary: p.summary,
            cta: typeof p.cta === "string" ? p.cta : null,
            file_name: typeof p.file_name === "string" ? p.file_name : null,
            updated_at: typeof p.updated_at === "string"
              ? p.updated_at
              : (e.processed_at as string | null),
          });
        }
        continue;
      }
      const blocks = Array.isArray(p.content) ? p.content : [];
      let text = "";
      let thinking = "";
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string") text += b.text;
        else if (b?.type === "thinking" && typeof b.thinking === "string") thinking += b.thinking;
      }
      // Discrete thinking event: payload may carry the string directly.
      if (!thinking && t.includes("thinking")) {
        if (typeof p.thinking === "string") thinking = p.thinking;
        else if (typeof p.text === "string") thinking = p.text;
      }
      text = text.trim();
      thinking = thinking.trim();
      if (text && !latestMessage.has(sid)) latestMessage.set(sid, text);
      if (thinking && !latestThinking.has(sid)) latestThinking.set(sid, thinking);
    }
    for (const row of rows) {
      const sid = row.last_session?.id as string | undefined;
      if (!sid || !row.last_session) continue;
      if (latestMessage.has(sid)) row.last_session.latest_message = latestMessage.get(sid);
      if (latestThinking.has(sid)) row.last_session.latest_thinking = latestThinking.get(sid);
      if (latestRosterStatus.has(sid)) row.last_session.roster_status = latestRosterStatus.get(sid);
    }
  }
  return ok({ data: rows });
});

router.get("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("agent_schedules").select("*").eq("id", params.id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Schedule not found");
  return ok(data);
});

router.get("/:id/runs", async (req, params) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20"), 100);
  const { data, error } = await user.db
    .from("schedule_runs")
    .select("*")
    .eq("schedule_id", params.id)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.post("/", async (req) => {
  const user = await requireUser(req);
  const parsed = ScheduleCreateSchema.parse(await readJson(req));
  validateCron(parsed.cron, parsed.timezone);

  const next = nextFireFromCron(parsed.cron, parsed.timezone);
  const { data, error } = await user.db
    .from("agent_schedules")
    .insert({
      agent_id: parsed.agent_id,
      environment_id: parsed.environment_id ?? null,
      name: parsed.name,
      cron: parsed.cron,
      timezone: parsed.timezone,
      trigger_message: parsed.trigger_message ?? null,
      trigger_payload: parsed.trigger_payload ?? {},
      status: parsed.status,
      skip_if_running: parsed.skip_if_running,
      next_run_at: next.toISOString(),
      created_by: user.id,
    })
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  await writeAudit({
    actor_id: user.id, action: "schedule.create",
    resource_type: "agent_schedule", resource_id: data.id,
  });
  return ok(data, 201);
});

router.patch("/:id", async (req, params) => {
  const user = await requireUser(req);
  const parsed = ScheduleUpdateSchema.parse(await readJson(req));
  const { data: existing } = await user.db
    .from("agent_schedules").select("*").eq("id", params.id).maybeSingle();
  if (!existing) throw new NotFound("Schedule not found");

  // Recompute next_run_at when cron/tz/status changed in a way that affects
  // when we should next fire. Pausing leaves next_run_at alone — when the
  // user resumes we recompute from "now".
  const patch: Record<string, unknown> = { ...parsed };
  const cron = parsed.cron ?? existing.cron;
  const tz = parsed.timezone ?? existing.timezone;
  if (parsed.cron || parsed.timezone) validateCron(cron, tz);
  const wasActive = existing.status === "active";
  const willBeActive = (parsed.status ?? existing.status) === "active";
  if ((parsed.cron || parsed.timezone) && willBeActive) {
    patch.next_run_at = nextFireFromCron(cron, tz).toISOString();
  }
  if (!wasActive && willBeActive) {
    patch.next_run_at = nextFireFromCron(cron, tz).toISOString();
  }

  const { data, error } = await user.db
    .from("agent_schedules").update(patch).eq("id", params.id).select().single();
  if (error) throw new BadRequest(error.message);
  await writeAudit({
    actor_id: user.id, action: "schedule.update",
    resource_type: "agent_schedule", resource_id: params.id,
  });
  return ok(data);
});

// Immediately start a session for this schedule. Uses the same session-start
// path as the tick so the roster and schedule_runs table update right away
// instead of waiting up to 60s for the next cron tick.
router.post("/:id/run", async (req, params) => {
  const user = await requireUser(req);
  const sc = serviceClient();
  const { data: row } = await user.db
    .from("agent_schedules").select("*").eq("id", params.id).maybeSingle();
  if (!row) throw new NotFound("Schedule not found");
  if (row.status !== "active") throw new BadRequest("Resume the schedule before running it");

  const scheduledFor = new Date().toISOString();
  const { data: runRow, error: runErr } = await sc
    .from("schedule_runs")
    .insert({ schedule_id: params.id, scheduled_for: scheduledFor, status: "pending" })
    .select().single();
  if (runErr) throw new BadRequest(`run insert: ${runErr.message}`);

  let session: { localId: string; anthropicId: string } | null = null;
  try {
    session = await startScheduledSession(sc, row, runRow.id as string);
  } catch (err) {
    await sc.from("schedule_runs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error: (err as Error).message.slice(0, 500),
    }).eq("id", runRow.id);
    throw err;
  }

  await sc.from("schedule_runs").update({
    status: "running", session_id: session.localId,
  }).eq("id", runRow.id);
  const now = new Date().toISOString();
  const { data: updated } = await sc
    .from("agent_schedules")
    .update({ last_run_at: now, last_session_id: session.localId })
    .eq("id", params.id).select().single();
  await advanceNext(sc, row);

  await writeAudit({
    actor_id: user.id, action: "schedule.run_now",
    resource_type: "agent_schedule", resource_id: params.id,
  });
  return ok({ schedule: updated, run: runRow, session: { id: session.localId, anthropic_id: session.anthropicId } }, 201);
});

router.delete("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { error } = await user.db.from("agent_schedules").delete().eq("id", params.id);
  if (error) throw new BadRequest(error.message);
  await writeAudit({
    actor_id: user.id, action: "schedule.delete",
    resource_type: "agent_schedule", resource_id: params.id,
  });
  return new Response(null, { status: 204 });
});

// ---- Worker tick -------------------------------------------------------

// Service-role auth. pg_cron fires this every minute.
function isServiceCaller(req: Request): boolean {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice("Bearer ".length) === ENV.SUPABASE_SERVICE_ROLE_KEY;
}

router.post("/tick", async (req) => {
  if (!isServiceCaller(req)) throw new Upstream("Service role required for /schedules/tick");
  const sc = serviceClient();

  // Claim up to 50 due schedules atomically. SKIP LOCKED lets multiple
  // workers run in parallel without stepping on each other.
  const { data: due, error: dueErr } = await sc.rpc("claim_due_schedules", { p_limit: 50 });
  if (dueErr) throw new Error(`claim_due_schedules failed: ${dueErr.message}`);
  const claimed = (due as Array<Record<string, unknown>>) ?? [];

  let started = 0, skipped = 0, failed = 0;
  for (const row of claimed) {
    const id = row.id as string;
    const scheduledFor = row.next_run_at as string;
    try {
      const { data: runRow, error: runErr } = await sc
        .from("schedule_runs")
        .insert({
          schedule_id: id,
          scheduled_for: scheduledFor,
          status: "pending",
        })
        .select()
        .single();
      if (runErr) throw new Error(`run insert: ${runErr.message}`);

      // skip_if_running guard. We only consider sessions started by THIS
      // schedule (matched via trigger_summary = 'schedule:<id>') so a user's
      // ad-hoc chats with the same agent — which sit in `idle` state forever
      // until archived — don't poison the queue. Also exclude `idle`: in
      // Anthropic's lifecycle that just means "session waiting for input",
      // not "still working" — only `running`/`rescheduling` count as busy.
      if (row.skip_if_running) {
        const { data: live } = await sc
          .from("sessions")
          .select("id,status")
          .eq("agent_id", row.agent_id)
          .eq("trigger_summary", `schedule:${id}`)
          .in("status", ["running", "rescheduling"])
          .limit(1);
        if ((live ?? []).length > 0) {
          await sc.from("schedule_runs").update({
            status: "skipped",
            finished_at: new Date().toISOString(),
            error: "previous run still in progress",
          }).eq("id", runRow.id);
          await advanceNext(sc, row);
          skipped++;
          continue;
        }
      }

      const session = await startScheduledSession(sc, row, runRow.id as string);
      started++;
      await sc.from("schedule_runs").update({
        status: "running", session_id: session.localId,
      }).eq("id", runRow.id);
      await sc.from("agent_schedules").update({
        last_run_at: new Date().toISOString(),
        last_session_id: session.localId,
      }).eq("id", id);
      await advanceNext(sc, row);
    } catch (err) {
      failed++;
      await sc.from("schedule_runs").insert({
        schedule_id: id,
        scheduled_for: scheduledFor,
        status: "failed",
        finished_at: new Date().toISOString(),
        error: (err as Error).message.slice(0, 500),
      });
      // Always advance — a stuck cron is worse than a missed run.
      await advanceNext(sc, row).catch(() => { /* ignore */ });
    }
  }
  return ok({ claimed: claimed.length, started, skipped, failed });
});

async function advanceNext(sc: ReturnType<typeof serviceClient>, row: Record<string, unknown>) {
  const next = nextFireFromCron(row.cron as string, row.timezone as string);
  await sc.from("agent_schedules").update({
    next_run_at: next.toISOString(),
  }).eq("id", row.id as string);
}

function buildScheduledMessage(row: Record<string, unknown>): string {
  const now = new Date().toUTCString();
  const header = `[Scheduled run: "${row.name}" · ${now}]\nThis is an automated scheduled task — no human is watching. Work autonomously to completion. When done, call set_roster_status to report your outcome so the roster card updates.`;
  const userMessage = (row.trigger_message as string | null)?.trim();
  return userMessage ? `${header}\n\n${userMessage}` : header;
}

async function startScheduledSession(
  sc: ReturnType<typeof serviceClient>,
  row: Record<string, unknown>,
  _scheduleRunId: string,
): Promise<{ localId: string; anthropicId: string }> {
  return await bootstrapSession(sc, {
    agentId: row.agent_id as string,
    environmentId: (row.environment_id as string | null) ?? null,
    startedBy: row.created_by as string,
    title: `${row.name} · scheduled`,
    triggerSummary: `schedule:${row.id}`,
    triggerPayload: (row.trigger_payload as Record<string, unknown>) ?? undefined,
    initialMessage: buildScheduledMessage(row),
  });
}

Deno.serve(wrap((req) => router.handle(req)));
