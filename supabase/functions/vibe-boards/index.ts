// /functions/v1/vibe-boards
//   GET    /          List the caller's boards.
//   POST   /          Create a new board.
//   GET    /:id       Get one board with state.
//   PATCH  /:id       Update name and/or state. State merges replace items
//                     wholesale — the canvas pushes the full state on save.
//   DELETE /:id       Delete a board.

import { wrap } from "../_shared/cors.ts";
import { Router, readJson } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { BadRequest, NotFound, Upstream, noContent, ok } from "../_shared/errors.ts";
import {
  VibeBoardCreateSchema,
  VibeBoardGenerateSchema,
  VibeBoardPatchSchema,
} from "../_shared/schemas.ts";
import { AnthropicAgents, AnthropicEnvironments, DEFAULT_THINKING_CONFIG } from "../_shared/anthropic.ts";
import { IMAGE_TOOL_DEFS } from "../_shared/image_tools.ts";
import { generateImage } from "../_shared/image_gen.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { ENV } from "../_shared/env.ts";

const DIRECTOR_AGENT_NAME = "Image Studio Director";
const DIRECTOR_SYSTEM_PROMPT = `You are the Director of an Image Creator vibe board — a creative-director assistant for the Pressed marketing team. You work on a shared canvas alongside the user. Your job is to produce ON-BRAND, PRODUCT-ACCURATE imagery — never generic stock-photo juice. Use the user's real brand assets as the source of truth for what their products actually look like.

## The board

Items on the canvas:
  - prompt cards (text the user wrote; may have a model preference + attached references)
  - reference images (style/composition inspiration; user-dropped or you-attached)
  - generated images you've produced (with the prompts that made them)
  - notes (sticky-note annotations)

## Required workflow — run this every task, in this order

**Step 1: Acknowledge.** Reply in chat with ONE sentence stating (a) which product/campaign you're working on, (b) which library asset(s) you'll ground in, (c) which vendor + tier. Example: "Sure — pulling the Tangerine Cold-press 10oz hero from the library and generating 3 directions with Gemini Fast."

**Step 2: Read the board.** Call \`read_board\`. Identify the user's actual ask: product names, campaign brief, channel, tone words.

**Step 3: Ground in the library — MANDATORY for branded products.** If the user mentions ANY specific Pressed product (e.g. "Tangerine Cold-press citrus", "Wellness Smoothie Avocado Greens", a SKU + size), you MUST:
  3a. Call \`list_media\` with a query like \`q="tangerine cold press"\` or \`tag="tangerine-cold-press-citrus"\` to find the actual brand asset.
  3b. Call \`attach_media_as_reference\` on the most fitting asset (prefer "Front 1400x1400" or "Blue" tagged versions when generating hero shots). Place it at \`x=0, y=0\` if you don't have a better idea.
  3c. Pass that asset's anthropic_file_id as a reference attachment to the gen tool. The gen vendor uses references to condition output — this is HOW you get an on-brand product, not a hallucinated one.
  Skip step 3 only if the user's brief is intentionally generic (mood-board exploration with no named product).

**Step 4: Decide vendor + tier.**
  - Default: \`gemini-fast\` (gemini-3.1-flash-image-preview). Cheap, fast.
  - Use \`gemini-quality\` (gemini-3-pro-image-preview) when the user says "hero", "final", "polish", "high quality", or when the result needs to ship.
  - Use \`openai\` (gpt-image-1) when the user explicitly names it OR when the brief needs text-in-image (gpt-image-1 is dramatically better at typography).
  - If the user's prompt card has \`model\` set, honor it.
  - If a gen tool errors out, switch vendors and tell the user.

**Step 5: Generate.** Strongly prefer \`prompt_via_card\` over \`generate_image_*\` direct. The card pattern lets the user iterate — edit the prompt, hit Send, hit ⌘Z to scrub through variants. The direct tool is only for one-shot drops the user explicitly asked for.

When writing the prompt itself:
  - Start with the product (verbatim from library asset name when possible). "Tangerine Cold-press citrus 10oz bottle…"
  - Then composition (hero, lifestyle, flat-lay).
  - Then style cues from references the user pinned + brand conventions.
  - Then mood/palette.
  - Place generations at \`x=320 + N*280\`, \`y=400\` next to the source prompt card. Set \`parent_id\` to the source prompt's id so the variant lineage is preserved.

**Step 6: Summary.** One line per generation explaining the creative direction. "Variant 1 leans editorial — soft light, off-center crop. Variant 2 lifestyle with hand holding bottle. Variant 3 bold graphic with juice splash."

## Anti-patterns — do NOT

  - DO NOT generate a Pressed product without a library reference. The result will have a fake label, wrong color, wrong silhouette. The user has 150+ real brand assets — use them.
  - DO NOT invent product names, sizes, or label text the user didn't reference.
  - DO NOT modify or delete user items. update_board only appends.
  - DO NOT generate without first calling read_board. Even a "quick test" must read context.
  - DO NOT use the direct generate_image_* tools when the user is iterating — use prompt_via_card so they can scrub generations.

## Library lookup hints

The user's media library tags are folder-derived. Examples of what's there:
  - Per-product tags: \`tangerine-cold-press-citrus\`, \`wellness-smoothie-avocado-greens\`, \`wellness-smoothie-strawberry-orange-mango\`, etc.
  - Per-size: \`10oz\`, \`152oz\`
  - Per-asset-type: \`front-1400x1400\`, \`back-1400x1400\`, \`blue\`, \`flat\`
  - Global: \`pressed-assets\`

If list_media returns nothing for a specific product name, fall back to a broader \`q\` search ("citrus", "smoothie") and pick the most fitting one. If still nothing, tell the user the asset isn't in the library and proceed without a reference (only as a last resort).

## Tone

Be concise. The canvas does the talking. One sentence acks. One sentence per variant. Avoid hedging.`;

