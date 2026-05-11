#!/usr/bin/env node
// Stress-test load runner.
//
// Drives the Director agent against the simulated boards produced by
// simulate-campaigns.mjs. For each board:
//   1. POST /vibe-boards/setup           → agent_id + environment_id
//   2. POST /sessions                    → session_id + initial kickoff message
//   3. PATCH /vibe-boards/:id            → link the session to the board
//   4. Poll GET /runs/:id every poll_ms  → wait for the agent to go idle
//   5. Score the result                  → ttf-agent, ttf-gen, tool/msg counts
//
// All runs are sequenced through a small concurrency pool (--concurrent).
//
// Writes a structured JSON report to scripts/.out/run-<timestamp>.json with
// per-board timings, failure breakdowns, and aggregate p50/p95/p99.
//
// Usage:
//   npm run load-test-campaigns -- [flags]
//
// Flags:
//   --concurrent N      (default 1, max 10)  Parallel boards in-flight.
//   --boards N          (default ALL)        Limit how many boards to run.
//   --model NAME        (default gemini-fast) gemini-fast | gemini-quality | openai
//                                            Passed through in the kickoff message.
//                                            openai burns real $$ — opt-in only.
//   --timeout MS        (default 180000)     Per-board wall-clock cap.
//   --poll-ms MS        (default 4000)       Poll cadence on /runs/:id.
//   --max-prompts N     (default 3)          Ask the agent for N image directions.
//   --tag <name>        (default run)        Suffix on the output report file.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Buffer } from "node:buffer";

const SCRIPT_DIR = import.meta.dirname;
const OUT_DIR = resolve(SCRIPT_DIR, ".out");
const ENV_PATH = resolve(SCRIPT_DIR, "..", ".env");
const CREDS_PATH = resolve(OUT_DIR, "harness-credentials.json");
const MANIFEST_PATH = resolve(OUT_DIR, "manifest.json");

const env = parseEnv(readFileSync(ENV_PATH, "utf8"));
const SUPABASE_URL = env.EXTERNAL_SUPABASE_URL || env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = env.SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
const ANTHROPIC_BETA_HEADER = env.ANTHROPIC_BETA_HEADER || "managed-agents-2026-04-01";
const GEMINI_API_KEY = env.GEMINI_API_KEY;
const OPENAI_API_KEY = env.OPENAI_API_KEY;
if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  fail("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY in .env");
}
const FN_URL = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1`;

if (!existsSync(CREDS_PATH)) {
  fail("scripts/.out/harness-credentials.json missing — run `npm run simulate-campaigns` first");
}
const creds = JSON.parse(readFileSync(CREDS_PATH, "utf8"));

if (!existsSync(MANIFEST_PATH)) {
  fail("scripts/.out/manifest.json missing — run `npm run simulate-campaigns` first");
}
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

const args = parseArgs(process.argv.slice(2));
const CONCURRENT = clampInt(intArg("concurrent", 1), 1, 10);
const BOARD_LIMIT = args.flags.boards ? parseInt(args.flags.boards, 10) : manifest.boards.length;
const MODEL = (args.flags.model ?? "gemini-fast").trim();
const TIMEOUT_MS = intArg("timeout", 180_000);
const POLL_MS = intArg("poll-ms", 4_000);
const MAX_PROMPTS = intArg("max-prompts", 3);
const TAG = args.flags.tag ?? "run";
// When the local /runs/:id background tool dispatcher is unreliable (common in
// the supabase-local edge runtime where EdgeRuntime.waitUntil is missing /
// workers cycle between requests), the harness can pick up the slack and
// satisfy pending tool_uses itself. This lets us measure full end-to-end
// agent-loop latency rather than getting stuck after the first read_board.
const DISPATCH_TOOLS = !args.bool["no-dispatch-tools"];

if (MODEL === "openai") {
  log("WARNING: --model=openai will burn real OpenAI credits.");
}

log("─ campaign load runner ─");
log(`supabase:      ${SUPABASE_URL}`);
log(`harness:       ${creds.email}`);
log(`boards (sim):  ${manifest.boards.length} simulated boards in manifest`);
log(`concurrency:   ${CONCURRENT}`);
log(`per-board to:  ${TIMEOUT_MS / 1000}s`);
log(`poll cadence:  ${POLL_MS}ms`);
log(`model:         ${MODEL}`);
log(`max boards:    ${BOARD_LIMIT}`);

// ─ auth ──────────────────────────────────────────────────────────────────

const jwt = await signInHarness();
log(`signed in.  JWT: ${jwt.slice(0, 12)}…`);

// ─ setup once (Director agent + default env) ─────────────────────────────

const setup = await fnPost("/vibe-boards/setup", null);
const agentId = setup.agent?.id;
const envId = setup.environment?.id;
if (!agentId || !envId) fail(`/vibe-boards/setup did not return agent.id + environment.id: ${JSON.stringify(setup).slice(0, 200)}`);
log(`director:      agent_id=${agentId.slice(0, 8)}…  env_id=${envId.slice(0, 8)}…`);

// ─ pick boards ───────────────────────────────────────────────────────────

const allBoards = manifest.boards.slice(0, BOARD_LIMIT);
log(`\nrunning ${allBoards.length} board(s) at concurrency ${CONCURRENT}…\n`);

const startedAt = Date.now();

// Simple p-limit-style runner.
const inFlight = new Set();
const results = [];
let nextIdx = 0;
const total = allBoards.length;

await new Promise((resolveAll) => {
  const tickOne = () => {
    while (inFlight.size < CONCURRENT && nextIdx < total) {
      const idx = nextIdx++;
      const board = allBoards[idx];
      const p = runOneBoard(board, idx).then((r) => {
        results.push(r);
        inFlight.delete(p);
        const tag = r.success ? "✓" : "✗";
        const ttfa = r.timings.ttf_agent_message_ms;
        const ttfg = r.timings.ttf_first_generation_ms;
        log(
          `[${idx + 1}/${total}] ${tag} ${board.name.slice(0, 48).padEnd(48)}  ` +
          `ttf-msg=${fmtMs(ttfa)} ttf-gen=${fmtMs(ttfg)} ` +
          `msgs=${r.counts.agent_messages} tools=${r.counts.tool_uses} gens=${r.counts.generations} ` +
          `hdsp=${r.counts.harness_dispatched ?? 0} ` +
          `end=${r.end_status}${r.failure_stage ? " stage=" + r.failure_stage : ""}`
        );
        tickOne();
      });
      inFlight.add(p);
    }
    if (inFlight.size === 0 && nextIdx >= total) resolveAll();
  };
  tickOne();
});

const durationMs = Date.now() - startedAt;

// ─ aggregate report ──────────────────────────────────────────────────────

const report = buildReport({
  results,
  startedAt,
  durationMs,
  args: {
    concurrent: CONCURRENT,
    boards: total,
    model: MODEL,
    timeout_ms: TIMEOUT_MS,
    poll_ms: POLL_MS,
    max_prompts: MAX_PROMPTS,
  },
  harness: creds.email,
});

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const reportPath = resolve(OUT_DIR, `run-${ts}-${TAG}.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2));

