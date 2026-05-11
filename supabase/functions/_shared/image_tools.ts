// Image Studio tools — custom tools the Director agent calls to read the
// active vibe board, append new items, and generate images via OpenAI or
// Gemini. Dispatch follows the same shape as kb_tools.ts: extract tool_use
// refs from the SSE stream, run them server-side, post the result back as a
// user.custom_tool_result event.
//
// Scoping:
//   - Each tool runs in the context of an Anthropic session id. We resolve
//     that to a local sessions row, then to the vibe_boards row whose
//     session_id matches. That's the active board.
//   - Image gen results are uploaded to Anthropic Files with scope_id =
//     anthropic session id, so the existing /sessions/:id/files/:fileId
//     proxy can serve them to the canvas with the right access checks.

import { AnthropicFiles, AnthropicSessionEvents } from "./anthropic.ts";
import { ENV } from "./env.ts";
import { generateGemini, generateImage, generateOpenAI } from "./image_gen.ts";
import type { ImageGenModel } from "./image_gen.ts";
import { serviceClient } from "./supabase.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export const IMAGE_TOOL_NAMES = [
  "read_board",
  "update_board",
  "generate_image_openai",
  "generate_image_gemini",
  "list_media",
  "attach_media_as_reference",
  "prompt_via_card",
] as const;
export type ImageToolName = typeof IMAGE_TOOL_NAMES[number];

