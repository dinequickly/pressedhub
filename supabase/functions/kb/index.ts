// /functions/v1/kb — Knowledge base file pipeline.
//   GET    /folders                   List folders.
//   POST   /folders                   { name, parent_id?, path }
//   GET    /files                     List files (filterable by ?folder_id=).
//   POST   /files/upload-url          Returns a signed Storage upload URL + a kb_files row.
//   POST   /files/:id/extract         Naive text extract (TODO real PDF/Doc parsers).
//   POST   /files/:id/chunk           Sliding-window text chunker.
//   POST   /files/:id/embed           STUB v1: writes zero vector + marks embedded.
//   POST   /search                    Cosine search across kb_chunks.

import { wrap } from "../_shared/cors.ts";
import { Router, readJson } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { BadRequest, NotFound, ok } from "../_shared/errors.ts";
import {
  KbChunkSchema,
  KbEmbedSchema,
  KbExtractSchema,
  KbSearchSchema,
  KbUploadUrlSchema,
} from "../_shared/schemas.ts";
import { serviceClient } from "../_shared/supabase.ts";
import {
  AnthropicFiles,
  AnthropicMessages,
  type AnthropicTurn,
  type ToolDef,
} from "../_shared/anthropic.ts";
import { Groq } from "../_shared/groq.ts";

const router = new Router("kb");

// ---- Folders -----------------------------------------------------------

router.get("/folders", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("kb_folders").select("*").order("path");
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.post("/folders", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ name: string; parent_id?: string; path: string }>(req);
  const { data, error } = await user.db
    .from("kb_folders")
    .insert({
      name: body.name,
      parent_id: body.parent_id ?? null,
      path: body.path,
      created_by: user.id,
    })
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  return ok(data, 201);
});

// ---- Files -------------------------------------------------------------

router.get("/files", async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const folderId = url.searchParams.get("folder_id");
  let q = user.db.from("kb_files").select("*").order("updated_at", { ascending: false });
  if (folderId) q = q.eq("folder_id", folderId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/files/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("kb_files").select("*").eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("File not found");
  return ok(data);
});

// Adopt a file that exists on the Anthropic side (an agent output, or an
// attached resource) as a kb_files row. Idempotent — if a row already exists
// for the given anthropic_file_id we return it without re-uploading.
//
// This is the bridge between session-scoped Anthropic file ids and the
// kb_files-keyed editor experience. The chat page calls this when the user
// clicks a CSV chip; the returned id then drives /sheets/:fileId, which
// gives the user the full editor (Save, AI fill, sidebar tool-use, etc).
router.post("/files/import-from-session", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{
    session_id: string;
    anthropic_file_id: string;
    name?: string;
  }>(req);
  if (!body.session_id || !body.anthropic_file_id) {
    throw new BadRequest("session_id and anthropic_file_id are required");
  }

  // Idempotency: a kb_files row may already mirror this anthropic_file_id.
  {
    const { data: existing } = await user.db
      .from("kb_files")
      .select("*")
      .eq("anthropic_file_id", body.anthropic_file_id)
      .maybeSingle();
    if (existing) return ok({ file: existing, adopted: false });
  }

  // Validate that the caller owns the session (RLS on sessions table does
  // the work; if the row isn't visible to the user, we refuse).
  const { data: session } = await user.db.from("sessions")
    .select("anthropic_id")
    .eq("id", body.session_id)
    .maybeSingle();
  if (!session?.anthropic_id) throw new NotFound("Session not found");

  // Confirm the file is actually scoped to this session before we copy it,
  // so a user can't adopt arbitrary file ids by id-guessing.
  const list = await AnthropicFiles.list({ scope_id: session.anthropic_id as string });
  const meta = (list.data ?? []).find((f) => f.id === body.anthropic_file_id);
  if (!meta) throw new NotFound("File not in this session's scope");

  // Pull bytes + mirror to storage.
  const upstream = await AnthropicFiles.content(body.anthropic_file_id);
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const filename = body.name ?? (meta.filename as string) ?? `${body.anthropic_file_id}.bin`;
  const mime = (meta.mime_type as string) ?? upstream.headers.get("content-type") ?? "application/octet-stream";

  const id = crypto.randomUUID();
  const storagePath = `users/${user.id}/${id}/${filename}`;
  const sc = serviceClient();
  const { error: upErr } = await sc.storage.from("kb").upload(storagePath, bytes, {
    upsert: true,
    contentType: mime,
  });
  if (upErr) throw new Error(upErr.message);

  const isText = mime.startsWith("text/") || mime === "application/json";
  const snippet = isText
    ? new TextDecoder().decode(bytes).slice(0, 1024)
    : `[binary ${mime}, ${bytes.byteLength} bytes; TODO extractor]`;

  const { data: row, error: insErr } = await user.db.from("kb_files").insert({
    id,
    folder_id: null,
    name: filename,
    storage_path: storagePath,
    mime,
    size_bytes: bytes.byteLength,
    status: isText ? "extracted" : "uploaded",
    snippet,
    anthropic_file_id: body.anthropic_file_id,
    uploaded_by: user.id,
  }).select().single();
  if (insErr) throw new BadRequest(insErr.message);

  return ok({ file: row, adopted: true });
});

