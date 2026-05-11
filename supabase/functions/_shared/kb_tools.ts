// Built-in KB tools every agent gets for free.
//
// Anthropic Managed Agents can't autonomously discover the user's knowledge
// base — files have to be uploaded to the Files API and explicitly mounted on
// the session. We expose three custom tools so the agent can do this itself:
//
//   kb_list(folder_id?)  — browse the tree, returns metadata only.
//   kb_search(query, k?) — server-side text search across all files.
//   kb_attach(kb_file_id) — mount a file onto the current session via
//                           sessions.resources.add (lazy-uploads to Anthropic
//                           Files on first attach).
//
// The tool definitions are appended to whatever toolset the agent already has.
// Dispatch happens server-side: when the SSE stream surfaces a tool_use event
// with one of these names, we run it and post the result back as a
// user.custom_tool_result event.
//
// Detach is intentionally omitted — mounted files don't bloat context unless
// read, sessions die with the conversation, and we'd rather not pay tokens for
// a tool the agent rarely needs.

import { AnthropicFiles, AnthropicSessionEvents, AnthropicSessionResources } from "./anthropic.ts";
import { serviceClient } from "./supabase.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export const KB_TOOL_NAMES = ["kb_list", "kb_search", "kb_attach"] as const;
export type KbToolName = typeof KB_TOOL_NAMES[number];

export const KB_TOOL_DEFS: Array<Record<string, unknown>> = [
  {
    type: "custom",
    name: "kb_list",
    description:
      "List files in the user's knowledge base. Returns metadata only (id, name, path, size, snippet, mime). Files are NOT mounted into the session — call kb_attach to make a specific file readable. Use this to browse when you don't have a search term in mind.",
    input_schema: {
      type: "object",
      properties: {
        folder_id: {
          type: "string",
          description:
            "Optional folder id to scope the listing. Omit to list all files across the user's KB.",
        },
        limit: {
          type: "integer",
          description: "Max files to return (default 50, max 200).",
          minimum: 1,
          maximum: 200,
        },
      },
    },
  },
  {
    type: "custom",
    name: "kb_search",
    description:
      "Search the user's knowledge base by query string. Server-side text search across every file the user owns. Returns top-k matches with snippets and kb_file_ids — pass an id to kb_attach to mount the actual file. Prefer this over listing when you have a term to search for.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms." },
        k: {
          type: "integer",
          description: "Max results to return (default 8, max 50).",
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["query"],
    },
  },
  {
    type: "custom",
    name: "kb_attach",
    description:
      "Mount a knowledge-base file into the current session so you can read/grep/edit it natively. Returns the in-container mount path. Must be called once per file before you reference it. Idempotent: re-attaching an already-mounted file returns the existing mount path.",
    input_schema: {
      type: "object",
      properties: {
        kb_file_id: {
          type: "string",
          description: "The kb_file id (from kb_list or kb_search).",
        },
      },
      required: ["kb_file_id"],
    },
  },
];

// Walks an event payload and pulls out the tool_use blocks for our builtin
// tools. Anthropic emits tool_use as either a top-level event
// (`type: "agent.tool_use"`) or as a content block inside an
// `agent.message_chunk`/`agent.message`. We accept both.
export type ToolUseRef = {
  tool_use_id: string;
  name: KbToolName;
  input: Record<string, unknown>;
};

