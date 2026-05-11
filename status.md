# Status

Updated: 2026-05-10

## Recent work

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

## Important implementation notes

- Manual chat attachments use `POST /functions/v1/sessions/:id/attachments/kb`.
- Successful manual attachments are persisted as `pressed.kb_attached` session events so the Files sidebar can show them after refreshes, not just optimistically.
- Knowledge uploads are now shared through `frontend/src/lib/kb.ts` so the Knowledge page and Chat page use the same upload/extract/chunk/embed/sync pipeline.
- The chat surface is reused across session switches, so ephemeral UI state is explicitly reset on `sessionId` changes.
- Roster cards now prefer the latest `pressed.roster_status_set` event on a session over inferred `latest_message` / `latest_thinking`.
- Agent built-ins are synced at session start via `syncAgentBuiltins(...)`, so older Anthropic agents pick up new platform-native tools without requiring manual no-op edits.
- Slack should point at hosted Supabase edge-function URLs, not the Vercel frontend: OAuth redirect is `/functions/v1/slack-oauth/callback`, Events API is `/functions/v1/slack-events`, and `HUB_BASE_URL` only controls the final browser bounce back into the UI.
- New frontend rule: do not surface raw reasoning traces, provider ids, model names, or debugging-style tool output in user-facing product surfaces unless a view is explicitly meant for internal diagnostics.

## Verification

- `frontend`: `npm run build`
- `frontend`: `npm run build` after the `codex/remove-llm-output-ui` visual cleanup and de-LLM pass
- Hosted Supabase route check: `POST https://hrjrojyjqcyamwfjnyjb.supabase.co/functions/v1/sessions/:id/attachments/kb` now returns `Missing authorization header` when called without auth, which confirms the route is deployed and reachable.

## Deployment

- Deployed `sessions` to linked Supabase project `hrjrojyjqcyamwfjnyjb` on 2026-05-10.
- Deployed updated `agents`, `sessions`, `runs`, and `schedules` functions to linked Supabase project `hrjrojyjqcyamwfjnyjb` on 2026-05-10.

## Repo/process notes

- No Desktop `vibes` folder was present when checked, so project memory docs are currently tracked in this repo root.
- Vercel should deploy the Vite app from `frontend/`; Supabase remains the host for the backend functions, database, auth, and storage.
- Added `frontend/vercel.json` with an SPA rewrite so React Router deep links do not 404 on Vercel refreshes.
- Attempted to use the Vercel connection plus local CLI for deployment, but this session currently has invalid Vercel auth, so publish itself is blocked until reconnected or re-logged-in.
