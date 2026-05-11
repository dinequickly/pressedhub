# Campaign Stress-Test Harness

Two scripts that together stress-test the Image Creator + Director-agent stack
end-to-end at realistic scale:

- `scripts/simulate-campaigns.mjs` — synthesizes a believable marketing dataset
  (products, multi-channel campaigns, daily metrics, pre-populated vibe
  boards) under a dedicated **harness user**, fully wipeable.
- `scripts/run-campaign-load.mjs` — drives the Director agent against the
  simulated boards with configurable concurrency, measures latency at every
  stage of the agent loop, and writes a structured JSON report.

The harness intentionally targets the **simulated** subset only — `source =
'simulated'` on campaign/metric rows, `tag 'simulated-clone'` on cloned
media_assets, `state.meta_source = 'simulated-board'` on boards — so it
coexists cleanly with `npm run seed-timeline` and `npm run upload-assets`.

---

## Quick start

```bash
# 1. Generate ~20 boards' worth of synthetic campaign data.
npm run simulate-campaigns

# 2. Drive 4 boards in parallel against the Director, with Gemini-fast.
npm run load-test-campaigns -- --concurrent=4 --boards=8 --model=gemini-fast
```

Find your run report in `scripts/.out/run-<timestamp>-<tag>.json`.

---

## simulate-campaigns

```bash
npm run simulate-campaigns -- [flags]
```

### Flags

| flag                          | default                          | description                                                     |
| ----------------------------- | -------------------------------- | --------------------------------------------------------------- |
| `--products N`                | 12                               | Synthetic SKUs to invent (Pressed-flavored vocabulary).         |
| `--campaigns-per-product N`   | 4                                | Campaigns per product across all channels.                      |
| `--boards N`                  | 20                               | Vibe boards to create (one per campaign, cycled).               |
| `--prompts-per-board N`       | 6                                | Prompt cards per board.                                         |
| `--refs-per-board N`          | 2                                | Reference images per board (sampled from cloned media pool).    |
| `--metric-days N`             | 14                               | Daily metric points per campaign.                               |
| `--harness-email <addr>`      | `harness+stress@pressed.test`    | Override harness user email.                                    |
| `--harness-password <pw>`     | _random + cached_                | Force a specific password (otherwise generated + cached).       |
| `--no-wipe`                   | _wipes on each run_              | Skip the destructive cleanup of prior simulated rows.           |

### What it does

1. **Provisions the harness user.** Creates `harness+stress@pressed.test` via
   the GoTrue admin API on first run (or reuses it). Stores its email +
   password in `scripts/.out/harness-credentials.json` for the load runner.
   Promotes to `admin` role.