log("\n══ summary ══");
log(`total boards:       ${report.totals.boards}`);
log(`succeeded:          ${report.totals.succeeded}`);
log(`failed:             ${report.totals.failed}  (${report.totals.failed > 0 ? Object.entries(report.failure_by_stage).map(([k, v]) => `${k}=${v}`).join(", ") : "—"})`);
log(`agent went idle:    ${report.totals.idle}`);
log(`hit timeout:        ${report.totals.timeout}`);
log(`total generations:  ${report.totals.generations}`);
log(`total tool calls:   ${report.totals.tool_uses}`);
log(`total agent msgs:   ${report.totals.agent_messages}`);
log(`harness-dispatched: ${report.totals.harness_dispatched}  (>0 ⇒ edge fn drain stalled)`);
log(`wall-clock:         ${(durationMs / 1000).toFixed(1)}s`);
log("\nlatency (ms):     p50      p95      p99      max");
for (const [label, samples] of Object.entries(report.latencies)) {
  const p = pct(samples);
  log(`  ${label.padEnd(17)} ${fmt(p.p50)}   ${fmt(p.p95)}   ${fmt(p.p99)}   ${fmt(p.max)}`);
}
log(`\nreport:  ${reportPath.replace(SCRIPT_DIR, "scripts")}`);

if (CONCURRENT >= 4 && report.totals.idle > 0) {
  log("\nnote: at this concurrency the bottleneck is typically the supabase " +
    "edge-function worker pool (deno serve in local dev pins ~4 workers), " +
    "not Anthropic. To verify: bump --concurrent and watch p50 ttf-msg " +
    "rise more-or-less linearly while Anthropic-side latency stays flat.");
}

// ═════════════════════════════════════════════════════════════════════════
// PER-BOARD RUN
// ═════════════════════════════════════════════════════════════════════════

