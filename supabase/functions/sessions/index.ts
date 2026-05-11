// /functions/v1/sessions
//   POST   /                       Start a session: create on Anthropic, persist row,
//                                  send the optional initial message and/or outcome.
//   GET    /                       List sessions visible to the caller.
//   GET    /:id                    Get a session by local id.
//   POST   /:id/events             Forward user events to Anthropic + log them.
//   POST   /:id/interrupt          Convenience: send a user.interrupt event.
//   GET    /:id/stream             SSE proxy of the Anthropic event stream;
//                                  every event is also persisted to session_events.
//   POST   /:id/archive            Archive both Anthropic and the local row.
//   DELETE /:id                    Hard delete on both ends.

import { wrap } from "../_shared/cors.ts";
import { Router, readJson } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { BadRequest, NotFound, noContent, ok, Upstream } from "../_shared/errors.ts";
import { SessionSendEventSchema, SessionStartSchema } from "../_shared/schemas.ts";
import {
  AnthropicFiles,
  AnthropicSessionEvents,
  AnthropicSessions,
  type SessionResource,
  type UserEvent,
} from "../_shared/anthropic.ts";
// Tool dispatch lives in /runs/:id (poll path) so a long generation doesn't
// pin the SSE stream's worker. The stream here just forwards + persists.
import { ENV } from "../_shared/env.ts";
import { writeAudit } from "../_shared/audit.ts";
import { serviceClient } from "../_shared/supabase.ts";

const router = new Router("sessions");

router.get("/", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("sessions")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("sessions").select("*").eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Session not found");
  return ok(data);
});

router.post("/", async (req) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const parsed = SessionStartSchema.parse(body);

  // Resolve the Anthropic ids for the agent + environment.
  const { data: agent } = await user.db.from("agents")
    .select("anthropic_id,default_resources").eq("id", parsed.agent_id).maybeSingle();
  if (!agent?.anthropic_id) throw new BadRequest("Agent has no anthropic_id");
  const { data: environment } = await user.db.from("environments").select("anthropic_id").eq(
    "id",
    parsed.environment_id,
  ).maybeSingle();
  if (!environment?.anthropic_id) throw new BadRequest("Environment has no anthropic_id");

  // Resolve vault connection -> Anthropic vault ids.
  let vault_ids: string[] | undefined;
  if (parsed.vault_connection_ids?.length) {
    const { data: vcs } = await user.db
      .from("vault_connections")
      .select("anthropic_vault_id")
      .in("id", parsed.vault_connection_ids);
    vault_ids = (vcs ?? []).map((v) => v.anthropic_vault_id).filter(Boolean) as string[];
  }

  // Resolve KB files + memory stores → Anthropic IDs and assemble the
  // `resources` array. KB files lazy-sync to Anthropic on first attach so
  // users don't have to think about a separate "publish to Anthropic"
  // step. Memory stores must already be synced (created with anthropic_id
  // on POST /memory/stores) — if missing we surface a 400 so the caller
  // can hit the sync endpoint and retry.
  const resources: SessionResource[] = [];
  if (parsed.kb_file_ids?.length) {
    const { data: files } = await user.db
      .from("kb_files")
      .select("id,name,storage_path,anthropic_file_id")
      .in("id", parsed.kb_file_ids);
    for (const f of files ?? []) {
      let aid = f.anthropic_file_id as string | null;
      if (!aid) {
        const { data: blob, error } = await serviceClient().storage.from("kb").download(
          f.storage_path as string,
        );
        if (error || !blob) {
          throw new BadRequest(`KB file ${f.id} has no Storage object: ${error?.message ?? "missing"}`);
        }
        const uploaded = await AnthropicFiles.upload(blob, f.name as string, "agent");
        aid = uploaded.id;
        await serviceClient().from("kb_files")
          .update({ anthropic_file_id: aid }).eq("id", f.id);
      }
      resources.push({
        type: "file",
        file_id: aid,
        mount_path: `/mnt/session/uploads/${f.name}`,
      });
    }
  }
  // Resolve pinned KB names from the agent's default_resources. These are
  // name-pattern strings that get resolved to the latest matching file each
  // time, so they survive file re-uploads without needing to update the agent.
  const pinnedNames: string[] = (agent as any)?.default_resources?.pinned_kb_names ?? [];
  const alreadyAttachedIds = new Set((parsed.kb_file_ids ?? []) as string[]);
  if (pinnedNames.length) {
    for (const pattern of pinnedNames) {
      // Scope the name-match to the calling user's files. The RLS read policy
      // allows any authenticated user to see all kb_files rows, so without
      // the uploaded_by filter a pinned pattern could resolve to another
      // user's file and mount it into this session.
      let q = user.db
        .from("kb_files")
        .select("id,name,storage_path,anthropic_file_id")
        .ilike("name", `%${pattern}%`);
      if (user.role !== "admin") q = q.eq("uploaded_by", user.id);
      const { data: matches } = await q
        .order("updated_at", { ascending: false })
        .limit(1);
      const f = matches?.[0];
      if (!f || alreadyAttachedIds.has(f.id as string)) continue;
      alreadyAttachedIds.add(f.id as string);
      let aid = f.anthropic_file_id as string | null;
      if (!aid) {
        const { data: blob, error } = await serviceClient().storage.from("kb").download(
          f.storage_path as string,
        );
        if (!error && blob) {
          const uploaded = await AnthropicFiles.upload(blob, f.name as string, "agent");
          aid = uploaded.id;
          await serviceClient().from("kb_files")
            .update({ anthropic_file_id: aid }).eq("id", f.id);
        }
      }
      if (aid) {
        resources.push({
          type: "file",
          file_id: aid,
          mount_path: `/mnt/session/uploads/${f.name}`,
        });
      }
    }
  }

  if (parsed.memory_store_ids?.length) {
    const { data: stores } = await user.db
      .from("memory_stores")
      .select("id,name,anthropic_id")
      .in("id", parsed.memory_store_ids);
    for (const s of stores ?? []) {
      if (!s.anthropic_id) {
        throw new BadRequest(
          `Memory store ${s.name} has no anthropic_id. POST /memory/stores/${s.id}/sync-to-anthropic first.`,
        );
      }
      resources.push({
        type: "memory_store",
        memory_store_id: s.anthropic_id as string,
        access: "read_write",
      });
    }
  }

  let created: any;
  try {
    created = await AnthropicSessions.create({
      agent: agent.anthropic_id,
      environment_id: environment.anthropic_id,
      vault_ids,
      resources: resources.length ? resources : undefined,
      title: parsed.title,
    });
  } catch (err) {
    throw new Upstream(`Anthropic sessions.create failed: ${(err as Error).message}`);
  }

  const { data: row, error } = await user.db
    .from("sessions")
    .insert({
      anthropic_id: created.id,
      workflow_id: parsed.workflow_id ?? null,
      agent_id: parsed.agent_id,
      environment_id: parsed.environment_id,
      vault_connection_ids: parsed.vault_connection_ids ?? [],
      title: parsed.title,
      status: "idle",
      trigger_payload: parsed.trigger_payload ?? null,
      trigger_summary: parsed.title ?? null,
      started_by: user.id,
    })
    .select()
    .single();
  if (error) throw new BadRequest(error.message);

  // Send any kickoff events. Outcome takes precedence; otherwise the optional message.
  const events: UserEvent[] = [];
  if (parsed.outcome) {
    events.push({
      type: "user.define_outcome",
      description: parsed.outcome.description,
      rubric: { type: "text", content: parsed.outcome.rubric_md },
      max_iterations: parsed.outcome.max_iterations,
    });
  }
  if (parsed.initial_message) {
    events.push({
      type: "user.message",
      content: [{ type: "text", text: parsed.initial_message }],
    });
  }
  if (events.length > 0) {
    try {
      await AnthropicSessionEvents.send(created.id, events);
    } catch (err) {
      // Bubble up. The session is created; the caller can retry sending.
      throw new Upstream(`Anthropic events.send failed: ${(err as Error).message}`);
    }
  }

  await writeAudit({
    actor_id: user.id,
    action: "session.start",
    resource_type: "session",
    resource_id: row.id,
    metadata: { anthropic_id: created.id, workflow_id: parsed.workflow_id },
  });

  return ok(row, 201);
});