export function extractKbToolUses(payload: unknown): ToolUseRef[] {
  const out: ToolUseRef[] = [];
  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const t = obj.type;
    const name = obj.name;
    if (
      typeof t === "string" &&
      (t === "tool_use" || t === "agent.tool_use" || t === "agent.custom_tool_use") &&
      typeof name === "string" &&
      (KB_TOOL_NAMES as readonly string[]).includes(name)
    ) {
      const id = (obj.tool_use_id ?? obj.id) as string | undefined;
      if (id) {
        out.push({
          tool_use_id: id,
          name: name as KbToolName,
          input: (obj.input as Record<string, unknown>) ?? {},
        });
      }
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(payload);
  return out;
}

// Run a single tool call and return the text result. Errors are caught and
// returned as an [ERROR] string so the agent can read what went wrong instead
// of stalling on a missing tool_result.
export async function dispatchKbTool(
  ref: ToolUseRef,
  ctx: { userDb: SupabaseClient; userId: string; anthropicSessionId: string },
): Promise<string> {
  try {
    if (ref.name === "kb_list") return await runList(ctx, ref.input);
    if (ref.name === "kb_search") return await runSearch(ctx, ref.input);
    if (ref.name === "kb_attach") return await runAttach(ctx, ref.input);
    return `[ERROR] Unknown tool: ${ref.name}`;
  } catch (err) {
    console.warn(`[kb_tools] ${ref.name} failed:`, err);
    return `[ERROR] ${(err as Error).message}`;
  }
}

async function runList(
  ctx: { userDb: SupabaseClient },
  input: Record<string, unknown>,
): Promise<string> {
  const folderId = typeof input.folder_id === "string" ? input.folder_id : null;
  const limit = clampInt(input.limit, 50, 1, 200);
  let q = ctx.userDb
    .from("kb_files")
    .select("id,name,folder_id,mime,size_bytes,snippet,tags,updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (folderId) q = q.eq("folder_id", folderId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  if (rows.length === 0) return JSON.stringify({ files: [], note: "No files." });
  return JSON.stringify({
    files: rows.map((f) => ({
      id: f.id,
      name: f.name,
      folder_id: f.folder_id,
      mime: f.mime,
      size_bytes: f.size_bytes,
      snippet: (f.snippet ?? "").slice(0, 200),
      tags: f.tags ?? [],
    })),
  });
}

async function runSearch(
  ctx: { userDb: SupabaseClient },
  input: Record<string, unknown>,
): Promise<string> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) throw new Error("query is required");
  const k = clampInt(input.k, 8, 1, 50);
  const like = `%${query}%`;

  // Two passes: chunk-text matches (rich, with snippet) and filename/snippet
  // matches on kb_files. PPTX/XLSX files come in as binary placeholders with
  // no chunked text, so chunk-only search misses them — falling back to the
  // file row catches name and snippet hits.
  const [chunksRes, filesRes] = await Promise.all([
    ctx.userDb
      .from("kb_chunks")
      .select("id,file_id,ord,text,kb_files!inner(name,tags,folder_id)")
      .ilike("text", like)
      .limit(k),
    ctx.userDb
      .from("kb_files")
      .select("id,name,folder_id,snippet,tags,mime,size_bytes")
      .or(`name.ilike.${like},snippet.ilike.${like}`)
      .limit(k),
  ]);
  if (chunksRes.error) throw new Error(chunksRes.error.message);
  if (filesRes.error) throw new Error(filesRes.error.message);

  const seen = new Set<string>();
  const results: Record<string, unknown>[] = [];
  for (const c of chunksRes.data ?? []) {
    const file = (c as Record<string, unknown>).kb_files as
      | Record<string, unknown>
      | undefined;
    const fileId = (c as Record<string, unknown>).file_id as string;
    if (!fileId || seen.has(fileId)) continue;
    seen.add(fileId);
    results.push({
      kb_file_id: fileId,
      file_name: file?.name,
      folder_id: file?.folder_id,
      match: "chunk",
      snippet: typeof (c as Record<string, unknown>).text === "string"
        ? ((c as Record<string, unknown>).text as string).slice(0, 400)
        : "",
    });
  }
  for (const f of filesRes.data ?? []) {
    const fileId = (f as Record<string, unknown>).id as string;
    if (!fileId || seen.has(fileId)) continue;
    seen.add(fileId);
    const snippet = ((f as Record<string, unknown>).snippet as string) ?? "";
    results.push({
      kb_file_id: fileId,
      file_name: (f as Record<string, unknown>).name,
      folder_id: (f as Record<string, unknown>).folder_id,
      mime: (f as Record<string, unknown>).mime,
      size_bytes: (f as Record<string, unknown>).size_bytes,
      match: "file",
      snippet: snippet.slice(0, 200),
    });
  }
  return JSON.stringify({ results: results.slice(0, k) });
}

// Anthropic Files API technically accepts up to ~500 MB, but we cap at 100 MB
// for kb_attach because the 150s edge-function wall-clock can't reliably push
// more than that without timing out. Larger files need to be uploaded out of
// band (see /kb/files/:id/sync-to-anthropic).
const MAX_KB_ATTACH_SIZE = 100 * 1024 * 1024;

export type KbAttachResult = {
  attached: boolean;
  already_mounted?: boolean;
  resource_id?: string;
  mount_path?: string | null;
  file_name?: string;
  kb_file_id?: string;
  note?: string;
  error?: string;
};