async function runOneBoard(board, idx) {
  const r = {
    board_id: board.id,
    board_name: board.name,
    campaign_id: board.campaign_id,
    channel: board.channel,
    success: false,
    failure_stage: null,
    failure_message: null,
    end_status: null,
    timings: {
      started_ms: 0,
      session_created_ms: 0,
      first_event_ms: null,
      ttf_agent_message_ms: null,
      ttf_first_generation_ms: null,
      finished_ms: null,
    },
    counts: {
      agent_messages: 0,
      tool_uses: 0,
      tool_results: 0,
      generations: 0,
      events_total: 0,
      harness_dispatched: 0,
    },
    polls: 0,
  };
  const t0 = Date.now();

  // 1. session create
  let sessionId;
  let anthropicSessionId;
  try {
    const session = await fnPost("/sessions", {
      agent_id: agentId,
      environment_id: envId,
      title: board.name.slice(0, 80),
      initial_message: kickoffMessage(board, MODEL, MAX_PROMPTS),
    });
    sessionId = session.id;
    anthropicSessionId = session.anthropic_id;
    r.timings.session_created_ms = Date.now() - t0;
  } catch (err) {
    r.failure_stage = "session-create";
    r.failure_message = err.message;
    return r;
  }

  // 2. link session → board (so the agent's tools resolve to this board)
  try {
    await fnPatch(`/vibe-boards/${board.id}`, { session_id: sessionId });
  } catch (err) {
    r.failure_stage = "link-board";
    r.failure_message = err.message;
    return r;
  }

  // 3. poll /runs/:id
  //
  // Notes on terminal-state detection:
  //   - The local sessions row is inserted with status='idle' by /sessions
  //     itself (sessions/index.ts:196), then refreshFromAnthropic flips it
  //     to 'working' on the next /runs/:id poll, then back to 'idle' when
  //     the agent finishes. So a naive "idle => done" check ends every run
  //     in 1.7 s with 0 events.
  //   - We treat the run as terminal only after we've seen the session in
  //     a non-idle state (working / paused) at least once, OR we've waited
  //     past `minWaitMs` for any event at all.
  //   - We also wait an extra "settle" period after the last event before
  //     calling idle terminal, to catch the case where the agent sends a
  //     chat ack, calls a tool, status briefly returns to 'idle' between
  //     turns, then ramps back up to 'working' for the tool result.
  const deadline = t0 + TIMEOUT_MS;
  const minWaitMs = Math.max(POLL_MS * 2, 8_000);
  const settleMs = Math.max(POLL_MS * 2, 8_000);
  let sawNonIdle = false;
  let lastEventCount = 0;
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    r.polls += 1;
    let payload;
    try {
      payload = await fnGet(`/runs/${sessionId}`);
    } catch (err) {
      r.failure_stage = "poll";
      r.failure_message = err.message;
      return r;
    }
    // Local DB events are populated by the /runs/:id endpoint's background
    // refresh task. In supabase local dev that background path is unreliable
    // (no/limited EdgeRuntime.waitUntil + aggressive worker recycling), so we
    // fall back to a direct Anthropic events.list call whenever the local
    // view is empty. The harness has the Anthropic key in .env, so this
    // costs us one extra round-trip per poll but produces correct numbers.
    let events = payload.events ?? [];
    let anthropicStatus = null;
    if (ANTHROPIC_API_KEY && anthropicSessionId) {
      try {
        const direct = await listAnthropicEvents(anthropicSessionId);
        if (direct.events.length > events.length) {
          events = direct.events.map(normalizeAnthropicEvent);
        }
        anthropicStatus = direct.status;
      } catch (_err) { /* fall through; we'll retry next poll */ }
    }
    if (events.length > 0 && r.timings.first_event_ms == null) {
      r.timings.first_event_ms = Date.now() - t0;
    }
    summarizeEvents(events, r, t0);
    r.counts.events_total = events.length;
    // Prefer Anthropic-reported status when available — the local DB lags
    // until the bg drain catches up.
    r.end_status = anthropicStatus ?? payload.session?.status;

    // Harness-side tool dispatch. The local /runs/:id background drainer can
    // stall in supabase-local — if it does, the agent gets parked indefinitely
    // after its first read_board call. We satisfy pending custom tool_uses
    // ourselves so the loop continues. Tracked in `harness_dispatched_tools`.
    if (DISPATCH_TOOLS && anthropicSessionId && r.end_status === "idle") {
      const dispatched = await harnessDispatchPending(
        anthropicSessionId, events, board, r,
      );
      if (dispatched > 0) {
        r.counts.harness_dispatched = (r.counts.harness_dispatched ?? 0) + dispatched;
        // Reset the terminal-state tracker: the agent will transition back
        // to "working" once it picks up our tool_result, and we want to wait
        // for the next idle (after the follow-up turn) rather than calling
        // the current idle terminal.
        sawNonIdle = false;
        lastChangeAt = Date.now();
        await sleep(POLL_MS);
        continue;
      }
    }

    if (r.end_status && r.end_status !== "idle" && r.end_status !== "terminated") {
      sawNonIdle = true;
    }
    if (events.length !== lastEventCount) {
      lastEventCount = events.length;
      lastChangeAt = Date.now();
    }

    const elapsed = Date.now() - t0;
    const idleNow = r.end_status === "idle" || r.end_status === "terminated";
    const settled = Date.now() - lastChangeAt > settleMs;
    if (idleNow && elapsed >= minWaitMs && (sawNonIdle || settled)) {
      r.timings.finished_ms = elapsed;
      r.success = r.counts.agent_messages > 0 && !r.failure_stage;
      if (!r.success && !r.failure_stage) {
        r.failure_stage = "agent-stalled";
        r.failure_message = `Idle with ${r.counts.agent_messages} agent messages, ${r.counts.tool_uses} tool calls, ${r.counts.events_total} events.`;
      }
      return r;
    }
    await sleep(POLL_MS);
  }
  // Timeout
  r.failure_stage = "timeout";
  r.failure_message = `Did not reach idle within ${TIMEOUT_MS}ms.`;
  r.end_status = r.end_status ?? "unknown";
  return r;
}

