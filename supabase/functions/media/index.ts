// /functions/v1/media
//   GET    /            List media assets (caller-scoped). Supports ?tag=foo
//                       and ?q=text filters.
//   GET    /:id         Get one asset.
//   GET    /:id/content Stream the bytes (signed read via service role).
//   DELETE /:id         Delete asset row + storage object.
//
// No upload-url here — bulk seed is handled by scripts/upload-assets.mjs
// using the service-role key. A user-facing upload UI can land later.

import { wrap } from "../_shared/cors.ts";
import { Router } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { BadRequest, NotFound, noContent, ok } from "../_shared/errors.ts";
import { serviceClient } from "../_shared/supabase.ts";

const router = new Router("media");

router.get("/", async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const tag = url.searchParams.get("tag");
  const q = url.searchParams.get("q");
  const sourceKind = url.searchParams.get("source_kind");
  const collectionKey = url.searchParams.get("collection_key");
  const productKey = url.searchParams.get("product_key");
  const shotKey = url.searchParams.get("shot_key");
  const boardId = url.searchParams.get("board_id");

  let query = user.db
    .from("media_assets")
    .select("id,name,storage_path,mime,size_bytes,width,height,tags,anthropic_file_id,source_kind,collection_key,product_key,shot_key,board_id,status,created_at,updated_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (tag) query = query.contains("tags", [tag]);
  if (q) query = query.ilike("name", `%${q}%`);
  if (sourceKind) query = query.eq("source_kind", sourceKind);
  if (collectionKey) query = query.eq("collection_key", collectionKey);
  if (productKey) query = query.eq("product_key", productKey);
  if (shotKey) query = query.eq("shot_key", shotKey);
  if (boardId) query = query.eq("board_id", boardId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("media_assets")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Asset not found");
  return ok(data);
});

// Stream raw bytes via the service role so the browser can <img src=…>
// directly. We RLS-check by going through the user's db client first.
router.get("/:id/content", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("media_assets")
    .select("storage_path,mime,name")
    .eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Asset not found");

  const sc = serviceClient();
  const { data: blob, error: dlErr } = await sc.storage.from("media").download(data.storage_path);
  if (dlErr || !blob) throw new Error(dlErr?.message ?? "Storage download failed");

  const headers = new Headers();
  headers.set("Content-Type", data.mime ?? "application/octet-stream");
  headers.set("Content-Disposition", `inline; filename="${data.name}"`);
  headers.set("Cache-Control", "private, max-age=300");
  return new Response(blob, { status: 200, headers });
});

// Multipart upload — frontend POSTs FormData with `file`, optional `tag`,
// optional `name`. Used by the canvas drag-drop and any future inline upload UI.
router.post("/", async (req) => {
  const user = await requireUser(req);
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new BadRequest("Missing 'file' part");
  const tag = (form.get("tag") as string | null) ?? null;
  const tagsInput = (form.get("tags") as string | null) ?? null;
  const overrideName = (form.get("name") as string | null) ?? null;
  const sourceKind = (form.get("source_kind") as string | null) ?? "board_upload";
  const collectionKey = (form.get("collection_key") as string | null) ?? null;
  const productKey = (form.get("product_key") as string | null) ?? null;
  const shotKey = (form.get("shot_key") as string | null) ?? null;
  const boardId = (form.get("board_id") as string | null) ?? null;
  const status = (form.get("status") as string | null) ?? "ready";
  const name = overrideName || file.name || `upload-${Date.now()}`;
  const tags = [
    ...(tagsInput ? tagsInput.split(",").map((v) => v.trim()).filter(Boolean) : []),
    ...(tag ? [tag] : []),
  ].filter((value, index, arr) => arr.indexOf(value) === index);

  const id = crypto.randomUUID();
  const safeName = name.replace(/\s+/g, "_").replace(/[^\w.\-]/g, "_");
  const storagePath = `users/${user.id}/${id}/${safeName}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || "application/octet-stream";

  const sc = serviceClient();
  const { error: upErr } = await sc.storage.from("media").upload(storagePath, bytes, {
    contentType: mime,
    upsert: true,
  });
  if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);

  const { data, error } = await user.db
    .from("media_assets")
    .insert({
      id,
      owner_id: user.id,
      name,
      storage_path: storagePath,
      mime,
      size_bytes: bytes.length,
      tags,
      source_kind: sourceKind,
      collection_key: collectionKey,
      product_key: productKey,
      shot_key: shotKey,
      board_id: boardId,
      status,
    })
    .select("*")
    .single();
  if (error) throw new BadRequest(error.message);
  return ok(data, 201);
});

router.delete("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data: existing } = await user.db
    .from("media_assets")
    .select("id,storage_path")
    .eq("id", params.id)
    .maybeSingle();
  if (!existing) throw new NotFound("Asset not found");

  const sc = serviceClient();
  if (existing.storage_path) {
    const { error: rmErr } = await sc.storage.from("media").remove([existing.storage_path as string]);
    if (rmErr) console.warn("[media] storage remove failed:", rmErr.message);
  }
  const { error } = await user.db.from("media_assets").delete().eq("id", params.id);
  if (error) throw new BadRequest(error.message);
  return noContent();
});

Deno.serve(wrap((req) => router.handle(req)));