// Returns a signed Storage URL the caller can PUT to. We also create the
// kb_files row up front so subsequent extract/chunk/embed can find it.
router.post("/files/upload-url", async (req) => {
  const user = await requireUser(req);
  const parsed = KbUploadUrlSchema.parse(await readJson(req));
  const id = crypto.randomUUID();
  const safeName = parsed.name.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9._\-]/g, "_");
  const storagePath = `users/${user.id}/${id}/${safeName}`;

  const { data: file, error: insertErr } = await user.db
    .from("kb_files")
    .insert({
      id,
      folder_id: parsed.folder_id ?? null,
      name: parsed.name,
      storage_path: storagePath,
      mime: parsed.mime,
      size_bytes: parsed.size_bytes,
      status: "uploaded",
      uploaded_by: user.id,
    })
    .select()
    .single();
  if (insertErr) throw new BadRequest(insertErr.message);

  const sc = serviceClient();
  const { data: signed, error: signErr } = await sc.storage
    .from("kb")
    .createSignedUploadUrl(storagePath);
  if (signErr) throw new Error(signErr.message);

  // The Storage API returns an internal-Docker URL (eg `http://kong:8000/...`
  // or `http://supabase_edge_runtime:8081/...`) when called from inside an
  // edge function. Rewrite the host to whatever the deployment's external
  // base URL is. EXTERNAL_SUPABASE_URL overrides if set, otherwise we use
  // SUPABASE_URL — but when SUPABASE_URL is the internal Kong URL we fall
  // back to constructing one from x-forwarded-{host,proto,port}.
  const envBase = Deno.env.get("EXTERNAL_SUPABASE_URL") ?? "";
  let externalBase = envBase;
  if (!externalBase) {
    const sb = Deno.env.get("SUPABASE_URL") ?? "";
    if (sb && !sb.includes("kong:") && !sb.includes("supabase_kong")) {
      externalBase = sb;
    }
  }
  if (!externalBase) {
    const xfHost = req.headers.get("x-forwarded-host");
    const xfProto = req.headers.get("x-forwarded-proto") ?? "http";
    const xfPort = req.headers.get("x-forwarded-port");
    if (xfHost) {
      const hostWithPort = xfHost.includes(":") || !xfPort ? xfHost : `${xfHost}:${xfPort}`;
      externalBase = `${xfProto}://${hostWithPort}`;
    } else {
      externalBase = `${xfProto}://${req.headers.get("host") ?? "127.0.0.1"}`;
    }
  }
  const signedUrl = signed.signedUrl.replace(/^https?:\/\/[^/]+/, externalBase);

  return ok({ file, signed_url: signedUrl, token: signed.token, path: storagePath });
});