function summarizeEvents(events, r, t0) {
  let agentMessages = 0;
  let toolUses = 0;
  let toolResults = 0;
  let generations = 0;
  let firstAgentAt = null;
  let firstGenAt = null;
  let hasGenError = false;
  const genToolNames = new Set([
    "generate_image_openai",
    "generate_image_gemini",
    "prompt_via_card",
  ]);
  for (const e of events) {
    const p = e.payload ?? e;
    const type = e.event_type ?? p.type;
    if (type === "agent.message" || type === "agent.final_message") {
      agentMessages++;
      const ts = parseEventTs(e);
      if (ts && (firstAgentAt == null || ts < firstAgentAt)) firstAgentAt = ts;
    }
    // Two shapes for tool_use:
    //   1) Anthropic-direct: a top-level event of type "agent.custom_tool_use"
    //      with {name, input, id}.
    //   2) Local DB (post-bg-drain): tool_use blocks nested inside an
    //      agent.message event's content array.
    if (type === "agent.custom_tool_use" || type === "agent.tool_use") {
      toolUses++;
      const name = String(p.name || "");
      if (genToolNames.has(name)) {
        const ts = parseEventTs(e);
        if (ts && (firstGenAt == null || ts < firstGenAt)) firstGenAt = ts;
      }
    }
    if (Array.isArray(p.content)) {
      for (const block of p.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_use" || block.type === "agent.tool_use") {
          toolUses++;
          const name = String(block.name || "");
          if (genToolNames.has(name)) {
            const ts = parseEventTs(e);
            if (ts && (firstGenAt == null || ts < firstGenAt)) firstGenAt = ts;
          }
        }
      }
    }
    if (type === "user.custom_tool_result") {
      toolResults++;
      try {
        const txt = Array.isArray(p.content)
          ? p.content.map((c) => (c.text ?? "")).join("")
          : "";
        if (/file_ids/.test(txt) || /media_asset_id/.test(txt)) {
          const parsed = JSON.parse(txt);
          if (Array.isArray(parsed.file_ids)) {
            generations += parsed.file_ids.length;
          } else if (parsed.media_asset_id) {
            generations += 1;
          }
          if (parsed.error) hasGenError = true;
        } else if (txt.startsWith("[ERROR]")) {
          hasGenError = true;
        }
      } catch { /* ignore */ }
    }
  }
  r.counts.agent_messages = agentMessages;
  r.counts.tool_uses = toolUses;
  r.counts.tool_results = toolResults;
  r.counts.generations = generations;
  if (firstAgentAt != null) {
    const ttf = firstAgentAt - t0;
    if (ttf >= 0) r.timings.ttf_agent_message_ms = ttf;
  }
  if (firstGenAt != null) {
    const ttf = firstGenAt - t0;
    if (ttf >= 0) r.timings.ttf_first_generation_ms = ttf;
  }
  if (hasGenError && !r.failure_stage) {
    r.failure_stage_hint = "gen-error";
  }
}

