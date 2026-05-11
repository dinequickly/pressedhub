# Status

Updated: 2026-05-10

## Recent work

- Image Creator board delete buttons now delete on the first click again: header drag handles skip interactive controls, and the trash button stops the drag-start mousedown from stealing the click.
- Image Creator outside-of-app drops are more reliable again: board drag uploads now read image files from `dataTransfer.items` as well as `files`, reuse the same auth-hydration tolerance as the main API layer, and show an on-canvas failure banner instead of failing silently.
- Image Creator boards now navigate like a real canvas: drag empty board space to pan, and scroll directly on the canvas to zoom around the cursor while keeping item drag positions accurate under scale.
- Image Creator prompt, image, and reference cards on the board canvas now collapse to an image-first resting state: headers and editors become hover/focus overlays so generated/media nodes mostly just show the image until you interact.
- Planned next media-system pass: split canonical Pressed product/library assets from board-local uploads and generated outputs, while keeping both attachable to vibe boards by `media_asset_id`.
- Image Creator board cards are now much more legible: stronger text contrast, clearer metadata grouping, and a boards-overview summary strip on the list page.
- Image Creator board thumbnails now resolve and render the latest real visuals from each board, including prompt-generation outputs stored on prompt cards, instead of showing blank gray quadrants.
- Image Creator thumbnail loading now retries more gracefully during initial auth hydration and fills previews tile-by-tile instead of waiting for the whole grid to succeed at once.
- Chat now shows activity immediately after send via an optimistic `awaiting` bridge instead of waiting for Anthropic's `session.status_running` event.
- Chat reasoning traces are now collapsible disclosure cards instead of always-open italic blocks.
- Chat composer now has a paperclip attachment menu beside the textbox with:
  - attach existing knowledge-base files
  - upload a computer file into the knowledge base and attach it to the active session
- Added a universal built-in agent tool, `set_roster_status`, so agents can explicitly set the sticky-note state shown on `/roster` with structured `tone`, `label`, and `summary`.
- Hub sidebar collapsed width was reduced again so the idle rail takes up less horizontal space while preserving the same expanded width.
- Hub sidebar navigation icons now use a unified black treatment instead of per-section accent colors.
- Started branch `codex/remove-llm-output-ui` for a full UI cleanup pass focused on hiding model internals and improving the product feel.
- Chat, runs, agent detail, sheets helper, and skill builder now suppress raw reasoning / tool-result chatter in favor of cleaner activity summaries and direct user-facing outcomes.
- Agent, skill, environment, profile, and knowledge surfaces now use product language instead of provider jargon, and raw provider ids are hidden from the main UI.
- Shared page chrome, cards, buttons, and inputs were polished with softer depth, cleaner spacing, and a lighter editorial feel across the app.
- Removed the temporary `Working pace` abstraction from the agent UI after follow-up feedback; agent create/edit now no longer expose that extra layer.
- Restored raw reasoning traces in the shared chat stream so users can see full in-flight thinking again across chat-style surfaces.
- The idle live-activity card now drops the generic `Working` heading and shows the rotating juice phrase as the primary line, with a more prominent citrus animation.
- Assistant messages now keep their relative timestamp in the footer beside copy / rerun, and the generic `activity updated` fallback row is removed from the transcript.
- Anthropic agents are now explicitly synced with `thinking.display: "summarized"` so sessions keep readable reasoning traces while still carrying the opaque `signature`, and the chat trace card now renders that signature when present.
- Chat history now lives under the main left-rail `Chat` nav item while in chat mode, and the separate page-level chat sidebar is removed so the transcript surface opens full-width by default.
- The chat rail history is now capped inside a five-row-tall internal scroll box so older sessions stay accessible without stretching the main sidebar.
- The chat page now opens the SSE stream immediately on session open, not only after local status becomes `running`, so early `agent.thinking` events are much less likely to be missed before they are persisted.

## Important implementation notes