// Stub extractor. Reads the storage object as text; for binary types it
// records a placeholder snippet. Replace with pdf-parse / mammoth when ready.
router.post("/files/:id/extract", async (req, params) => {
  const user = await requireUser(req);
  KbExtractSchema.parse({ file_id: params.id });
  const { data: file } = await user.db.from("kb_files").select("*").eq("id", params.id)
    .maybeSingle();
  if (!file) throw new NotFound("File not found");
  const sc = serviceClient();
  const { data: blob, error } = await sc.storage.from("kb").download(file.storage_path);
  if (error || !blob) {
    await user.db.from("kb_files").update({ status: "failed" }).eq("id", params.id);
    throw new Error(error?.message ?? "Failed to download object");
  }
  let snippet = "";
  if ((file.mime as string).startsWith("text/") || file.mime === "application/json") {
    snippet = (await blob.text()).slice(0, 1024);
  } else {
    snippet = `[binary ${file.mime}, ${file.size_bytes} bytes; TODO extractor]`;
  }
  await user.db.from("kb_files").update({ snippet, status: "extracted" }).eq("id", params.id);
  return ok({ extracted: true, snippet_len: snippet.length });
});

router.post("/files/:id/chunk", async (req, params) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const parsed = KbChunkSchema.parse({ file_id: params.id, ...(body as object) });
  const { data: file } = await user.db.from("kb_files").select("*").eq("id", params.id)
    .maybeSingle();
  if (!file) throw new NotFound("File not found");
  if (file.status !== "extracted" && file.status !== "chunked" && file.status !== "embedded") {
    throw new BadRequest("File must be extracted first");
  }
  const sc = serviceClient();
  const { data: blob, error } = await sc.storage.from("kb").download(file.storage_path);
  if (error || !blob) throw new Error(error?.message ?? "Download failed");
  const text = (file.mime as string).startsWith("text/") || file.mime === "application/json"
    ? await blob.text()
    : (file.snippet as string);

  const chunks: string[] = [];
  const size = parsed.chunk_size_chars;
  const overlap = parsed.overlap_chars;
  for (let i = 0; i < text.length; i += size - overlap) {
    chunks.push(text.slice(i, i + size));
  }

  await sc.from("kb_chunks").delete().eq("file_id", params.id);
  if (chunks.length > 0) {
    const rows = chunks.map((t, i) => ({ file_id: params.id, ord: i, text: t }));
    const { error: insErr } = await sc.from("kb_chunks").insert(rows);
    if (insErr) throw new Error(insErr.message);
  }
  await user.db.from("kb_files").update({ status: "chunked" }).eq("id", params.id);
  return ok({ chunked: true, chunk_count: chunks.length });
});

// STUB: writes a zero vector to every chunk. Replace with a real embedding
// call (Anthropic, OpenAI, Voyage, etc.) when ready.
router.post("/files/:id/embed", async (req, params) => {
  const user = await requireUser(req);
  KbEmbedSchema.parse({ file_id: params.id });
  const sc = serviceClient();
  const { data: chunks } = await sc.from("kb_chunks").select("id").eq("file_id", params.id);
  const zero = `[${new Array(1536).fill(0).join(",")}]`;
  for (const c of chunks ?? []) {
    await sc.from("kb_chunks").update({ embedding: zero }).eq("id", c.id);
  }
  await user.db.from("kb_files").update({ status: "embedded" }).eq("id", params.id);
  return ok({
    embedded: chunks?.length ?? 0,
    note: "STUB v1: zero vector. Replace `kb` function embed handler with a real embedding call.",
  });
});

// Mirror this file onto Anthropic's Files API so it can be passed in
// `resources: [{type:"file", file_id: ...}]` when creating a session. We
// download the original blob from Storage (NOT the extracted snippet) so
// the agent reads the real bytes. Idempotent: re-syncing replaces the
// previous Anthropic file (best-effort delete + fresh upload).
router.post("/files/:id/sync-to-anthropic", async (_req, params) => {
  const sc = serviceClient();
  const { data: file } = await sc.from("kb_files").select("*").eq("id", params.id)
    .maybeSingle();
  if (!file) throw new NotFound("File not found");

  if (file.anthropic_file_id) {
    // Best-effort cleanup of the prior version. If Anthropic says it's
    // already gone we don't care; the new upload below is what matters.
    try { await AnthropicFiles.delete(file.anthropic_file_id); } catch (_e) { /* ignore */ }
  }

  const { data: blob, error } = await sc.storage.from("kb").download(file.storage_path);
  if (error || !blob) throw new Error(error?.message ?? "Storage download failed");

  const uploaded = await AnthropicFiles.upload(blob, file.name as string, "agent");

  const { data: updated, error: updErr } = await sc.from("kb_files")
    .update({ anthropic_file_id: uploaded.id })
    .eq("id", params.id)
    .select()
    .single();
  if (updErr) throw new BadRequest(updErr.message);
  return ok({ file: updated, anthropic_file_id: uploaded.id });
});