export async function attachKbFileToSession(
  ctx: { userDb: SupabaseClient; anthropicSessionId: string },
  kbFileId: string,
): Promise<KbAttachResult> {
  if (!kbFileId) throw new Error("kb_file_id is required");

  const { data: file, error } = await ctx.userDb
    .from("kb_files")
    .select("id,name,storage_path,mime,size_bytes,anthropic_file_id")
    .eq("id", kbFileId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!file) throw new Error("kb_file not found or not accessible");
  // Hard size guard: only enforced when the file isn't already on Anthropic.
  // Pre-synced files attach instantly so size doesn't matter.
  if (
    !file.anthropic_file_id &&
    typeof file.size_bytes === "number" &&
    file.size_bytes > MAX_KB_ATTACH_SIZE
  ) {
    const mb = (file.size_bytes / 1024 / 1024).toFixed(0);
    return {
      attached: false,
      kb_file_id: file.id as string,
      file_name: file.name as string,
      error: `File ${file.name} is ${mb} MB, which exceeds the ${MAX_KB_ATTACH_SIZE / 1024 / 1024} MB inline-attach limit. Ask the user to pre-sync it via /kb/files/${file.id}/sync-to-anthropic, or use a smaller file.`,
    };
  }

  // Lazy-upload to Anthropic Files on first attach.
  let aid = file.anthropic_file_id as string | null;
  if (!aid) {
    const sc = serviceClient();
    const { data: blob, error: dlErr } = await sc.storage
      .from("kb")
      .download(file.storage_path as string);
    if (dlErr || !blob) {
      throw new Error(`Storage object missing: ${dlErr?.message ?? "not found"}`);
    }
    const uploaded = await AnthropicFiles.upload(blob, file.name as string, "agent");
    aid = uploaded.id;
    await sc.from("kb_files").update({ anthropic_file_id: aid }).eq("id", file.id);
  }

  // Idempotency check: if the file is already mounted, surface the existing
  // mount instead of trying to add a duplicate. We match defensively against
  // multiple shapes the list response might use for the file id, since the
  // exact key isn't documented.
  const findExisting = (rows: SessionResourceRecord[]) =>
    rows.find((r) => {
      if (r.type !== "file") return false;
      const candidates = [
        r.file_id,
        (r as Record<string, unknown>).id,
        ((r as Record<string, unknown>).file as Record<string, unknown> | undefined)?.id,
      ];
      return candidates.some((c) => typeof c === "string" && c === aid);
    });

  try {
    const existing = await AnthropicSessionResources.list(ctx.anthropicSessionId);
    const hit = findExisting(existing.data ?? []);
    if (hit) {
      return {
        attached: true,
        already_mounted: true,
        resource_id: hit.id,
        mount_path: hit.mount_path,
        file_name: file.name,
        kb_file_id: file.id as string,
      };
    }
  } catch (err) {
    console.warn("[kb_tools] resources.list failed (will try add anyway):", err);
  }

  const mountPath = `/mnt/session/uploads/${file.name}`;
  try {
    const created = await AnthropicSessionResources.add(ctx.anthropicSessionId, {
      type: "file",
      file_id: aid as string,
      mount_path: mountPath,
    });
    return {
      attached: true,
      resource_id: created.id,
      mount_path: created.mount_path ?? mountPath,
      file_name: file.name,
      kb_file_id: file.id as string,
    };
  } catch (err) {
    // Duplicate-resource recovery: if Anthropic says we already mounted this
    // file (under any mount_path), look it up via list and return that.
    const msg = (err as Error).message ?? "";
    const isDup = /overlaps|already|conflict/i.test(msg);
    if (isDup) {
      try {
        const existing = await AnthropicSessionResources.list(ctx.anthropicSessionId);
        const hit = findExisting(existing.data ?? []);
        if (hit) {
          return {
            attached: true,
            already_mounted: true,
            resource_id: hit.id,
            mount_path: hit.mount_path ?? null,
            file_name: file.name,
            kb_file_id: file.id as string,
            note: "Resource was already mounted on this session.",
          };
        }
      } catch (lookupErr) {
        console.warn("[kb_tools] post-conflict list failed:", lookupErr);
      }
      // Couldn't find via list either — still tell the agent it's mounted so
      // it stops retrying. The session was created with this file mounted at
      // /mnt/session/uploads/<name>.
      return {
        attached: true,
        already_mounted: true,
        mount_path: mountPath,
        file_name: file.name,
        kb_file_id: file.id as string,
        note: "Resource was already mounted on this session (could not look up resource_id).",
      };
    }
    throw err;
  }
}

async function runAttach(
  ctx: { userDb: SupabaseClient; anthropicSessionId: string },
  input: Record<string, unknown>,
): Promise<string> {
  const kbFileId = typeof input.kb_file_id === "string" ? input.kb_file_id : "";
  return JSON.stringify(await attachKbFileToSession(ctx, kbFileId));
}

// Send a tool_result back to Anthropic for a single tool_use_id. Wraps the
// payload as a user.custom_tool_result event so the agent picks it up on the
// next turn.
export async function postToolResult(
  anthropicSessionId: string,
  toolUseId: string,
  text: string,
): Promise<void> {
  await AnthropicSessionEvents.send(anthropicSessionId, [
    {
      type: "user.custom_tool_result",
      custom_tool_use_id: toolUseId,
      content: [{ type: "text", text }],
    },
  ]);
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? Math.floor(v) : NaN;
  if (Number.isFinite(n) && n >= min && n <= max) return n;
  return fallback;
}
