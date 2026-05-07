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

// Returns a signed Storage URL the caller can PUT to. We also create the
// kb_files row up front so subsequent extract/chunk/embed can find it.
router.post("/files/upload-url", async (req) => {
  const user = await requireUser(req);
  const parsed = KbUploadUrlSchema.parse(await readJson(req));
  const id = crypto.randomUUID();
  const storagePath = `users/${user.id}/${id}/${parsed.name}`;

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