// Stream the raw storage object back to the caller. RLS on kb_files gates
// the metadata fetch (uploaded_by = auth.uid() or admin); after that the
// service-role storage client downloads the bytes.
router.get("/files/:id/content", async (req, params) => {
  const user = await requireUser(req);
  const { data: file } = await user.db.from("kb_files").select("*").eq("id", params.id)
    .maybeSingle();
  if (!file) throw new NotFound("File not found");

  const sc = serviceClient();
  const { data: blob, error } = await sc.storage.from("kb").download(file.storage_path as string);
  if (error || !blob) {
    // Distinguish "the row exists but the bytes never landed" (orphan upload —
    // signed PUT failed silently) from generic download errors. The frontend
    // can offer a "delete & re-upload" recovery only for orphan rows.
    const msg = error?.message ?? "Download failed";
    if (/not found|object_not_found/i.test(msg)) {
      throw new NotFound(
        `Storage object missing for ${file.name}. The upload didn't finish — delete this file and re-upload.`,
      );
    }
    throw new Error(msg);
  }

  const headers = new Headers();
  headers.set("Content-Type", (file.mime as string) ?? "application/octet-stream");
  headers.set("Content-Length", String((file.size_bytes as number) ?? blob.size));
  const filename = (file.name as string).replace(/[^\w.\-]+/g, "_");
  const disp = new URL(req.url).searchParams.get("download") === "1" ? "attachment" : "inline";
  headers.set("Content-Disposition", `${disp}; filename="${filename}"`);
  headers.set("Cache-Control", "private, max-age=60");
  return new Response(blob.stream(), { status: 200, headers });
});

// Return a short-lived signed download URL directly from Supabase Storage,
// bypassing the edge function proxy. This lets the browser stream large
// files (PPTX, video, etc.) without hitting the 150 s edge function wall-clock
// limit. Auth check is still enforced here (the caller must be authenticated
// and own the file); the resulting URL is time-limited (default 1 hour).
router.get("/files/:id/download-url", async (req, params) => {
  const user = await requireUser(req);
  // Ownership check: non-admin callers may only get a signed URL for their
  // own files. The RLS read policy only gates on `authenticated`, not
  // ownership, so we enforce the ownership filter here explicitly.
  let q = user.db.from("kb_files").select("id,name,storage_path,size_bytes").eq("id", params.id);
  if (user.role !== "admin") q = q.eq("uploaded_by", user.id);
  const { data: file } = await q.maybeSingle();
  if (!file) throw new NotFound("File not found");

  const sc = serviceClient();
  const ttl = 3600; // 1 hour
  const { data: signed, error } = await sc.storage
    .from("kb")
    .createSignedUrl(file.storage_path as string, ttl, {
      download: false,
    });
  if (error || !signed?.signedUrl) throw new Error(error?.message ?? "Could not sign URL");

  // Rewrite internal-Docker host to external URL (same logic as upload-url).
  const envBase = Deno.env.get("EXTERNAL_SUPABASE_URL") ?? "";
  let externalBase = envBase;
  if (!externalBase) {
    const sb = Deno.env.get("SUPABASE_URL") ?? "";
    if (sb && !sb.includes("kong:") && !sb.includes("supabase_kong")) externalBase = sb;
  }
  if (!externalBase) {
    const xfHost = req.headers.get("x-forwarded-host");
    const xfProto = req.headers.get("x-forwarded-proto") ?? "http";
    const xfPort = req.headers.get("x-forwarded-port");
    if (xfHost) {
      const hp = xfHost.includes(":") || !xfPort ? xfHost : `${xfHost}:${xfPort}`;
      externalBase = `${xfProto}://${hp}`;
    } else {
      externalBase = `${xfProto}://${req.headers.get("host") ?? "127.0.0.1"}`;
    }
  }
  const url = signed.signedUrl.replace(/^https?:\/\/[^/]+/, externalBase);

  return ok({ url, ttl, size_bytes: file.size_bytes, name: file.name });
});