async function ensureDefaultEnvironment(
  userDb: ReturnType<typeof requireUser> extends Promise<infer U> ? (U extends { db: infer D } ? D : never) : never,
): Promise<{ id: string; anthropic_id: string }> {
  // deno-lint-ignore no-explicit-any
  const db = userDb as any;
  const { data: existing } = await db
    .from("environments")
    .select("id,anthropic_id")
    .not("anthropic_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing?.anthropic_id) return existing as { id: string; anthropic_id: string };
  // Create a default environment if none exist. Mirrors the agents UX.
  const created = await AnthropicEnvironments.create({ name: "Default" });
  const { data: row, error } = await db
    .from("environments")
    .insert({ name: "Default", anthropic_id: created.id, config: created.config ?? {} })
    .select("id,anthropic_id")
    .single();
  if (error) throw new BadRequest(error.message);
  return row as { id: string; anthropic_id: string };
}

const router = new Router("vibe-boards");

router.get("/", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("vibe_boards")
    .select("id,name,state,session_id,created_at,updated_at")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.post("/", async (req) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const parsed = VibeBoardCreateSchema.parse(body ?? {});
  const { data, error } = await user.db
    .from("vibe_boards")
    .insert({
      owner_id: user.id,
      name: parsed.name ?? "Untitled board",
      state: parsed.state ?? { items: [] },
    })
    .select("id,name,state,session_id,created_at,updated_at")
    .single();
  if (error) throw new BadRequest(error.message);
  return ok(data, 201);
});

router.get("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("vibe_boards")
    .select("id,name,state,session_id,created_at,updated_at")
    .eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Board not found");
  return ok(data);
});

router.patch("/:id", async (req, params) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const parsed = VibeBoardPatchSchema.parse(body ?? {});
  if (parsed.name === undefined && parsed.state === undefined && parsed.session_id === undefined) {
    throw new BadRequest("Provide at least one of: name, state, session_id");
  }
  const patch: Record<string, unknown> = {};
  if (parsed.name !== undefined) patch.name = parsed.name;
  if (parsed.state !== undefined) patch.state = parsed.state;
  if (parsed.session_id !== undefined) patch.session_id = parsed.session_id;
  const { data, error } = await user.db
    .from("vibe_boards")
    .update(patch)
    .eq("id", params.id)
    .select("id,name,state,session_id,created_at,updated_at")
    .maybeSingle();
  if (error) throw new BadRequest(error.message);
  if (!data) throw new NotFound("Board not found");
  return ok(data);
});

router.delete("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { error } = await user.db.from("vibe_boards").delete().eq("id", params.id);
  if (error) throw new BadRequest(error.message);
  return noContent();
});