function parseEventTs(e) {
  const raw = e.processed_at ?? e.created_at ?? e.payload?.processed_at;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Harness-side tool dispatcher.
//
// Mirrors the *minimum* surface of supabase/functions/_shared/image_tools.ts
// needed to drive the Director through a full multi-turn run from the kickoff
// message. Implemented purely against:
//   - the Supabase REST API (service-role) for board / media reads + writes
//   - the Anthropic events.send endpoint for posting tool_result back
//   - direct Gemini / OpenAI calls for image generation
//   - the Anthropic Files API for uploading generated images
//
// The supabase edge function's `drainImageToolCalls` does the same work; this
// is a fallback for environments where that background path stalls. When the
// edge fn is healthy, this code finds 0 pending tool_uses and returns early.
// ─────────────────────────────────────────────────────────────────────────

async function harnessDispatchPending(anthropicSessionId, events, board, r) {
  // Collect tool_use ids that lack a matching custom_tool_result.
  const answered = new Set();
  const pending = []; // { tool_use_id, name, input, at }
  for (const e of events) {
    const p = e.payload ?? e;
    const type = e.event_type ?? p.type;
    if (type === "user.custom_tool_result" && p.custom_tool_use_id) {
      answered.add(p.custom_tool_use_id);
    }
    if (type === "agent.custom_tool_use" && p.id) {
      pending.push({
        tool_use_id: p.id,
        name: p.name,
        input: p.input ?? {},
        at: parseEventTs(e),
      });
    }
  }
  const unanswered = pending.filter((u) => !answered.has(u.tool_use_id));
  if (unanswered.length === 0) return 0;

  // De-dup against already-attempted IDs on this run object.
  r._harness_attempted = r._harness_attempted ?? new Set();
  const fresh = unanswered.filter((u) => !r._harness_attempted.has(u.tool_use_id));
  if (fresh.length === 0) return 0;
  for (const u of fresh) r._harness_attempted.add(u.tool_use_id);

  // Dispatch in parallel.
  await Promise.all(fresh.map(async (u) => {
    try {
      const result = await runHarnessTool(u, board);
      await postCustomToolResult(anthropicSessionId, u.tool_use_id, result);
    } catch (err) {
      const msg = `[ERROR] harness-dispatch ${u.name}: ${err.message ?? err}`;
      try { await postCustomToolResult(anthropicSessionId, u.tool_use_id, msg); }
      catch { /* ignore */ }
      // Record a soft hint — caller decides whether to escalate.
      r.failure_stage_hint = `tool-error:${u.name}`;
    }
  }));
  return fresh.length;
}

async function runHarnessTool(use, board) {
  switch (use.name) {
    case "read_board":
      return await tool_readBoard(board);
    case "update_board":
      return await tool_updateBoard(board, use.input);
    case "list_media":
      return await tool_listMedia(board, use.input);
    case "attach_media_as_reference":
      return await tool_attachMedia(board, use.input);
    case "generate_image_gemini":
      return await tool_generate(board, "gemini-fast", use.input);
    case "generate_image_openai":
      if (!OPENAI_API_KEY) return JSON.stringify({ error: "OPENAI_API_KEY missing — switching vendor" });
      return await tool_generate(board, "openai", use.input);
    case "prompt_via_card":
      return await tool_promptViaCard(board, use.input);
    default:
      return JSON.stringify({ error: `Unknown tool: ${use.name}` });
  }
}

async function tool_readBoard(board) {
  const rows = await sbRest("GET", `/vibe_boards?id=eq.${board.id}&select=id,state`);
  const state = rows[0]?.state ?? { items: [] };
  return JSON.stringify({
    board_id: board.id,
    items: state.items ?? [],
    note: "Harness-served read_board. Each item has id, type, position, type-specific fields.",
  });
}

async function tool_updateBoard(board, input) {
  const itemsIn = Array.isArray(input?.items) ? input.items : [];
  if (itemsIn.length === 0) return JSON.stringify({ error: "items required" });
  const rows = await sbRest("GET", `/vibe_boards?id=eq.${board.id}&select=state`);
  const state = rows[0]?.state ?? { items: [] };
  const existing = Array.isArray(state.items) ? state.items : [];
  const fresh = itemsIn.map((it) => ({
    id: `it_${Math.random().toString(36).slice(2, 10)}`,
    ...it,
  }));
  const next = { ...state, items: [...existing, ...fresh] };
  await sbRest("PATCH", `/vibe_boards?id=eq.${board.id}`, { state: next });
  return JSON.stringify({ appended: fresh.length, item_ids: fresh.map((f) => f.id) });
}

async function tool_listMedia(board, input) {
  const tag = input?.tag;
  const q = input?.q;
  const limit = clampInt(input?.limit ?? 50, 1, 200);
  // Look up board owner to scope correctly.
  const rows = await sbRest("GET", `/vibe_boards?id=eq.${board.id}&select=owner_id`);
  const ownerId = rows[0]?.owner_id;
  if (!ownerId) return JSON.stringify({ error: "board owner missing" });
  let path = `/media_assets?owner_id=eq.${ownerId}&select=id,name,mime,size_bytes,width,height,tags,anthropic_file_id&order=created_at.desc&limit=${limit}`;
  if (tag) path += `&tags=cs.${encodeURIComponent(JSON.stringify([tag]))}`;
  if (q) path += `&name=ilike.${encodeURIComponent(`%${q}%`)}`;
  const assets = await sbRest("GET", path);
  return JSON.stringify({
    assets: assets.map((a) => ({
      media_id: a.id, name: a.name, mime: a.mime, size_bytes: a.size_bytes,
      width: a.width, height: a.height, tags: a.tags ?? [],
      anthropic_file_id: a.anthropic_file_id ?? null,
    })),
    note: "Harness-served list_media.",
  });
}

async function tool_attachMedia(board, input) {
  const mediaId = input?.media_id;
  if (!mediaId) return JSON.stringify({ error: "media_id required" });
  const ass = await sbRest("GET", `/media_assets?id=eq.${mediaId}&select=id,name,storage_path,mime,anthropic_file_id,owner_id`);
  const asset = ass[0];
  if (!asset) return JSON.stringify({ error: "media not found" });

  // Lazy-upload to Anthropic Files if needed.
  let aid = asset.anthropic_file_id;
  if (!aid) {
    const blob = await sbStorageDownload("media", asset.storage_path);
    aid = await anthropicFilesUpload(blob, asset.name, "agent");
    await sbRest("PATCH", `/media_assets?id=eq.${mediaId}`, { anthropic_file_id: aid });
  }

  const rows = await sbRest("GET", `/vibe_boards?id=eq.${board.id}&select=state`);
  const state = rows[0]?.state ?? { items: [] };
  const items = Array.isArray(state.items) ? state.items : [];
  const newItem = {
    id: `it_${Math.random().toString(36).slice(2, 10)}`,
    type: "reference",
    x: input?.x ?? 1200,
    y: input?.y ?? 600,
    anthropic_file_id: aid,
    caption: input?.caption ?? asset.name,
  };
  await sbRest("PATCH", `/vibe_boards?id=eq.${board.id}`, {
    state: { ...state, items: [...items, newItem] },
  });
  return JSON.stringify({ attached: true, item_id: newItem.id, anthropic_file_id: aid });
}

async function tool_generate(board, model, input) {
  const prompt = String(input?.prompt ?? "").trim();
  if (!prompt) return JSON.stringify({ error: "prompt required" });
  const n = clampInt(input?.n ?? 1, 1, 4);
  const blobs = await generateImages(model, prompt, n);
  const fileIds = [];
  for (let i = 0; i < blobs.length; i++) {
    const filename = `harness_${Date.now()}_${i}.${blobs[i].type.includes("jpeg") ? "jpg" : "png"}`;
    fileIds.push(await anthropicFilesUpload(blobs[i], filename, "agent"));
  }
  return JSON.stringify({ file_ids: fileIds, note: "Generated via harness. Call update_board to display." });
}

async function tool_promptViaCard(board, input) {
  const prompt = String(input?.prompt ?? "").trim();
  if (!prompt) return JSON.stringify({ error: "prompt required" });
  let model = input?.model ?? "gemini-fast";
  if (model === "openai" && !OPENAI_API_KEY) model = "gemini-fast";
  if (model.startsWith("gemini") && !GEMINI_API_KEY) {
    return JSON.stringify({ error: "GEMINI_API_KEY missing" });
  }
  const [blob] = await generateImages(model, prompt, 1);

  // Resolve board owner for the asset row.
  const rows = await sbRest("GET", `/vibe_boards?id=eq.${board.id}&select=owner_id,state`);
  const ownerId = rows[0]?.owner_id;
  const state = rows[0]?.state ?? { items: [] };

  // Upload to media bucket + insert media_assets row.
  const ext = blob.type.includes("jpeg") ? "jpg" : "png";
  const filename = `gen_${Date.now()}_0.${ext}`;
  const assetId = randomUUIDish();
  const storagePath = `users/${ownerId}/${assetId}/${filename}`;
  await sbStorageUpload("media", storagePath, await blob.arrayBuffer(), blob.type);
  await sbRest("POST", "/media_assets", {
    id: assetId,
    owner_id: ownerId,
    name: filename,
    storage_path: storagePath,
    mime: blob.type || "image/png",
    size_bytes: blob.size,
    tags: ["board-generated", "harness"],
  });

  const items = Array.isArray(state.items) ? state.items : [];
  const generationId = `gen_${randomUUIDish()}`;
  const newItem = {
    id: `it_${Math.random().toString(36).slice(2, 10)}`,
    type: "prompt",
    x: input?.x ?? 600,
    y: input?.y ?? 400,
    text: prompt,
    model,
    generations: [{
      id: generationId,
      media_asset_id: assetId,
      model,
      generated_at: new Date().toISOString(),
    }],
    current_generation_idx: 0,
    parent_id: input?.parent_id,
  };
  await sbRest("PATCH", `/vibe_boards?id=eq.${board.id}`, {
    state: { ...state, items: [...items, newItem] },
  });
  return JSON.stringify({
    item_id: newItem.id, generation_id: generationId, media_asset_id: assetId,
    note: "Prompt card placed by harness dispatcher.",
  });
}

// ─ vendor I/O ────────────────────────────────────────────────────────────

async function generateImages(model, prompt, n) {
  if (model === "openai") {
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-1", prompt, n, size: "auto", quality: "medium" }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return (json.data ?? []).map((d) => b64ToBlob(d.b64_json, "image/png"));
  }
  // gemini-fast / gemini-quality
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const geminiModel = model === "gemini-quality"
    ? "gemini-3-pro-image-preview"
    : "gemini-3.1-flash-image-preview";
  const blobs = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["IMAGE"] },
        }),
      },
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.find((p) => p.inlineData?.data);
    if (!inline) throw new Error("Gemini returned no image data");
    blobs.push(b64ToBlob(inline.inlineData.data, inline.inlineData.mimeType ?? "image/png"));
  }
  return blobs;
}