// Overwrite a kb_file's storage object with the request body and re-run
// the extract → chunk → embed pipeline so search stays in sync. Used by
// the in-app editor for text-based files.
router.put("/files/:id/content", async (req, params) => {
  const user = await requireUser(req);
  const { data: file } = await user.db.from("kb_files").select("*").eq("id", params.id)
    .maybeSingle();
  if (!file) throw new NotFound("File not found");

  const bytes = new Uint8Array(await req.arrayBuffer());
  const sc = serviceClient();
  const { error: upErr } = await sc.storage
    .from("kb")
    .upload(file.storage_path as string, bytes, {
      upsert: true,
      contentType: (file.mime as string) ?? "application/octet-stream",
    });
  if (upErr) throw new Error(upErr.message);

  await user.db.from("kb_files").update({
    size_bytes: bytes.byteLength,
    status: "uploaded",
  }).eq("id", params.id);

  // Re-run pipeline. Text/JSON files come out clean; binary ones get
  // a placeholder snippet — same behavior as the upload path.
  const text = (file.mime as string).startsWith("text/") || file.mime === "application/json"
    ? new TextDecoder().decode(bytes).slice(0, 1024)
    : `[binary ${file.mime}, ${bytes.byteLength} bytes; TODO extractor]`;
  await user.db.from("kb_files").update({ snippet: text, status: "extracted" }).eq("id", params.id);

  // Re-chunk text bodies. Binary files keep their placeholder snippet only.
  if ((file.mime as string).startsWith("text/") || file.mime === "application/json") {
    const fullText = new TextDecoder().decode(bytes);
    const size = 1500;
    const overlap = 150;
    const chunks: string[] = [];
    for (let i = 0; i < fullText.length; i += size - overlap) {
      chunks.push(fullText.slice(i, i + size));
    }
    await sc.from("kb_chunks").delete().eq("file_id", params.id);
    if (chunks.length > 0) {
      const rows = chunks.map((t, i) => ({ file_id: params.id, ord: i, text: t }));
      const { error: insErr } = await sc.from("kb_chunks").insert(rows);
      if (insErr) throw new Error(insErr.message);
    }
    await user.db.from("kb_files").update({ status: "chunked" }).eq("id", params.id);

    // Stub embed (zero vector, matches /embed handler).
    const zero = `[${new Array(1536).fill(0).join(",")}]`;
    const { data: chunkRows } = await sc.from("kb_chunks").select("id").eq("file_id", params.id);
    for (const c of chunkRows ?? []) {
      await sc.from("kb_chunks").update({ embedding: zero }).eq("id", c.id);
    }
    await user.db.from("kb_files").update({ status: "embedded" }).eq("id", params.id);
  }

  // If this file was already mirrored to Anthropic, refresh the mirror
  // so the agent sees the new bytes. Best-effort — the local copy is
  // authoritative and the user can manually re-trigger from the UI.
  if (file.anthropic_file_id) {
    try {
      await AnthropicFiles.delete(file.anthropic_file_id as string);
      const blob = new Blob([bytes], { type: (file.mime as string) ?? "application/octet-stream" });
      const uploaded = await AnthropicFiles.upload(blob, file.name as string, "agent");
      await user.db.from("kb_files").update({ anthropic_file_id: uploaded.id }).eq(
        "id", params.id,
      );
    } catch (e) {
      console.warn("[kb] anthropic re-sync failed:", e);
    }
  }

  return ok({ updated: true, size_bytes: bytes.byteLength });
});