export const IMAGE_TOOL_DEFS: Array<Record<string, unknown>> = [
  {
    type: "custom",
    name: "read_board",
    description:
      "Read the active vibe board. Returns the full list of items currently on the canvas: prompts the user wrote, reference images they dragged in, generated images already on the board, and notes. Use this at the start of any image task to understand the user's intent and existing direction. The result includes Anthropic file_ids for any images so you can vision-read them in a follow-up message if you want to assess style.",
    input_schema: { type: "object", properties: {} },
  },
  {
    type: "custom",
    name: "update_board",
    description:
      "Append items to the active vibe board. The canvas updates live for the user. Use this immediately after generating images, so they appear next to the source prompt or parent image. You can also append a note item to leave annotations the user (and future you) will see. This tool only ADDS items — it never modifies or deletes existing ones, to avoid stepping on the user's edits.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Items to append. Each gets a fresh id.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["image", "prompt", "reference", "note"],
                description: "Item type.",
              },
              x: { type: "number", description: "Canvas x in pixels (0..3200)." },
              y: { type: "number", description: "Canvas y in pixels (0..2000)." },
              anthropic_file_id: {
                type: "string",
                description: "For 'image' or 'reference' items: the file_id returned by an image gen tool.",
              },
              prompt: {
                type: "string",
                description: "For 'image' items: the prompt text that produced this image. Required so the user understands provenance.",
              },
              parent_id: {
                type: "string",
                description: "Optional id of the prompt/image this was spawned from — enables variant lineage.",
              },
              text: {
                type: "string",
                description: "For 'note' or 'prompt' items: the text body.",
              },
              caption: {
                type: "string",
                description: "Optional caption for image/reference items.",
              },
            },
            required: ["type", "x", "y"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    type: "custom",
    name: "generate_image_openai",
    description:
      "Generate one or more images via OpenAI's image model (gpt-image-1). Use for photorealistic and editorial-style imagery. Returns Anthropic file_ids the canvas can render. After this returns, call update_board to drop the images on the canvas.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed image prompt." },
        n: {
          type: "integer",
          description: "Number of variants (1..4). Default 1.",
          minimum: 1,
          maximum: 4,
        },
        size: {
          type: "string",
          enum: ["1024x1024", "1024x1536", "1536x1024", "auto"],
          description: "Image dimensions. Default auto.",
        },
        quality: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Render quality. Default medium.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    type: "custom",
    name: "generate_image_gemini",
    description:
      "Generate one or more images via Google's Gemini image model (gemini-2.5-flash-image-preview). Use as an alternative to OpenAI when you want a different aesthetic. Returns Anthropic file_ids. After this returns, call update_board to drop the images on the canvas.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed image prompt." },
        n: {
          type: "integer",
          description: "Number of variants (1..4). Default 1.",
          minimum: 1,
          maximum: 4,
        },
      },
      required: ["prompt"],
    },
  },
  {
    type: "custom",
    name: "list_media",
    description:
      "List the user's media library assets (separate from the KB). Supports canonical Pressed library imagery, board uploads, and generated outputs. Filter by tag, source_kind, product_key, shot_key, or a filename search string. Returns metadata + media_id you can pass to attach_media_as_reference. Use this whenever the user asks for brand assets, product shots, references, or prior generated imagery.",
    input_schema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Filter to assets carrying this tag." },
        source_kind: {
          type: "string",
          enum: ["pressed_library", "board_upload", "board_generated"],
          description: "Filter by asset class.",
        },
        product_key: { type: "string", description: "Filter canonical assets to one product family." },
        shot_key: { type: "string", description: "Filter canonical assets to one shot type like front, back, blue-shot, or lifestyle." },
        q: { type: "string", description: "Search filename for this substring (case-insensitive)." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max results, default 50." },
      },
    },
  },
  {
    type: "custom",
    name: "prompt_via_card",
    description:
      "Create a prompt card on the active vibe board with the given prompt text and model, then generate one image from it. The card and its first generation appear on the canvas immediately. Prefer this over generate_image_openai/gemini when you want the user to be able to iterate on the prompt themselves — the prompt is editable, additional generations can be cycled with arrows, and it integrates into the user's flow. Pass attachment_media_ids to condition the generation on reference images (e.g. a Pressed library product shot) — they appear as reference chips on the card so the user sees exactly what was used.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image prompt text." },
        model: {
          type: "string",
          enum: ["openai", "gemini-fast", "gemini-quality"],
          description: "Vendor + tier. Default 'gemini-fast'.",
        },
        attachment_media_ids: {
          type: "array",
          items: { type: "string" },
          description: "media_asset ids to attach as reference images. The gen vendor sees these as conditioning inputs. Use this to ground generations in Pressed library product shots — pass the id(s) from list_media here instead of calling attach_media_as_reference separately.",
        },
        x: { type: "number", description: "Canvas x in pixels (default 600)." },
        y: { type: "number", description: "Canvas y in pixels (default 400)." },
        parent_id: {
          type: "string",
          description: "Optional id of parent prompt/image — enables variant lineage.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    type: "custom",
    name: "attach_media_as_reference",
    description:
      "Attach a media asset to the active vibe board as a 'reference' item. Lazy-uploads the asset to Anthropic Files on first use so you can vision-read it on a later turn. After this returns, the canvas will show the asset as a reference card and read_board will include it. Use this when the user wants you to ground a generation in a specific brand asset.",
    input_schema: {
      type: "object",
      properties: {
        media_id: { type: "string", description: "id from list_media." },
        x: { type: "number", description: "Canvas x in pixels (0..3200). Default near-center." },
        y: { type: "number", description: "Canvas y in pixels (0..2000). Default near-center." },
        caption: { type: "string", description: "Optional caption to display under the reference." },
      },
      required: ["media_id"],
    },
  },
];

export type ImageToolUseRef = {
  tool_use_id: string;
  name: ImageToolName;
  input: Record<string, unknown>;
};

