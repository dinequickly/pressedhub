# hubbackend

Supabase backend for the workflow / agent hub. Every agent run goes through
Anthropic's **Managed Agents API**; this service owns persistence, auth, RLS,
the workflow graph, memory stores, vault connections, the KB pipeline, the
runs gallery, and the trigger fan-out (webhook / schedule / inbound email).

> Beta header in use: `managed-agents-2026-04-01`. Default model: `claude-opus-4-7`.

---

## Layout

```
supabase/
  config.toml                   # local stack config
  migrations/                   # 14 forward migrations
  seed.sql                      # connectors + KB tags
  functions/
    _shared/                    # anthropic.ts, supabase.ts, auth.ts, schemas.ts, ...
    profiles/                   # /profiles + /profiles/me + bootstrap-admin
    connectors/                 # GET catalog
    workflows/                  # CRUD over Workflow JSON, denormalises nodes/edges
    agents/                     # CRUD + Anthropic agents.create/update/archive
    environments/               # CRUD + Anthropic environments.create/archive
    sessions/                   # start, send-event, interrupt, SSE proxy stream
    skills/                     # CRUD + Anthropic skills.create/upload_version
    vault-connections/          # CRUD + Anthropic vaults + credentials
    mcp-servers/                # CRUD
    memory/                     # stores + docs + tables + query/upsert
    dreams/                     # propose + approve/reject diff
    kb/                         # signed upload, extract, chunk, embed (STUB), search
    apps/                       # CRUD + deploy
    runs/                       # gallery view over sessions + events
    triggers/                   # CRUD over workflow_triggers
    triggers-webhook/           # public token-based fan-out (no JWT)
    triggers-schedule/          # invoked by pg_cron once per minute
    triggers-email-inbound/     # public Postmark/SendGrid inbound shape
    webhooks-anthropic/         # signature-verified webhook receiver
scripts/                        # curl-based smoke tests, one per phase
.env.example                    # all env vars documented
```

## Environment variables

Required:

- `SUPABASE_URL` — base URL of the local or hosted Supabase project
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Anthropic (optional for local dev, required for any agent functionality):

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_WEBHOOK_SIGNING_KEY` — `whsec_…` from Console > Manage > Webhooks
- `ANTHROPIC_BETA_HEADER` — defaults to `managed-agents-2026-04-01`
- `ANTHROPIC_DEFAULT_MODEL` — defaults to `claude-opus-4-7`

Copy `.env.example` to `.env`, fill in `ANTHROPIC_API_KEY`, leave the local
Supabase keys at their defaults.

## Local setup

```bash
# 0. Prereqs
#    - Docker Desktop (or colima) running
#    - Node 18+ (for npx supabase) or install supabase CLI directly
#    - jq in PATH

# 1. Start Supabase locally. First run pulls images, ~5 min.
npx supabase start

# 2. Apply migrations + seeds.
npx supabase db reset

# 3. Generate the database types file referenced by edge functions.
npx supabase gen types typescript --local \
  > supabase/functions/_shared/database.types.ts

# 4. Serve all edge functions with .env.
npx supabase functions serve --env-file .env

# 5. In another shell, run the smoke tests.
bash scripts/smoke-phase-a.sh
bash scripts/smoke-phase-b.sh
bash scripts/smoke-phase-c.sh   # requires ANTHROPIC_API_KEY; otherwise skipped
bash scripts/smoke-phase-d.sh
bash scripts/smoke-phase-e.sh
bash scripts/smoke-phase-f.sh

# Or all at once:
bash scripts/smoke-all.sh
```

## Cloud deploy

```bash
# Link to a hosted project. (Once.)
npx supabase link --project-ref <ref>

# Push migrations and seed.
npx supabase db push
psql "$SUPABASE_DB_URL" -f supabase/seed.sql

# Set secrets the edge functions read.
npx supabase secrets set \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  ANTHROPIC_WEBHOOK_SIGNING_KEY="$ANTHROPIC_WEBHOOK_SIGNING_KEY"

# Deploy every function. supabase reads supabase/functions/<name>/index.ts.
npx supabase functions deploy --use-api

# Wire the cron fan-out: rewrite app_settings to point at the deployed URL.
psql "$SUPABASE_DB_URL" <<SQL
update public.app_settings set value = 'https://<ref>.supabase.co/functions/v1' where key='edge_functions_base_url';
update public.app_settings set value = '$SUPABASE_SERVICE_ROLE_KEY' where key='service_role_key';
SQL
```

In the Anthropic Console (Manage → Webhooks), register
`https://<ref>.supabase.co/functions/v1/webhooks-anthropic` and store the
`whsec_…` value as `ANTHROPIC_WEBHOOK_SIGNING_KEY`.

## API surface