// AI-fill a single column of a CSV-shaped kb_file. The caller picks a column
// (by header name) and supplies a free-text prompt; we make ONE Groq call per
// row, passing the row's other columns as context, and return the array of
// generated values. The frontend can then apply them and POST the new CSV
// back via PUT /files/:id/content.
//
// Concurrency is bounded so we don't blast Groq's rate limit on huge sheets;
// 8 in flight is comfortable on the gpt-oss-20b free tier.
router.post("/files/:id/ai-fill", async (req, params) => {
  const user = await requireUser(req);
  const body = await readJson<{
    column: string;
    prompt: string;
    max_rows?: number;
    // Optional: 0-based data-row indices to restrict the fill to (matches
    // the user's selection rectangle on the frontend). If omitted, fills
    // every data row up to max_rows.
    row_indices?: number[];
  }>(req);
  if (!body.column || !body.prompt) {
    throw new BadRequest("column and prompt are required");
  }

  const { data: file } = await user.db.from("kb_files").select("*").eq("id", params.id)
    .maybeSingle();
  if (!file) throw new NotFound("File not found");
  const mime = (file.mime as string) ?? "";
  const ext = (file.name as string).toLowerCase().split(".").pop() ?? "";
  if (mime !== "text/csv" && ext !== "csv") {
    throw new BadRequest("ai-fill is only available for CSV files right now");
  }

  const sc = serviceClient();
  const { data: blob, error: dlErr } = await sc.storage.from("kb").download(
    file.storage_path as string,
  );
  if (dlErr || !blob) throw new Error(dlErr?.message ?? "Storage download failed");
  const csv = await blob.text();
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new BadRequest("CSV has no data rows");
  const header = rows[0];
  const dataRows = rows.slice(1);
  let colIdx = header.findIndex((h) => h === body.column);
  if (colIdx < 0) {
    // Allow callers to pass a brand-new column name; we append.
    colIdx = header.length;
    header.push(body.column);
  }

  // Build the list of data-row indices we'll actually fill. If the caller
  // sent row_indices we honor it (clamped, deduped, in-bounds); otherwise we
  // do the whole sheet (capped by max_rows).
  let targets: number[];
  if (Array.isArray(body.row_indices) && body.row_indices.length > 0) {
    targets = Array.from(new Set(body.row_indices))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < dataRows.length)
      .sort((a, b) => a - b);
    if (body.max_rows && body.max_rows > 0) targets = targets.slice(0, body.max_rows);
  } else {
    const cap = body.max_rows && body.max_rows > 0
      ? Math.min(body.max_rows, dataRows.length)
      : dataRows.length;
    targets = Array.from({ length: cap }, (_, i) => i);
  }
  if (targets.length === 0) {
    return ok({ column: body.column, column_index: colIdx, row_indices: [], values: [] });
  }

  const system =
    `You fill in a single cell of a spreadsheet. The user describes what column "${body.column}" should contain. ` +
    `You will be given the other cells of one row as context. Respond with ONLY the cell value — no quotes, no explanation, no leading "Answer:" or similar. Keep it concise.`;

  const fills = new Array<string>(targets.length).fill("");
  const concurrency = 8;
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= targets.length) return;
      const rowIdx = targets[i];
      const row = dataRows[rowIdx];
      const ctx = header
        .map((h, ci) => ci === colIdx ? null : `${h}: ${row[ci] ?? ""}`)
        .filter(Boolean)
        .join("\n");
      const userMsg = `Row context:\n${ctx}\n\nFill in "${body.column}". Instructions: ${body.prompt}`;
      try {
        const { text } = await Groq.chat({
          messages: [
            { role: "system", content: system },
            { role: "user", content: userMsg },
          ],
          max_tokens: 120,
        });
        fills[i] = text.trim().replace(/^["']|["']$/g, "");
      } catch (err) {
        console.warn(`[kb ai-fill] row ${rowIdx} failed:`, err);
        fills[i] = `[error: ${(err as Error).message}]`;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()),
  );

  return ok({
    column: body.column,
    column_index: colIdx,
    row_indices: targets,
    values: fills,
  });
});

// Inline RFC-4180-ish CSV parser. Mirrors the frontend's parseCsv so the
// two stay consistent. Comma delimiter only; handles quoted fields and
// CRLF / LF.
function parseCsv(text: string): string[][] {
  const rowsOut: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") {
      row.push(field); field = "";
      rowsOut.push(row); row = [];
      i++; continue;
    }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rowsOut.push(row);
  }
  return rowsOut;
}