export function extractImageToolUses(payload: unknown): ImageToolUseRef[] {
  const out: ImageToolUseRef[] = [];
  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const t = obj.type;
    const name = obj.name;
    if (
      typeof t === "string" &&
      (t === "tool_use" || t === "agent.tool_use") &&
      typeof name === "string" &&
      (IMAGE_TOOL_NAMES as readonly string[]).includes(name)
    ) {
      const id = (obj.tool_use_id ?? obj.id) as string | undefined;
      if (id) {
        out.push({
          tool_use_id: id,
          name: name as ImageToolName,
          input: (obj.input as Record<string, unknown>) ?? {},
        });
      }
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(payload);
  return out;
}

export type ImageToolCtx = {
  userDb: SupabaseClient;
  userId: string;
  anthropicSessionId: string;
};

// Tool result. Either a plain string (most tools) or an array of content
// blocks (multimodal tools like read_board). The dispatcher caller decides
// how to forward to Anthropic.
export type ImageToolResult =
  | { kind: "text"; text: string }
  | { kind: "blocks"; blocks: Array<Record<string, unknown>> };

export async function dispatchImageTool(
  ref: ImageToolUseRef,
  ctx: ImageToolCtx,
): Promise<ImageToolResult> {
  try {
    if (ref.name === "read_board") {
      const blocks = await runReadBoardMultimodal(ctx);
      return { kind: "blocks", blocks };
    }
    if (ref.name === "update_board") return text(await runUpdateBoard(ctx, ref.input));
    if (ref.name === "generate_image_openai") return text(await runGenerateOpenAI(ctx, ref.input));
    if (ref.name === "generate_image_gemini") return text(await runGenerateGemini(ctx, ref.input));
    if (ref.name === "list_media") return text(await runListMedia(ctx, ref.input));
    if (ref.name === "attach_media_as_reference") return text(await runAttachMedia(ctx, ref.input));
    if (ref.name === "prompt_via_card") return text(await runPromptViaCard(ctx, ref.input));
    return text(`[ERROR] Unknown image tool: ${ref.name}`);
  } catch (err) {
    console.warn(`[image_tools] ${ref.name} failed:`, err);
    return text(`[ERROR] ${(err as Error).message}`);
  }
}

function text(s: string): ImageToolResult { return { kind: "text", text: s }; }

// Suppress "unused" lint warning — runReadBoard is kept for parity / debugging.
void runReadBoard;

// Resolve the local session + board for the current Anthropic session id.
// The board is the row whose session_id matches the local sessions row.
async function resolveBoard(ctx: ImageToolCtx): Promise<{
  sessionId: string;
  boardId: string;
  ownerId: string;
  state: { items: unknown[] };
}> {
  const sc = serviceClient();
  const { data: sess, error: sessErr } = await sc
    .from("sessions")
    .select("id,started_by")
    .eq("anthropic_id", ctx.anthropicSessionId)
    .maybeSingle();
  if (sessErr) throw new Error(sessErr.message);
  if (!sess) throw new Error("Session row not found for the current Anthropic session");

  const { data: board, error: bErr } = await sc
    .from("vibe_boards")
    .select("id,owner_id,state")
    .eq("session_id", sess.id)
    .maybeSingle();
  if (bErr) throw new Error(bErr.message);
  if (!board) {
    throw new Error(
      "No vibe board is bound to this session. The Director agent should only be invoked through the Image Creator app.",
    );
  }
  return {
    sessionId: sess.id,
    boardId: board.id,
    ownerId: board.owner_id as string,
    state: (board.state as { items: unknown[] }) ?? { items: [] },
  };
}

// read_board returns a structured TEXT summary by default. The fancy
// multimodal variant — returning the actual image content blocks so the
// agent can vision-read every reference and prior generation in-line — is
// produced by runReadBoardMultimodal which the dispatcher prefers when the
// caller can deliver multimodal tool_results.
async function runReadBoard(ctx: ImageToolCtx): Promise<string> {
  const { boardId, state } = await resolveBoard(ctx);
  return JSON.stringify({
    board_id: boardId,
    items: state.items ?? [],
    note:
      "Each item has an id, type, position (x,y), and type-specific fields. " +
      "Image and reference items reference Anthropic files via anthropic_file_id; " +
      "you can vision-read those by including them as content blocks in your reply.",
  });
}

// Multimodal variant — returns content blocks that include actual image
// bytes alongside the structured summary. Anthropic's user.custom_tool_result
// supports an array of blocks, so the agent receives a multimodal payload
// and can reason about pixels, color, composition, etc. on the next turn.
//
// Cap visual references to bound the per-call cost (each image_block adds
// to the agent's context). The blocks are file_id references — Anthropic
// resolves them server-side, so we don't have to download + base64-encode
// the bytes through our edge function (which was timing out the local
// runtime under load).
export async function runReadBoardMultimodal(
  ctx: ImageToolCtx,
): Promise<Array<Record<string, unknown>>> {
  const { boardId, state } = await resolveBoard(ctx);
  const items = (state.items ?? []) as Array<Record<string, unknown>>;
  const visualItems = items
    .filter((it) => (it.type === "image" || it.type === "reference") && typeof it.anthropic_file_id === "string")
    .slice(-8);

  const blocks: Array<Record<string, unknown>> = [];
  blocks.push({
    type: "text",
    text:
      `Board ${boardId} — ${items.length} item(s).\n` +
      `Below: structured summary then ${visualItems.length} image(s) you can see.\n\n` +
      JSON.stringify({ items }),
  });
  for (const it of visualItems) {
    const fileId = it.anthropic_file_id as string;
    const caption = (it.prompt as string) ?? (it.caption as string) ?? `${it.type} ${it.id}`;
    blocks.push({ type: "text", text: `↓ ${it.type} ${it.id}: ${caption}` });
    blocks.push({
      type: "image",
      source: { type: "file", file_id: fileId },
    });
  }
  return blocks;
}

async function runUpdateBoard(
  ctx: ImageToolCtx,
  input: Record<string, unknown>,
): Promise<string> {
  const itemsIn = Array.isArray(input.items) ? (input.items as Array<Record<string, unknown>>) : [];
  if (itemsIn.length === 0) throw new Error("items must be a non-empty array");

  const { boardId, state } = await resolveBoard(ctx);
  const existing = Array.isArray(state.items) ? state.items : [];
  const fresh = itemsIn.map((it) => ({
    id: `it_${Math.random().toString(36).slice(2, 10)}`,
    ...it,
  }));
  const next = { ...state, items: [...existing, ...fresh] };

  const { error } = await serviceClient()
    .from("vibe_boards")
    .update({ state: next })
    .eq("id", boardId);
  if (error) throw new Error(error.message);

  return JSON.stringify({
    appended: fresh.length,
    item_ids: fresh.map((f) => f.id),
  });
}

// -- Image generation ----------------------------------------------------

type GenInput = { prompt: string; n: number };

function parseGenInput(input: Record<string, unknown>): GenInput {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required");
  const n = clampInt(input.n, 1, 1, 4);
  return { prompt, n };
}

async function runGenerateOpenAI(
  ctx: ImageToolCtx,
  input: Record<string, unknown>,
): Promise<string> {
  if (!ENV.OPENAI_API_KEY) {
    return JSON.stringify({
      error:
        "OPENAI_API_KEY is not configured. Tell the user to set it via `supabase secrets set OPENAI_API_KEY=...`.",
    });
  }
  const { prompt, n } = parseGenInput(input);
  const size = typeof input.size === "string" ? input.size : "auto";
  const quality = typeof input.quality === "string" ? input.quality : "medium";

  const blobs = await generateOpenAI(prompt, { n, size, quality });
  const file_ids: string[] = [];
  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i];
    const filename = `openai_${Date.now()}_${i}.${blob.type.includes("jpeg") ? "jpg" : "png"}`;
    const uploaded = await AnthropicFiles.upload(blob, filename, "agent", ctx.anthropicSessionId);
    file_ids.push(uploaded.id);
  }
  return JSON.stringify({
    file_ids,
    note:
      "Now call update_board with image items referencing these file_ids " +
      "so the user sees them on the canvas. Include the prompt on each.",
  });
}