function b64ToBlob(b64, mime) {
  const bin = Buffer.from(b64, "base64");
  return new Blob([bin], { type: mime });
}

async function anthropicFilesUpload(blob, filename, type) {
  const fd = new FormData();
  fd.append("file", blob, filename);
  fd.append("type", type);
  const res = await fetch("https://api.anthropic.com/v1/files", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": ANTHROPIC_BETA_HEADER,
    },
    body: fd,
  });
  if (!res.ok) throw new Error(`anthropic files ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.id;
}

async function postCustomToolResult(anthropicSessionId, toolUseId, resultText) {
  const res = await fetch(
    `https://api.anthropic.com/v1/sessions/${anthropicSessionId}/events`,
    {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": ANTHROPIC_BETA_HEADER,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        events: [{
          type: "user.custom_tool_result",
          custom_tool_use_id: toolUseId,
          content: [{ type: "text", text: typeof resultText === "string" ? resultText : JSON.stringify(resultText) }],
        }],
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`tool_result send ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

async function sbRest(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: method === "POST" || method === "PATCH" ? "return=representation" : "",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  if (res.status === 204 || method === "DELETE") return [];
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function sbStorageDownload(bucket, storagePath) {
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
  });
  if (!res.ok) throw new Error(`storage download ${res.status}`);
  return await res.blob();
}

async function sbStorageUpload(bucket, storagePath, body, contentType) {
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      "Content-Type": contentType || "application/octet-stream",
      "x-upsert": "true",
    },
    body,
  });
  if (!res.ok) throw new Error(`storage upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