2. **Wipes prior simulated rows.** Deletes `vibe_boards` owned by the
   harness, `media_assets` tagged `simulated-clone`, and any
   `campaigns/metrics` rows with `source='simulated'`. Other data
   (seed-timeline, real admin's boards, etc.) is untouched.
3. **Generates products + campaigns + metrics.** Cold-press citrus, wellness
   shots, probiotic lemonades, daily greens, wellness smoothies, hydration,
   cleanse sets, limited-edition drops. Each campaign gets a multi-sentence
   brief with cohort + aesthetic + palette metadata, and daily series for
   sessions / revenue / orders / ctr / conversion.
4. **Clones the Pressed media library.** Reads the real `pressed-assets`
   media_assets rows and inserts copies owned by the harness user, pointing
   at the same `storage_path`. The asset bytes aren't duplicated — service
   role can read any storage object regardless of ownership prefix, so the
   agent's `attach_media_as_reference` tool works seamlessly. Cloned rows
   get tag `simulated-clone` for targeted wipe.
5. **Creates boards.** Each board is seeded with a brief note, N reference
   images, and N prompt cards. The cards alternate `model: "gemini-fast"`
   and `model: "gemini-quality"` so a board has a varied baseline.
6. **Writes `scripts/.out/manifest.json`.** Lists every board the load
   runner can target, plus totals.

---

## run-campaign-load

```bash
npm run load-test-campaigns -- [flags]
```

Requires `scripts/.out/manifest.json` from a prior `simulate-campaigns` run.

### Flags

| flag                  | default        | description                                                                        |
| --------------------- | -------------- | ---------------------------------------------------------------------------------- |
| `--concurrent N`      | 1 (max 10)     | Parallel boards in-flight.                                                         |
| `--boards N`          | _all in manifest_ | Limit how many boards to run.                                                   |
| `--model NAME`        | `gemini-fast`  | `gemini-fast` / `gemini-quality` / `openai` (paid).                                |
| `--timeout MS`        | 180000         | Per-board wall-clock cap.                                                          |
| `--poll-ms MS`        | 4000           | Cadence of `/runs/:id` polling + Anthropic events.list fallback.                   |
| `--max-prompts N`     | 3              | How many image directions to ask the agent for in the kickoff message.             |
| `--tag <name>`        | `run`          | Suffix on the output report filename.                                              |
| `--no-dispatch-tools` | _off_          | Disable harness-side custom-tool dispatch (only use to test the edge fn's drain).  |

### Per-board loop

For each board, in a concurrency-bounded worker:

1. `POST /vibe-boards/setup` (idempotent) → `agent_id`, `environment_id`.
2. `POST /sessions` with `initial_message` = a generated kickoff prompt
   tailored to the board's campaign brief.
3. `PATCH /vibe-boards/:id { session_id }` to bind the session to the board
   (otherwise the Director's tool calls can't resolve a board context).
4. **Poll loop** until idle/terminal or timeout:
   - `GET /runs/:id` (local DB events; primary path).
   - Also call Anthropic's `/v1/sessions/:id/events` directly as a fallback,
     because the edge function's background event-refresh path is flaky in
     supabase-local (see below). The Anthropic-direct view is authoritative.
   - If the agent has unanswered `agent.custom_tool_use` events and
     `--no-dispatch-tools` is *not* set, the harness implements `read_board`,
     `update_board`, `list_media`, `attach_media_as_reference`,
     `generate_image_*`, and `prompt_via_card` itself and posts
     `user.custom_tool_result` back so the agent can make progress.

### Metrics captured per board

- `session_created_ms` — wall-clock for `POST /sessions`.
- `first_event_ms` — first time any event was visible (local or Anthropic).
- `ttf_agent_message_ms` — time-to-first `agent.message`.
- `ttf_first_generation_ms` — time-to-first call to
  `generate_image_*` / `prompt_via_card`.
- `finished_ms` — time the agent reached terminal (`idle` after at least one
  observed working transition, or `terminated`).
- `counts.agent_messages`, `tool_uses`, `tool_results`, `generations`,
  `events_total`, `harness_dispatched`.

### Aggregate report

`scripts/.out/run-<timestamp>-<tag>.json` contains:

- `args` — exact flags + values.
- `totals` — boards, succeeded / failed / idle / timeout, total tool
  calls / generations / agent messages, **harness_dispatched** (any non-zero
  here means the local edge fn's background drain didn't keep up).
- `failure_by_stage` — counts by `session-create` / `link-board` / `poll` /
  `agent-stalled` / `timeout`.
- `latencies` — raw sample arrays. The summary print on stdout computes
  p50 / p95 / p99 / max.
- `boards[]` — per-board details.

### Interpreting the numbers

- **`session_create_ms`** at p95 above ~3s under modest concurrency is a
  hint that Anthropic's `/v1/sessions` call (made inside `POST /sessions`)
  is queueing. The local DB insert + kickoff event send is what dominates.
- **`ttf_agent_message_ms`** is the agent's first response. Expect 3–7s
  for the Director's "Sure, let me look at the board…" ack, plus whatever
  the edge runtime adds in queueing.
- **`ttf_first_generation_ms`** is what marketing teams will actually feel.
  20–40s with Gemini-fast is typical; OpenAI's `gpt-image-1` is consistently
  slower (60–120s) and burns credits.
- **`harness_dispatched > 0`** signals the edge fn's
  `drainImageToolCalls` path isn't firing (the local supabase runtime
  doesn't reliably keep `EdgeRuntime.waitUntil` promises alive). In
  production this background path is what the frontend depends on while
  the SSE stream isn't attached. The harness fallback proves the agent
  *can* loop end-to-end; it's not what real users would experience if the
  bg drain was healthy.

---

## Known/expected findings

After running at concurrency 1, 2, 4 against simulated boards (Gemini-fast):

1. **Edge-function bg drain is unreliable in supabase-local.** `/runs/:id`
   reads return the local DB view immediately, then kick off
   `refreshFromAnthropic` + `drainImageToolCalls` via `runInBackground` —
   but in supabase-local, that background promise never seems to complete
   (events stay at 0 even after a fresh `supabase functions serve`). In
   production this likely works because the frontend keeps an SSE stream
   open, which independently persists events. Confirming the bg drain
   actually fires in deployed envs is the next harness milestone.
2. **`pressed.image_dispatch_started` markers can leak.** Look in
   `runs/index.ts:286` (`STALE_MS = 2 * 60 * 1000`). If a dispatch crashes
   mid-call (e.g. an Anthropic Files upload hangs longer than the local fn
   timeout), the in-flight marker persists for 2 minutes before another
   poll retries. With a 4 s polling cadence, that's ~30 wasted polls before
   the agent could possibly recover. **Recommended:** swap the marker check
   for a heartbeat ("started_at" + "last_heartbeat") and bring the recovery
   window down to ~20 s.
3. **`/runs/:id` polls at a fixed 8 s on the frontend; the harness is at
   4 s.** Both are wasteful when the session is fully `idle` and nothing's
   pending. **Recommended:** exponentially back off the poll once the
   server returns `session.status === 'idle' && events.length stable`.
   Saves Anthropic Files.list / sessions.retrieve calls + local DB churn
   on long-lived sessions where the user has stepped away.
4. **The 4 s in-flight marker grace window for kb tools may double-fire
   kb_attach uploads** at concurrency 8+, since a single kb_attach can
   take 6–10 s for medium files. Saw a brief flash of duplicate Anthropic
   file uploads under hand-testing. **Recommended:** lift the kb
   STALE_MS to 90 s to match the realistic upper bound.
5. **Anthropic `agent.custom_tool_use` events come as flat top-level
   events**, not as nested blocks inside `agent.message.content`. Both
   `extractImageToolUses` and `extractKbToolUses` handle the nested form;
   I haven't audited whether they catch the flat form too. Worth a unit
   test.

These are **observations from the run logs**, not necessarily latent bugs
in production. The harness simply makes them easier to spot.

---

## Cleanup

Re-running `npm run simulate-campaigns` wipes prior simulated data first.
To remove the harness user entirely:

```sql
-- Run via supabase psql:
delete from auth.users where email = 'harness+stress@pressed.test';
-- cascades through public.profiles → vibe_boards, media_assets, sessions.
```

And remove the cached credentials:

```bash
rm scripts/.out/harness-credentials.json
```