async function runGenerateGemini(
  ctx: ImageToolCtx,
  input: Record<string, unknown>,
): Promise<string> {
  if (!ENV.GEMINI_API_KEY) {
    return JSON.stringify({
      error:
        "GEMINI_API_KEY is not configured. Tell the user to set it via `supabase secrets set GEMINI_API_KEY=...`.",
    });
  }
  const { prompt, n } = parseGenInput(input);
  const blobs = await generateGemini(prompt, { n });
  const file_ids: string[] = [];
  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i];
    const filename = `gemini_${Date.now()}_${i}.${blob.type.includes("jpeg") ? "jpg" : "png"}`;
    const uploaded = await AnthropicFiles.upload(blob, filename, "agent", ctx.anthropicSessionId);
    file_ids.push(uploaded.id);
  }
  return JSON.stringify({
    file_ids,
    note:
      "Now call update_board with image items referencing these file_ids " +
      "so the user sees them on the canvas. Include the prompt on each.",
  });
}

// -- Media library -------------------------------------------------------

async function runListMedia(
  ctx: ImageToolCtx,
  input: Record<string, unknown>,
): Promise<string> {
  const tag = typeof input.tag === "string" ? input.tag : null;
  const sourceKind = typeof input.source_kind === "string" ? input.source_kind : null;
  const productKey = typeof input.product_key === "string" ? input.product_key : null;
  const shotKey = typeof input.shot_key === "string" ? input.shot_key : null;
  const q = typeof input.q === "string" ? input.q : null;
  const limit = clampInt(input.limit, 50, 1, 200);

  // Resolve via the board → owner so RLS gives us the right rows.
  const { ownerId } = await resolveBoard(ctx);
  const sc = serviceClient();
  let query = sc
    .from("media_assets")
    .select("id,name,mime,size_bytes,width,height,tags,anthropic_file_id,source_kind,collection_key,product_key,shot_key,status,created_at")
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (tag) query = query.contains("tags", [tag]);
  if (sourceKind) query = query.eq("source_kind", sourceKind);
  if (productKey) query = query.eq("product_key", productKey);
  if (shotKey) query = query.eq("shot_key", shotKey);
  if (q) query = query.ilike("name", `%${q}%`);
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return JSON.stringify({
    assets: (data ?? []).map((a) => ({
      media_id: a.id,
      name: a.name,
      mime: a.mime,
      size_bytes: a.size_bytes,
      width: a.width,
      height: a.height,
      tags: a.tags ?? [],
      source_kind: a.source_kind,
      collection_key: a.collection_key ?? null,
      product_key: a.product_key ?? null,
      shot_key: a.shot_key ?? null,
      status: a.status,
      // Note: anthropic_file_id may be null until first attach.
      anthropic_file_id: a.anthropic_file_id ?? null,
    })),
    note:
      "Call attach_media_as_reference(media_id) to drop one of these onto the canvas as a reference. " +
      "Once attached the asset is uploaded to Anthropic Files (cached) and you can vision-read it.",
  });
}