function randomUUIDish() {
  // Match the v4 shape that media_assets.id expects.
  return crypto.randomUUID();
}

function kickoffMessage(board, model, maxPrompts) {
  const tier = model.replace("gemini-", "");
  return (
    `Look at the references and prompt cards already on the board for the ` +
    `${board.name.replace(/ — vibe board$/, "")} campaign (channel: ${board.channel}). ` +
    `Read the brief note in the top-left. Then create ${maxPrompts} hero image ` +
    `directions for this campaign — use prompt_via_card with model="${model}" ` +
    `so they appear on the canvas as editable cards. ` +
    `Keep them tonally distinct (one editorial, one lifestyle, one bold). ` +
    `Use the ${tier} tier.`
  );
}

// ─ aggregate / percentile / formatting ───────────────────────────────────

function buildReport({ results, startedAt, durationMs, args, harness }) {
  // Strip transient fields that aren't part of the wire schema.
  for (const r of results) delete r._harness_attempted;
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const failureByStage = {};
  for (const r of results) {
    if (r.success) continue;
    const stage = r.failure_stage ?? "unknown";
    failureByStage[stage] = (failureByStage[stage] ?? 0) + 1;
  }
  const samples = {
    session_create_ms: results.map((r) => r.timings.session_created_ms).filter(isFiniteN),
    first_event_ms: results.map((r) => r.timings.first_event_ms).filter(isFiniteN),
    ttf_agent_message_ms: results.map((r) => r.timings.ttf_agent_message_ms).filter(isFiniteN),
    ttf_first_generation_ms: results.map((r) => r.timings.ttf_first_generation_ms).filter(isFiniteN),
    finished_ms: results.map((r) => r.timings.finished_ms).filter(isFiniteN),
  };
  const totals = {
    boards: results.length,
    succeeded, failed,
    idle: results.filter((r) => r.end_status === "idle").length,
    timeout: results.filter((r) => r.failure_stage === "timeout").length,
    generations: results.reduce((s, r) => s + r.counts.generations, 0),
    tool_uses: results.reduce((s, r) => s + r.counts.tool_uses, 0),
    agent_messages: results.reduce((s, r) => s + r.counts.agent_messages, 0),
    harness_dispatched: results.reduce((s, r) => s + (r.counts.harness_dispatched ?? 0), 0),
  };
  return {
    schema: 1,
    run_started_at: new Date(startedAt).toISOString(),
    run_duration_ms: durationMs,
    args,
    harness,
    totals,
    failure_by_stage: failureByStage,
    latencies: samples,
    boards: results,
  };
}