router.post("/:id/events", async (req, params) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const parsed = SessionSendEventSchema.parse(body);
  const { data: session } = await user.db.from("sessions").select("anthropic_id").eq(
    "id",
    params.id,
  ).maybeSingle();
  if (!session?.anthropic_id) throw new NotFound("Session not found");
  try {
    await AnthropicSessionEvents.send(session.anthropic_id, parsed.events as UserEvent[]);
  } catch (err) {
    throw new Upstream(`Anthropic events.send failed: ${(err as Error).message}`);
  }
  // Don't insert locally — refreshFromAnthropic on the next /runs/:id GET
  // will pull the canonical event back with its anthropic_event_id and
  // store it once. Inserting here previously caused duplicate user.message
  // rows because the dedup key (anthropic_event_id) was missing.
  return ok({ accepted: parsed.events.length });
});

router.post("/:id/interrupt", async (req, params) => {
  const user = await requireUser(req);
  const { data: session } = await user.db.from("sessions").select("anthropic_id").eq(
    "id",
    params.id,
  ).maybeSingle();
  if (!session?.anthropic_id) throw new NotFound("Session not found");
  try {
    await AnthropicSessionEvents.send(session.anthropic_id, [{ type: "user.interrupt" }]);
  } catch (err) {
    throw new Upstream(`Anthropic interrupt failed: ${(err as Error).message}`);
  }
  return ok({ interrupted: true });
});