async function runAttachMedia(
  ctx: ImageToolCtx,
  input: Record<string, unknown>,
): Promise<string> {
  const mediaId = typeof input.media_id === "string" ? input.media_id : "";
  if (!mediaId) throw new Error("media_id is required");
  const x = typeof input.x === "number" ? input.x : 1200;
  const y = typeof input.y === "number" ? input.y : 600;
  const caption = typeof input.caption === "string" ? input.caption : undefined;

  const { boardId, state, ownerId } = await resolveBoard(ctx);

  const sc = serviceClient();
  const { data: asset, error } = await sc
    .from("media_assets")
    .select("id,name,storage_path,mime,anthropic_file_id,owner_id,source_kind,product_key,shot_key")
    .eq("id", mediaId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!asset) throw new Error(`Media asset ${mediaId} not found`);
  if (asset.owner_id !== ownerId) {
    throw new Error("Media asset does not belong to this board's owner");
  }

  // Lazy-upload to Anthropic Files (scoped to this session) on first attach.
  let aid = asset.anthropic_file_id as string | null;
  if (!aid) {
    const { data: blob, error: dlErr } = await sc.storage
      .from("media")
      .download(asset.storage_path as string);
    if (dlErr || !blob) throw new Error(`Storage download failed: ${dlErr?.message ?? "missing"}`);
    const uploaded = await AnthropicFiles.upload(
      blob,
      asset.name as string,
      "agent",
      ctx.anthropicSessionId,
    );
    aid = uploaded.id;
    await sc.from("media_assets").update({ anthropic_file_id: aid }).eq("id", mediaId);
  }

  // Append a reference item to the board.
  const newItem = {
    id: `it_${Math.random().toString(36).slice(2, 10)}`,
    type: "reference",
    x, y,
    anthropic_file_id: aid,
    media_asset_id: mediaId,
    caption: caption ?? asset.name,
    name: asset.name,
  };
  const items = Array.isArray(state.items) ? state.items : [];
  const next = { ...state, items: [...items, newItem] };
  const { error: upErr } = await sc.from("vibe_boards").update({ state: next }).eq("id", boardId);
  if (upErr) throw new Error(upErr.message);

  return JSON.stringify({
    attached: true,
    item_id: newItem.id,
    anthropic_file_id: aid,
    media_asset_id: mediaId,
    name: asset.name,
  });
}

