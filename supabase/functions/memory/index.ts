// /functions/v1/memory
// Stores, documents, structured tables. The query/upsert endpoints are the
// API agents call (via custom tool / MCP) when they want to read/write memory.
//
//   GET    /stores
//   POST   /stores
//   GET    /stores/:id
//   PATCH  /stores/:id
//   DELETE /stores/:id
//   POST   /query                  { store_id, path? | table_name? + where?, limit }
//   POST   /upsert/document        { store_id, path, content }
//   POST   /upsert/row             { store_id, table_name, row, row_id? }
//   POST   /tables                 { store_id, name, schema }
//   GET    /stores/:id/tables
//   GET    /stores/:id/documents
//   GET    /stores/:id/dreams      List dreams for the store.

import { wrap } from "../_shared/cors.ts";
import { Router, readJson } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { BadRequest, NotFound, noContent, ok } from "../_shared/errors.ts";
import {
  MemoryDocUpsertSchema,
  MemoryQuerySchema,
  MemoryRowUpsertSchema,
  MemoryStoreCreateSchema,
  MemoryStoreUpdateSchema,
} from "../_shared/schemas.ts";
import { AnthropicMemoryStores } from "../_shared/anthropic.ts";
import { ENV } from "../_shared/env.ts";

const router = new Router("memory");

// ---- Stores ------------------------------------------------------------

router.get("/stores", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("memory_stores").select("*").order("updated_at", {
    ascending: false,
  });
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.post("/stores", async (req) => {
  const user = await requireUser(req);
  const parsed = MemoryStoreCreateSchema.parse(await readJson(req));

  // Mirror onto Anthropic so this store can be attached to a session as a
  // resource. We tolerate API failure here — without it the local store
  // still exists; the user just can't attach it until they hit
  // /memory/stores/:id/sync-to-anthropic.
  let anthropicId: string | null = null;
  if (ENV.ANTHROPIC_API_KEY) {
    try {
      const created = await AnthropicMemoryStores.create({
        display_name: parsed.name,
        description: parsed.description || undefined,
      });
      anthropicId = created.id;
    } catch (err) {
      console.warn("[memory] anthropic memory_stores.create failed:", err);
    }
  }

  const { data, error } = await user.db
    .from("memory_stores")
    .insert({ ...parsed, owner_id: user.id, anthropic_id: anthropicId })
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  return ok(data, 201);
});

// Backfill / retry endpoint: bind a local store to a fresh Anthropic
// memory store. Useful for stores created before this column existed or
// where the original create-time API call failed.
router.post("/stores/:id/sync-to-anthropic", async (req, params) => {
  const user = await requireUser(req);
  const { data: store } = await user.db.from("memory_stores").select("*").eq("id", params.id)
    .maybeSingle();
  if (!store) throw new NotFound("Memory store not found");
  if (store.anthropic_id) return ok({ store, anthropic_id: store.anthropic_id });
  const created = await AnthropicMemoryStores.create({
    display_name: store.name,
    description: store.description || undefined,
  });
  const { data: updated, error } = await user.db
    .from("memory_stores")
    .update({ anthropic_id: created.id })
    .eq("id", params.id)
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  return ok({ store: updated, anthropic_id: created.id });
});

router.get("/stores/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("memory_stores").select("*").eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Memory store not found");
  return ok(data);
});

router.patch("/stores/:id", async (req, params) => {
  const user = await requireUser(req);
  const parsed = MemoryStoreUpdateSchema.parse(await readJson(req));
  const { data, error } = await user.db
    .from("memory_stores")
    .update(parsed)
    .eq("id", params.id)
    .select()
    .maybeSingle();
  if (error) throw new BadRequest(error.message);
  if (!data) throw new NotFound("Memory store not found");
  return ok(data);
});