function pct(samples) {
  if (samples.length === 0) return { p50: null, p95: null, p99: null, max: null };
  const s = [...samples].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] };
}

function isFiniteN(v) { return typeof v === "number" && Number.isFinite(v); }
function fmt(v) { return v == null ? "  —  " : String(Math.round(v)).padStart(6, " "); }
function fmtMs(v) { return v == null ? "—" : `${Math.round(v)}ms`; }

// ═════════════════════════════════════════════════════════════════════════
// HTTP HELPERS
// ═════════════════════════════════════════════════════════════════════════

async function signInHarness() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  });
  if (!res.ok) {
    const text = await res.text();
    fail(`harness sign-in failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  return body.access_token;
}

async function fn(method, path, body) {
  const url = `${FN_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
function fnGet(p)       { return fn("GET", p); }
function fnPost(p, b)   { return fn("POST", p, b); }
function fnPatch(p, b)  { return fn("PATCH", p, b); }

// Direct Anthropic events fallback. Returns { status, events } so we can use
// Anthropic-reported status as the authoritative terminal-state signal.
async function listAnthropicEvents(anthropicSessionId) {
  const [evRes, sessRes] = await Promise.all([
    fetch(`https://api.anthropic.com/v1/sessions/${anthropicSessionId}/events`, {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": ANTHROPIC_BETA_HEADER,
      },
    }),
    fetch(`https://api.anthropic.com/v1/sessions/${anthropicSessionId}`, {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": ANTHROPIC_BETA_HEADER,
      },
    }),
  ]);
  if (!evRes.ok) throw new Error(`anthropic events ${evRes.status}`);
  if (!sessRes.ok) throw new Error(`anthropic session ${sessRes.status}`);
  const evJson = await evRes.json();
  const sessJson = await sessRes.json();
  return { status: sessJson.status, events: evJson.data ?? [] };
}

// Anthropic events come back as flat objects keyed by `type`. Our
// summarizeEvents expects the local DB shape ({event_type, processed_at,
// payload}). Adapt at the seam.
function normalizeAnthropicEvent(e) {
  return {
    event_type: e.type,
    processed_at: e.processed_at,
    created_at: e.processed_at,
    payload: e,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// UTILS
// ═════════════════════════════════════════════════════════════════════════

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (m[0].trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}
function parseArgs(argv) {
  const flags = {};
  const bool = {};
  const positional = [];
  for (const raw of argv) {
    if (!raw.startsWith("--")) { positional.push(raw); continue; }
    const eq = raw.indexOf("=");
    if (eq === -1) { bool[raw.slice(2)] = true; }
    else { flags[raw.slice(2, eq)] = raw.slice(eq + 1); }
  }
  return { flags, bool, positional };
}
function intArg(name, def) {
  const v = args.flags[name];
  if (v == null) return def;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) fail(`--${name} must be a non-negative integer`);
  return n;
}
function clampInt(v, min, max) { return Math.max(min, Math.min(max, v)); }
function log(s) { process.stdout.write(`${s}\n`); }
function fail(s) { process.stderr.write(`error: ${s}\n`); process.exit(1); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