// Idempotent setup. Creates the Director agent + a default environment if
// they don't already exist, and returns the agent + environment ids the
// frontend uses to start sessions.
router.post("/setup", async (req) => {
  const user = await requireUser(req);
  if (!ENV.ANTHROPIC_API_KEY) throw new Upstream("ANTHROPIC_API_KEY missing");

  // Director agent — find or create.
  const { data: existing } = await user.db
    .from("agents")
    .select("*")
    .eq("name", DIRECTOR_AGENT_NAME)
    .is("archived_at", null)
    .maybeSingle();

  const wantedTools = [
    { type: "agent_toolset_20260401" },
    ...IMAGE_TOOL_DEFS,
  ];

  let agentRow = existing;
  if (agentRow && agentRow.anthropic_id) {
    // Sync the system prompt + tools so updates here propagate without
    // forcing the user to delete + recreate the agent.
    const promptStale = (agentRow.system_prompt as string) !== DIRECTOR_SYSTEM_PROMPT;
    if (promptStale) {
      try {
        const updated = await AnthropicAgents.update(agentRow.anthropic_id as string, {
          version: agentRow.anthropic_version as number,
          system: DIRECTOR_SYSTEM_PROMPT,
          thinking: DEFAULT_THINKING_CONFIG,
          tools: wantedTools,
        });
        const { data: row } = await user.db
          .from("agents")
          .update({
            system_prompt: DIRECTOR_SYSTEM_PROMPT,
            tools: wantedTools,
            anthropic_version: updated.version ?? agentRow.anthropic_version,
          })
          .eq("id", agentRow.id)
          .select("*")
          .single();
        if (row) agentRow = row;
      } catch (err) {
        // Non-fatal — return the existing row so setup remains unblocking.
        console.warn("[vibe-boards] director sync failed:", (err as Error).message);
      }
    }
  }
  if (!agentRow) {
    const created = await AnthropicAgents.create({
      name: DIRECTOR_AGENT_NAME,
      model: ENV.ANTHROPIC_DEFAULT_MODEL,
      system: DIRECTOR_SYSTEM_PROMPT,
      thinking: DEFAULT_THINKING_CONFIG,
      // Agent toolset (file/bash/text editor + Claude defaults) plus our
      // image tools. The /agents create path also injects KB tools, but here
      // we go directly to AnthropicAgents.create so we explicitly include
      // both. Duplicates are filtered out on the local insert by name.
      tools: wantedTools,
      mcp_servers: [],
      skills: [],
    });
    const { data: row, error } = await user.db
      .from("agents")
      .insert({
        anthropic_id: created.id,
        anthropic_version: created.version ?? 1,
        name: DIRECTOR_AGENT_NAME,
        role: "Image Director",
        emoji: "🎨",
        accent: "fuchsia",
        model: ENV.ANTHROPIC_DEFAULT_MODEL,
        system_prompt: DIRECTOR_SYSTEM_PROMPT,
        instructions: "",
        tools: wantedTools,
        skills: [],
        mcp_servers: [],
        outcome: null,
        brain: [],
        default_resources: { kb_file_ids: [], memory_store_ids: [] },
        created_by: user.id,
      })
      .select("*")
      .single();
    if (error) throw new BadRequest(error.message);
    agentRow = row;
  }

  // Default environment — find or create.
  const env = await ensureDefaultEnvironment(user.db);

  return ok({ agent: agentRow, environment: env });
});

// Inline image gen from a prompt card. Renders via the chosen vendor, stores
// each blob in the user's media bucket, inserts a media_assets row, and
// returns Generation refs the canvas hangs off the prompt item. Distinct from
// the agent's tool path: no Anthropic Files upload, no chat involvement.
router.post("/:id/generate", async (req, params) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const parsed = VibeBoardGenerateSchema.parse(body ?? {});

  const { data: board, error: bErr } = await user.db
    .from("vibe_boards")
    .select("id,owner_id")
    .eq("id", params.id)
    .maybeSingle();
  if (bErr) throw new BadRequest(bErr.message);
  if (!board) throw new NotFound("Board not found");

  // Resolve attachment ids to blob references the gen vendor can read.
  const sc = serviceClient();
  const references: Blob[] = [];
  for (const attachmentId of parsed.attachments ?? []) {
    const { data: asset, error } = await sc
      .from("media_assets")
      .select("id,owner_id,storage_path,mime")
      .eq("id", attachmentId)
      .maybeSingle();
    if (error || !asset) {
      throw new BadRequest(`Attachment ${attachmentId} not found`);
    }
    if (asset.owner_id !== board.owner_id) {
      throw new BadRequest("Attachment does not belong to this board's owner");
    }
    const { data: blob, error: dlErr } = await sc.storage
      .from("media").download(asset.storage_path as string);
    if (dlErr || !blob) {
      throw new Upstream(`Storage download failed: ${dlErr?.message ?? "missing"}`);
    }
    references.push(new Blob([await blob.arrayBuffer()], { type: asset.mime || "image/png" }));
  }

  const blobs = await generateImage(parsed.model, parsed.prompt, {
    n: parsed.n ?? 1,
    references: references.length > 0 ? references : undefined,
  });

  const ts = Date.now();
  const generations: Array<{
    id: string;
    media_asset_id: string;
    model: typeof parsed.model;
    generated_at: string;
  }> = [];

  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i];
    const ext = blob.type.includes("jpeg") ? "jpg" : "png";
    const name = `gen_${ts}_${i}.${ext}`;
    const assetId = crypto.randomUUID();
    const storagePath = `users/${board.owner_id}/${assetId}/${name}`;

    const { error: upErr } = await sc.storage
      .from("media")
      .upload(storagePath, await blob.arrayBuffer(), { contentType: blob.type, upsert: true });
    if (upErr) throw new Upstream(`Storage upload failed: ${upErr.message}`);

    const { data: row, error: insErr } = await sc
      .from("media_assets")
      .insert({
        id: assetId,
        owner_id: board.owner_id,
        name,
        storage_path: storagePath,
        mime: blob.type || "image/png",
        size_bytes: blob.size,
        source_kind: "board_generated",
        collection_key: "board-generated",
        board_id: board.id,
        status: "ready",
        tags: ["board-generated"],
      })
      .select("id")
      .single();
    if (insErr) throw new BadRequest(insErr.message);

    generations.push({
      id: `gen_${crypto.randomUUID()}`,
      media_asset_id: row.id as string,
      model: parsed.model,
      generated_at: new Date().toISOString(),
    });
  }

  return ok({ generations });
});

Deno.serve(wrap((req) => router.handle(req)));