// -- prompt_via_card -----------------------------------------------------
//
// Create a prompt card on the active vibe board with the given text + model,
// generate one image, and attach it to the card as the first Generation.
// This mirrors the user-driven Send flow on a prompt card so the agent's
// output integrates seamlessly with the user's iteration loop.
async function runPromptViaCard(
  ctx: ImageToolCtx,
  input: Record<string, unknown>,
): Promise<string> {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required");
  const modelIn = typeof input.model === "string" ? input.model : "gemini-fast";
  const allowedModels = ["openai", "gemini-fast", "gemini-quality"] as const;
  const model: ImageGenModel =
    (allowedModels as readonly string[]).includes(modelIn)
      ? (modelIn as ImageGenModel)
      : "gemini-fast";
  const x = typeof input.x === "number" ? input.x : 600;
  const y = typeof input.y === "number" ? input.y : 400;
  const parentId = typeof input.parent_id === "string" ? input.parent_id : undefined;
  const attachmentMediaIds = Array.isArray(input.attachment_media_ids)
    ? (input.attachment_media_ids as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

  const { boardId, ownerId, state } = await resolveBoard(ctx);
  const sc = serviceClient();

  // Resolve attachment ids → blobs for conditioning the gen vendor, and
  // build the attachments array that appears as reference chips on the card.
  type CardAttachment = { id: string; media_asset_id: string; name: string; mime: string };
  const cardAttachments: CardAttachment[] = [];
  const referenceBlobs: Blob[] = [];
  for (const mediaId of attachmentMediaIds) {
    const { data: asset, error } = await sc
      .from("media_assets")
      .select("id,name,storage_path,mime,owner_id")
      .eq("id", mediaId)
      .maybeSingle();
    if (error || !asset) continue;
    if (asset.owner_id !== ownerId) continue;
    const { data: blob, error: dlErr } = await sc.storage
      .from("media")
      .download(asset.storage_path as string);
    if (dlErr || !blob) continue;
    const mime = (asset.mime as string) || "image/png";
    referenceBlobs.push(new Blob([await blob.arrayBuffer()], { type: mime }));
    cardAttachments.push({
      id: `att_${Math.random().toString(36).slice(2, 10)}`,
      media_asset_id: mediaId,
      name: asset.name as string,
      mime,
    });
  }

  // Generate one image. The vendor module throws a typed error if the key
  // is missing — bubble that up so the agent can switch vendors.
  const blobs = await generateImage(model, prompt, {
    n: 1,
    references: referenceBlobs.length > 0 ? referenceBlobs : undefined,
  });
  if (blobs.length === 0) throw new Error("Image generation produced no data");
  const blob = blobs[0];

  // Upload to the media bucket and insert a media_assets row, mirroring the
  // /vibe-boards/:id/generate path so the canvas resolves bytes through the
  // standard /media/:id/content endpoint.
  const ext = blob.type.includes("jpeg") ? "jpg" : "png";
  const filename = `gen_${Date.now()}_0.${ext}`;
  const assetId = crypto.randomUUID();
  const storagePath = `users/${ownerId}/${assetId}/${filename}`;
  const { error: upErr } = await sc.storage
    .from("media")
    .upload(storagePath, await blob.arrayBuffer(), {
      contentType: blob.type,
      upsert: true,
    });
  if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);

  const { data: row, error: insErr } = await sc
    .from("media_assets")
    .insert({
      id: assetId,
      owner_id: ownerId,
      name: filename,
      storage_path: storagePath,
      mime: blob.type || "image/png",
      size_bytes: blob.size,
      source_kind: "board_generated",
      collection_key: "board-generated",
      board_id: boardId,
      status: "ready",
      tags: ["board-generated"],
    })
    .select("id")
    .single();
  if (insErr) throw new Error(insErr.message);

  // Construct the prompt card item the canvas already knows how to render.
  // current_generation_idx points at the freshly-attached gen so the user
  // sees it immediately on the next state push.
  const generationId = `gen_${crypto.randomUUID()}`;
  const newItem: Record<string, unknown> = {
    id: `it_${Math.random().toString(36).slice(2, 10)}`,
    type: "prompt",
    x,
    y,
    text: prompt,
    model,
    ...(cardAttachments.length > 0 ? { attachments: cardAttachments } : {}),
    generations: [{
      id: generationId,
      media_asset_id: row.id as string,
      model,
      generated_at: new Date().toISOString(),
    }],
    current_generation_idx: 0,
  };
  if (parentId) newItem.parent_id = parentId;

  const items = Array.isArray(state.items) ? state.items : [];
  const next = { ...state, items: [...items, newItem] };
  const { error: bErr } = await sc
    .from("vibe_boards")
    .update({ state: next })
    .eq("id", boardId);
  if (bErr) throw new Error(bErr.message);

  return JSON.stringify({
    item_id: newItem.id as string,
    generation_id: generationId,
    media_asset_id: row.id as string,
    note:
      "Prompt card placed on the canvas with the first generation attached. " +
      "The user can edit the prompt and Send to add more variants, or you can " +
      "call prompt_via_card again with parent_id set for a follow-up variant.",
  });
}

// Send a tool_result back to Anthropic. Accepts either a plain string (wraps
// it in a single text block) or pre-built content blocks for multimodal
// results like read_board's image-rich output.
export async function postImageToolResult(
  anthropicSessionId: string,
  toolUseId: string,
  result: string | ImageToolResult,
): Promise<void> {
  let content: Array<Record<string, unknown>>;
  if (typeof result === "string") {
    content = [{ type: "text", text: result }];
  } else if (result.kind === "text") {
    content = [{ type: "text", text: result.text }];
  } else {
    content = result.blocks;
  }
  await AnthropicSessionEvents.send(anthropicSessionId, [
    {
      type: "user.custom_tool_result",
      custom_tool_use_id: toolUseId,
      content,
      // deno-lint-ignore no-explicit-any
    } as any,
  ]);
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? Math.floor(v) : NaN;
  if (Number.isFinite(n) && n >= min && n <= max) return n;
  return fallback;
}