// Stateless spreadsheet chat. The frontend passes the full message history
// each turn; we don't persist anything server-side. The current CSV is
// injected as system context so the assistant can reason about the data
// without needing a managed-agent session. Capped at ~200KB of CSV to stay
// well under context limits — bigger sheets need a managed-agent + tool
// flow, which is a follow-up.
router.post("/files/:id/sheets-chat", async (req, params) => {
  const user = await requireUser(req);
  const body = await readJson<{
    messages: AnthropicTurn[];
    csv_state?: string;
    tools?: ToolDef[];
  }>(req);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new BadRequest("messages is required");
  }

  const { data: file } = await user.db.from("kb_files").select("*").eq("id", params.id)
    .maybeSingle();
  if (!file) throw new NotFound("File not found");

  // Prefer the client's latest unsaved state (so the assistant sees what the
  // user actually sees, including edits not yet committed to storage). Fall
  // back to the storage copy if the client didn't send any.
  let csv = body.csv_state ?? "";
  if (!csv) {
    const sc = serviceClient();
    const { data: blob, error: dlErr } = await sc.storage.from("kb").download(
      file.storage_path as string,
    );
    if (dlErr || !blob) throw new Error(dlErr?.message ?? "Storage download failed");
    csv = await blob.text();
  }
  const truncated = csv.length > 200_000;
  if (truncated) csv = csv.slice(0, 200_000);

  const toolsHint = body.tools && body.tools.length > 0
    ? `\n\nYou have tools to MODIFY the sheet directly. Prefer tools over describing changes in prose — call set_cells/add_column/fill_column/delete_rows when the user asks for a change. After tool results come back, give a short confirmation in plain text.`
    : "";

  const system =
    `You are a spreadsheet assistant embedded in a Google-Sheets-style editor. ` +
    `The user is looking at the file "${file.name}". Below is the current contents of that spreadsheet, in CSV form (first row = headers). ` +
    `When you suggest changes, refer to columns by their header name (or A1 letter) and rows by their 1-based data-row number (row 1 = first row after the header). ` +
    `Keep responses short and concrete. Do not invent rows or columns that aren't present.` +
    toolsHint +
    (truncated ? "\n\nNOTE: the spreadsheet was truncated at 200KB; you're seeing only the beginning." : "") +
    `\n\n--- ${file.name} ---\n${csv}\n--- end ---`;

  const reply = await AnthropicMessages.createWithTools({
    system,
    messages: body.messages,
    tools: body.tools ?? [],
    max_tokens: 2048,
  });
  return ok({
    content: reply.content,
    stop_reason: reply.stop_reason,
  });
});

// Delete a kb_file. Removes the storage object, the Anthropic file mirror
// (best-effort), and the row itself. kb_chunks cascade via FK.
router.delete("/files/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data: file } = await user.db.from("kb_files").select("*").eq("id", params.id)
    .maybeSingle();
  if (!file) throw new NotFound("File not found");

  if (file.anthropic_file_id) {
    try { await AnthropicFiles.delete(file.anthropic_file_id as string); } catch (_e) { /* ignore */ }
  }

  const sc = serviceClient();
  if (file.storage_path) {
    const { error: rmErr } = await sc.storage.from("kb").remove([file.storage_path as string]);
    if (rmErr) throw new Error(rmErr.message);
  }

  const { error: delErr } = await user.db.from("kb_files").delete().eq("id", params.id);
  if (delErr) throw new BadRequest(delErr.message);

  return ok({ deleted: true });
});

router.post("/search", async (req) => {
  const user = await requireUser(req);
  const parsed = KbSearchSchema.parse(await readJson(req));
  // STUB: until real embeddings exist, query embedding is also zero. The
  // pgvector cosine distance is undefined for zero vectors; we fall back to a
  // text trigram match for v1.
  const { data, error } = await user.db
    .from("kb_chunks")
    .select("id,file_id,ord,text,kb_files!inner(name,tags,folder_id)")
    .ilike("text", `%${parsed.query}%`)
    .limit(parsed.limit);
  if (error) throw new Error(error.message);
  return ok({
    results: (data ?? []).map((c: any) => ({
      chunk_id: c.id,
      file_id: c.file_id,
      file_name: c.kb_files?.name,
      tags: c.kb_files?.tags ?? [],
      ord: c.ord,
      similarity: 0,
      text: c.text,
    })),
    note: "STUB v1: text-match instead of cosine until real embeddings land.",
  });
});

Deno.serve(wrap((req) => router.handle(req)));