| Function | Path | Method | Description |
| --- | --- | --- | --- |
| profiles | `/profiles/me` | GET / PATCH | The caller's profile |
| profiles | `/profiles` | GET | Admin: list users |
| profiles | `/profiles/bootstrap-admin` | POST | Promote first user |
| profiles | `/profiles/:id/promote` | POST | Admin: promote |
| connectors | `/connectors` | GET | Connector catalog (50 entries) |
| workflows | `/workflows` | GET / POST | List / create |
| workflows | `/workflows/:id` | GET / PATCH / DELETE | |
| agents | `/agents` | GET / POST | List / create (also creates Anthropic agent) |
| agents | `/agents/:id` | GET / PATCH / DELETE | |
| environments | `/environments` | GET / POST | List / create (also creates Anthropic environment) |
| environments | `/environments/:id` | GET / DELETE | |
| sessions | `/sessions` | GET / POST | List / start |
| sessions | `/sessions/:id` | GET / DELETE | |
| sessions | `/sessions/:id/events` | POST | Forward user events to Anthropic |
| sessions | `/sessions/:id/interrupt` | POST | user.interrupt convenience |
| sessions | `/sessions/:id/stream` | GET | SSE proxy + persistence |
| sessions | `/sessions/:id/archive` | POST | Archive |
| skills | `/skills`, `/skills/:id` | CRUD | Anthropic-backed for `type=custom` |
| vault-connections | `/vault-connections`, `/:id`, `/:id/check` | CRUD | Lazy Anthropic vault per user |
| mcp-servers | `/mcp-servers`, `/:id` | CRUD | |
| memory | `/memory/stores`, `/:id`, `/:id/{documents,tables,dreams}` | CRUD | |
| memory | `/memory/query` | POST | Read documents or table rows |
| memory | `/memory/upsert/{document,row}` | POST | Agent write APIs |
| dreams | `/dreams`, `/:id`, `/:id/decide` | List / approve / reject |
| kb | `/kb/folders`, `/files`, `/files/upload-url` | CRUD + signed Storage URLs |
| kb | `/kb/files/:id/{extract,chunk,embed}` | POST | Pipeline stages (embed = STUB) |
| kb | `/kb/search` | POST | Cosine search (text-match in v1) |
| apps | `/apps`, `/:id`, `/:id/deploy` | CRUD + per-user deploy |
| runs | `/runs`, `/runs/:id` | List + detail |
| triggers | `/triggers`, `/:id` | CRUD over workflow_triggers |
| triggers-webhook | `/triggers-webhook/:token` | Public webhook fan-out |
| triggers-schedule | `/triggers-schedule` | Service-role only; pg_cron calls this once a minute |
| triggers-email-inbound | `/triggers-email-inbound` | Public; Postmark/SendGrid inbound shape |
| webhooks-anthropic | `/webhooks-anthropic` | Public; signature-verified |

## Domain shapes (what the frontend posts/expects)

`Workflow`:

```ts
{
  id: string;
  name: string;
  description: string;
  category: "deterministic" | "react" | "multi-agent";
  nodes: WorkflowNode[];     // Trigger | Action | Condition | Agent
  edges: { from, to, label? }[];
  memory_store_id?: string;
}
```

`AgentNode`:

```ts
{
  id: string;
  type: "agent";
  role: string;
  instructions: string;
  tools: string[];
  skills?: string[];
  outcome?: { description, rubric_md, max_iterations? };
  memory_store_id?: string;
}
```

These match `frontend/src/types/workflow.ts` exactly. Rounds-trip is preserved
on `workflows.graph` (jsonb).

## v1 stubs / TODOs

The following are intentionally stubbed so the surface is complete but
delivery cost stays bounded. Each is a single-function replacement when ready:

1. **Embeddings (`supabase/functions/kb/index.ts` `/files/:id/embed`)** — writes
   a zero vector. Replace with a real embedding call (OpenAI
   `text-embedding-3-small`, Voyage, or Anthropic when available) and update
   `kb_search` to use the cosine RPC `public.kb_search` instead of the text
   fallback.
2. **PDF / DOCX extractors (`supabase/functions/kb/index.ts` `/files/:id/extract`)** —
   text-only extractor. Add `pdf-parse` / `mammoth` (npm via
   `https://esm.sh/pdf-parse@1.1.1`) and route by mime.
3. **Vault credential validation (`supabase/functions/vault-connections/index.ts` `/check`)** —
   currently just bumps `last_used_at`. Replace with a call to
   `POST /v1/vaults/:id/credentials/:cid/mcp_oauth_validate` and map
   `valid|invalid|unknown` to our `connection_status`.
4. **Schedule fan-out URL (`supabase/migrations/20260101000013_cron_schedule.sql`)** —
   reads from `public.app_settings`. Fill in the deployed URL + service-role
   key in your deploy script.

## Testing

Smoke tests are the primary form of correctness verification because
edge-function unit tests need a Supabase runtime. Each test runs a real
end-to-end curl flow:

| Phase | What it proves |
| --- | --- |
| A | Sign-up auto-creates a profile, bootstrap-admin promotes, connectors seeded |
| B | Workflow CRUD round-trip including nodes/edges denorm |
| C | Anthropic agent + environment + session + SSE persistence |
| D | Memory upsert/query and dream approve flow |
| E | MCP server registration; skill registration (Anthropic round-trip) |
| F | KB upload-url → extract → chunk → embed → search; app deploy; webhook trigger |

Set `ANTHROPIC_API_KEY` to a real key to run phases C and E. Without it, both
skip cleanly so the rest still passes.

## Anthropic API conventions referenced

- Agents → `POST /v1/agents`. We mint local row + Anthropic agent atomically.
- Environments → `POST /v1/environments`.
- Sessions → `POST /v1/sessions`. We pass `agent` (id string for "latest" or
  `{type:"agent", id, version}` to pin), `environment_id`, optional
  `vault_ids[]`, optional `title`.
- Define outcome → sent as `user.define_outcome` event after session create
  (NOT at session-create time), per
  https://platform.claude.com/docs/en/managed-agents/define-outcomes.
- Events → `POST /v1/sessions/:id/events` with `{events:[{type,...}]}`.
  Stream via `GET /v1/sessions/:id/events/stream`. Open the stream first to
  avoid missing the buffered events.
- Webhooks → `X-Webhook-Signature` verified by SDK. Payload contains only
  `{type, id}`; fetch the resource by ID to get fresh state.
# pressedhub