- In `frontend/src/apps/image-creator/components/Canvas.tsx`, item-header `onMouseDown` now explicitly ignores nested `button`, `input`, and `textarea` targets; keep that guard when adding more header controls so drag behavior does not eat clicks.
- `frontend/src/apps/image-creator/lib/uploadMedia.ts` now uses a short `supabase.auth.getSession()` timeout fallback and omits an empty `Authorization` header, which matters for board drops and other uploads fired during auth hydration.
- `frontend/src/apps/image-creator/components/Canvas.tsx` now treats `dataTransfer.items` image files as first-class external drops and surfaces upload failures in-canvas so drag/drop regressions are visible instead of silent.
- Board pan/zoom now lives in `frontend/src/apps/image-creator/components/Canvas.tsx` using a scaled inner surface plus a scroll-sized wrapper; cursor-centered wheel zoom updates scroll offsets after scale changes so viewport focus stays stable.
- Hover-only canvas chrome for media-oriented board items now lives in `frontend/src/apps/image-creator/components/Canvas.tsx` via `usesHoverChrome(...)`; headers plus prompt/image editors are now overlay UI for generated/media cards, while note cards still keep their always-on shell.
- Existing building blocks already point the right direction: the board library picker searches `media_assets` by filename and tags, the Director agent has `list_media` plus `attach_media_as_reference`, and board items persist `media_asset_id` references rather than embedding files.
- Board-list preview logic lives in `frontend/src/apps/image-creator/pages/BoardsList.tsx` and now treats `prompt.generations[]` as first-class preview media; if previews look empty again, check generation data before assuming the media endpoint is broken.
- Board-list generated counts are no longer derived only from standalone `image` items; they include prompt-card generation history too.
- `frontend/src/lib/api.ts` now does a short `supabase.auth.getSession()` fallback when the in-memory JWT cache is still empty, which matters most for auth-protected binary endpoints like `/media/:id/content`.
- Manual chat attachments use `POST /functions/v1/sessions/:id/attachments/kb`.
- Successful manual attachments are persisted as `pressed.kb_attached` session events so the Files sidebar can show them after refreshes, not just optimistically.
- Knowledge uploads are now shared through `frontend/src/lib/kb.ts` so the Knowledge page and Chat page use the same upload/extract/chunk/embed/sync pipeline.
- The chat surface is reused across session switches, so ephemeral UI state is explicitly reset on `sessionId` changes.
- Roster cards now prefer the latest `pressed.roster_status_set` event on a session over inferred `latest_message` / `latest_thinking`.
- Agent built-ins are synced at session start via `syncAgentBuiltins(...)`, so older Anthropic agents pick up new platform-native tools without requiring manual no-op edits.
- Slack should point at hosted Supabase edge-function URLs, not the Vercel frontend: OAuth redirect is `/functions/v1/slack-oauth/callback`, Events API is `/functions/v1/slack-events`, and `HUB_BASE_URL` only controls the final browser bounce back into the UI.
- Raw reasoning traces are intentionally visible in shared chat-style transcript surfaces again, but provider ids, model names, and debugging-style tool output should still stay hidden unless a view is explicitly meant for internal diagnostics.
- This app's chat flow already uses Anthropic's Managed Agents session event stream (`/v1/sessions/:id/events/stream`), so there is no separate `stream: true` flag to add on the main chat path; the key knob for visible traces here is the agent `thinking.display` setting.
- `/chat` still auto-selects the most recent session when no `:sessionId` is present, so the rail sublist should treat `/chat` as "open the latest conversation" rather than as an empty landing page.
- Because Anthropic thinking content may only be reliably available on the live stream, the stream-attach timing on `/chat` matters for product behavior, not just perceived latency.

## Verification

- `frontend`: `npm run build`
- `frontend`: `npm run build` after making board-item delete buttons ignore drag-start mousedown
- `frontend`: `npm run build` after fixing external board-drop uploads and surfacing upload failures
- `frontend`: `npm run build` after adding drag-to-pan and wheel zoom to Image Creator boards
- `frontend`: `npm run build` after making Image Creator prompt/image/reference nodes image-first at rest with hover/focus overlays
- `frontend`: `npm run build` after the `codex/remove-llm-output-ui` visual cleanup and de-LLM pass
- `frontend`: `npm run build` after the Image Creator board-card readability and real-thumbnail preview pass
- Hosted Supabase route check: `POST https://hrjrojyjqcyamwfjnyjb.supabase.co/functions/v1/sessions/:id/attachments/kb` now returns `Missing authorization header` when called without auth, which confirms the route is deployed and reachable.

## Deployment

- Deployed `sessions` to linked Supabase project `hrjrojyjqcyamwfjnyjb` on 2026-05-10.
- Deployed updated `agents`, `sessions`, `runs`, and `schedules` functions to linked Supabase project `hrjrojyjqcyamwfjnyjb` on 2026-05-10.

## Repo/process notes

- Desktop check found `/Users/maxwellmoroz/Desktop/GUI/gui/vibes`, but the active project memory docs for this repo are still `status.md` and `vibes.md` in the repo root.
- Vercel should deploy the Vite app from `frontend/`; Supabase remains the host for the backend functions, database, auth, and storage.
- Added `frontend/vercel.json` with an SPA rewrite so React Router deep links do not 404 on Vercel refreshes.
- Attempted to use the Vercel connection plus local CLI for deployment, but this session currently has invalid Vercel auth, so publish itself is blocked until reconnected or re-logged-in.