router.delete("/stores/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data: existing } = await user.db.from("memory_stores")
    .select("anthropic_id").eq("id", params.id).maybeSingle();
  if (existing?.anthropic_id) {
    try { await AnthropicMemoryStores.archive(existing.anthropic_id); }
    catch (err) { console.warn("[memory] anthropic archive failed:", err); }
  }
  const { error } = await user.db.from("memory_stores").delete().eq("id", params.id);
  if (error) throw new Error(error.message);
  return noContent();
});

router.get("/stores/:id/documents", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("memory_documents")
    .select("*")
    .eq("store_id", params.id)
    .order("path");
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/stores/:id/tables", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("memory_tables")
    .select("*")
    .eq("store_id", params.id)
    .order("name");
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/stores/:id/dreams", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("dreams")
    .select("*")
    .eq("store_id", params.id)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ok({ data });
});

// ---- Query / upsert ----------------------------------------------------

router.post("/query", async (req) => {
  const user = await requireUser(req);
  const parsed = MemoryQuerySchema.parse(await readJson(req));
  if (parsed.path) {
    const { data, error } = await user.db
      .from("memory_documents")
      .select("*")
      .eq("store_id", parsed.store_id)
      .eq("path", parsed.path)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return ok({ document: data });
  }
  if (parsed.table_name) {
    const { data: tableRow, error: tErr } = await user.db
      .from("memory_tables")
      .select("id")
      .eq("store_id", parsed.store_id)
      .eq("name", parsed.table_name)
      .maybeSingle();
    if (tErr) throw new Error(tErr.message);
    if (!tableRow) throw new NotFound("Table not found");

    let q = user.db.from("memory_table_rows").select("*").eq("table_id", tableRow.id).limit(
      parsed.limit,
    );
    if (parsed.where) {
      // Server-side filtering on jsonb keys via @> contains.
      q = q.contains("row", parsed.where);
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return ok({ rows: data ?? [] });
  }
  throw new BadRequest("Provide either `path` or `table_name`");
});

router.post("/upsert/document", async (req) => {
  const user = await requireUser(req);
  const parsed = MemoryDocUpsertSchema.parse(await readJson(req));
  // version_count bump when row already exists.
  const { data: existing } = await user.db
    .from("memory_documents")
    .select("id,version_count")
    .eq("store_id", parsed.store_id)
    .eq("path", parsed.path)
    .maybeSingle();
  const next = (existing?.version_count ?? 0) + 1;
  const upsert = {
    store_id: parsed.store_id,
    path: parsed.path,
    content: parsed.content,
    size_bytes: new TextEncoder().encode(parsed.content).length,
    version_count: next,
  };
  const { data, error } = await user.db
    .from("memory_documents")
    .upsert(upsert, { onConflict: "store_id,path" })
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  try {
    await user.db.rpc("increment_memory_store_versions", { p_store_id: parsed.store_id });
  } catch (_err) {
    // RPC failure should not block the upsert.
  }
  return ok(data);
});

router.post("/upsert/row", async (req) => {
  const user = await requireUser(req);
  const parsed = MemoryRowUpsertSchema.parse(await readJson(req));
  const { data: tableRow } = await user.db
    .from("memory_tables")
    .select("id")
    .eq("store_id", parsed.store_id)
    .eq("name", parsed.table_name)
    .maybeSingle();
  if (!tableRow) throw new NotFound("Table not found");
  if (parsed.row_id) {
    const { data, error } = await user.db
      .from("memory_table_rows")
      .update({ row: parsed.row })
      .eq("id", parsed.row_id)
      .select()
      .maybeSingle();
    if (error) throw new BadRequest(error.message);
    return ok(data);
  }
  const { data, error } = await user.db
    .from("memory_table_rows")
    .insert({ table_id: tableRow.id, row: parsed.row })
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  return ok(data, 201);
});

router.post("/tables", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ store_id: string; name: string; schema?: unknown }>(req);
  const { data, error } = await user.db
    .from("memory_tables")
    .insert({
      store_id: body.store_id,
      name: body.name,
      schema: body.schema ?? { columns: [] },
    })
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  return ok(data, 201);
});

Deno.serve(wrap((req) => router.handle(req)));
