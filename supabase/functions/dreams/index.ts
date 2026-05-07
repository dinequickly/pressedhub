// /functions/v1/dreams
//   GET    /                    List pending dreams for this caller's stores.
//   GET    /:id                 Get one.
//   POST   /                    Create a dream proposal {store_id, instructions, new_snapshot}.
//   POST   /:id/decide          { decision: "approve" | "reject" } — applies or discards.

import { wrap } from "../_shared/cors.ts";
import { Router, readJson } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { BadRequest, NotFound, ok } from "../_shared/errors.ts";
import { DreamDecideSchema } from "../_shared/schemas.ts";
import { writeAudit } from "../_shared/audit.ts";

const router = new Router("dreams");

router.get("/", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("dreams")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("dreams").select("*").eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Dream not found");
  return ok(data);
});

router.post("/", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{
    store_id: string;
    instructions?: string;
    new_snapshot: Array<{ path: string; content: string }>;
  }>(req);
  if (!body.store_id || !Array.isArray(body.new_snapshot)) {
    throw new BadRequest("store_id and new_snapshot are required");
  }
  // Snapshot the current state for diff rendering.
  const { data: docs } = await user.db
    .from("memory_documents")
    .select("path,content")
    .eq("store_id", body.store_id);
  const oldSnapshot = (docs ?? []).map((d) => ({ path: d.path, content: d.content }));
  const oldByPath = new Map(oldSnapshot.map((d) => [d.path, d.content]));
  const newByPath = new Map(body.new_snapshot.map((d) => [d.path, d.content]));
  const added: Array<{ path: string; content: string }> = [];
  const removed: Array<{ path: string; content: string }> = [];
  const changed: Array<{ path: string; before: string; after: string }> = [];
  for (const [p, c] of newByPath) {
    const before = oldByPath.get(p);
    if (before === undefined) added.push({ path: p, content: c });
    else if (before !== c) changed.push({ path: p, before, after: c });
  }
  for (const [p, c] of oldByPath) {
    if (!newByPath.has(p)) removed.push({ path: p, content: c });
  }
  const { data: row, error } = await user.db
    .from("dreams")
    .insert({
      store_id: body.store_id,
      status: "pending",
      old_snapshot: oldSnapshot,
      new_snapshot: body.new_snapshot,
      diff: { added, removed, changed },
      instructions: body.instructions ?? null,
      created_by: user.id,
    })
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  await writeAudit({
    actor_id: user.id,
    action: "dream.create",
    resource_type: "dream",
    resource_id: row.id,
  });
  return ok(row, 201);
});

router.post("/:id/decide", async (req, params) => {
  const user = await requireUser(req);
  const parsed = DreamDecideSchema.parse(await readJson(req));
  const { data: dream } = await user.db.from("dreams").select("*").eq("id", params.id)
    .maybeSingle();
  if (!dream) throw new NotFound("Dream not found");
  if (dream.status !== "pending") throw new BadRequest("Dream is not pending");

  if (parsed.decision === "approve") {
    // Apply the new_snapshot to memory_documents in place. Each upserted doc
    // bumps version_count by one for visibility on the UI side.
    for (const doc of dream.new_snapshot as Array<{ path: string; content: string }>) {
      const { data: existing } = await user.db
        .from("memory_documents")
        .select("version_count")
        .eq("store_id", dream.store_id)
        .eq("path", doc.path)
        .maybeSingle();
      const version_count = (existing?.version_count ?? 0) + 1;
      await user.db.from("memory_documents").upsert({
        store_id: dream.store_id,
        path: doc.path,
        content: doc.content,
        size_bytes: new TextEncoder().encode(doc.content).length,
        version_count,
      }, { onConflict: "store_id,path" });
    }
    // Remove docs that no longer exist in the new snapshot.
    const newPaths = (dream.new_snapshot as Array<{ path: string }>).map((d) => d.path);
    await user.db
      .from("memory_documents")
      .delete()
      .eq("store_id", dream.store_id)
      .not("path", "in", `(${newPaths.map((p) => `"${p}"`).join(",")})`);
  }

  const { data, error } = await user.db
    .from("dreams")
    .update({
      status: parsed.decision === "approve" ? "approved" : "rejected",
      ended_at: new Date().toISOString(),
    })
    .eq("id", params.id)
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  await writeAudit({
    actor_id: user.id,
    action: `dream.${parsed.decision}`,
    resource_type: "dream",
    resource_id: params.id,
  });
  return ok(data);
});

Deno.serve(wrap((req) => router.handle(req)));