// SSE proxy. We connect to Anthropic's stream, persist every event, and
// forward each line straight to the client.
router.get("/:id/stream", async (req, params) => {
  const user = await requireUser(req);
  const { data: session } = await user.db.from("sessions").select("anthropic_id").eq(
    "id",
    params.id,
  ).maybeSingle();
  if (!session?.anthropic_id) throw new NotFound("Session not found");
  if (!ENV.ANTHROPIC_API_KEY) throw new Upstream("ANTHROPIC_API_KEY missing");

  const upstreamRes = await fetch(
    `https://api.anthropic.com/v1/sessions/${session.anthropic_id}/events/stream`,
    {
      method: "GET",
      headers: {
        "x-api-key": ENV.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": ENV.ANTHROPIC_BETA_HEADER,
        Accept: "text/event-stream",
      },
    },
  );
  if (!upstreamRes.ok || !upstreamRes.body) {
    const text = await upstreamRes.text();
    throw new Upstream(`Stream open failed: ${upstreamRes.status} ${text}`);
  }
  const sc = serviceClient();
  const sessionId = params.id;

  // Thin pipe: forward + persist events, no tool dispatch. Tool calls fire
  // from /runs/:id polls instead (drainKbToolCalls + drainImageToolCalls),
  // so a long generation doesn't pin this stream's worker for its duration.
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      controller.enqueue(chunk);
      try {
        const text = new TextDecoder().decode(chunk);
        for (const line of text.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (!json) continue;
          let parsed: any;
          try { parsed = JSON.parse(json); } catch { continue; }
          await sc.from("session_events").insert({
            session_id: sessionId,
            anthropic_event_id: parsed.id ?? null,
            event_type: parsed.type ?? "unknown",
            payload: parsed,
            processed_at: parsed.processed_at ?? new Date().toISOString(),
          });
          if (typeof parsed.type === "string" && parsed.type.startsWith("session.status_")) {
            const status = parsed.type.replace("session.status_", "");
            await sc
              .from("sessions")
              .update({
                status,
                finished_at: status === "idle" || status === "terminated"
                  ? new Date().toISOString()
                  : null,
                usage: parsed.usage ?? undefined,
              })
              .eq("id", sessionId);
          }
        }
      } catch (err) {
        console.warn("stream persist error:", err);
      }
    },
  });

  return new Response(upstreamRes.body.pipeThrough(transform), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

// Proxy a single Anthropic file's bytes through to the browser. The browser
// can't carry our bearer token in <img>/<iframe> attributes, so the frontend
// fetches with auth and creates a blob URL. We scope access by checking the
// file_id appears in this session's events.
router.get("/:id/files/:fileId", async (req, params) => {
  const user = await requireUser(req);
  const { data: session } = await user.db.from("sessions").select("id,anthropic_id").eq(
    "id",
    params.id,
  ).maybeSingle();
  if (!session) throw new NotFound("Session not found");
  if (!session.anthropic_id) throw new NotFound("Session has no Anthropic id");

  // Source of truth: ask Anthropic which files belong to this session's scope.
  const list = await AnthropicFiles.list({ scope_id: session.anthropic_id as string });
  const allowed = new Set((list.data ?? []).map((f) => f.id));
  if (!allowed.has(params.fileId)) {
    throw new NotFound("File not in this session's scope");
  }

  const meta = await AnthropicFiles.retrieve(params.fileId);
  const upstream = await AnthropicFiles.content(params.fileId);
  const headers = new Headers();
  const mime = meta.mime_type ?? upstream.headers.get("content-type") ?? "application/octet-stream";
  headers.set("Content-Type", mime);
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  const filename = (meta.filename ?? params.fileId).replace(/[^\w.\-]+/g, "_");
  const disp = new URL(req.url).searchParams.get("download") === "1" ? "attachment" : "inline";
  headers.set("Content-Disposition", `${disp}; filename="${filename}"`);
  headers.set("Cache-Control", "private, max-age=300");
  return new Response(upstream.body, { status: 200, headers });
});

router.post("/:id/archive", async (req, params) => {
  const user = await requireUser(req);
  const { data: session } = await user.db.from("sessions").select("anthropic_id").eq(
    "id",
    params.id,
  ).maybeSingle();
  if (!session?.anthropic_id) throw new NotFound("Session not found");
  try {
    await AnthropicSessions.archive(session.anthropic_id);
  } catch (err) {
    console.warn("anthropic session archive failed:", err);
  }
  await user.db
    .from("sessions")
    .update({ status: "terminated", finished_at: new Date().toISOString() })
    .eq("id", params.id);
  return ok({ archived: true });
});

router.delete("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data: session } = await user.db.from("sessions").select("anthropic_id,status").eq(
    "id",
    params.id,
  ).maybeSingle();
  if (!session) throw new NotFound("Session not found");
  if (session.anthropic_id) {
    try {
      await AnthropicSessions.delete(session.anthropic_id);
    } catch (err) {
      console.warn("anthropic session delete failed:", err);
    }
  }
  const { error } = await user.db.from("sessions").delete().eq("id", params.id);
  if (error) throw new Error(error.message);
  return noContent();
});

Deno.serve(wrap((req) => router.handle(req)));
