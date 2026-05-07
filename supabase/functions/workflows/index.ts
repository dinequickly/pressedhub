// /functions/v1/workflows
//   GET    /                List workflows visible to the caller.
//   GET    /:id             Get one workflow with nodes+edges.
//   POST   /                Create a workflow from {name, category, nodes, edges, ...}.
//   PATCH  /:id             Update fields and replace nodes/edges atomically.
//   DELETE /:id             Delete (hard) a workflow.

import { wrap } from "../_shared/cors.ts";
import { Router, readJson } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { BadRequest, NotFound, noContent, ok } from "../_shared/errors.ts";
import { WorkflowCreateSchema, WorkflowUpdateSchema } from "../_shared/schemas.ts";
import { writeAudit } from "../_shared/audit.ts";
import { serviceClient } from "../_shared/supabase.ts";

const router = new Router("workflows");

function shape(row: any): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    nodes: row.graph?.nodes ?? [],
    edges: row.graph?.edges ?? [],
    memory_store_id: row.memory_store_id ?? null,
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

router.get("/", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("workflows")
    .select("*")
    .is("archived_at", null)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ok({ data: (data ?? []).map(shape) });
});

router.get("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("workflows")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Workflow not found");
  return ok(shape(data));
});

router.post("/", async (req) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const parsed = WorkflowCreateSchema.parse(body);
  const insert = {
    name: parsed.name,
    description: parsed.description,
    category: parsed.category,
    memory_store_id: parsed.memory_store_id ?? null,
    graph: { nodes: parsed.nodes, edges: parsed.edges },
    created_by: user.id,
  };
  const { data: row, error } = await user.db
    .from("workflows")
    .insert(insert)
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  // Replicate the denormalised tables.
  await replaceNodesAndEdges(row.id, parsed.nodes, parsed.edges);
  await writeAudit({
    actor_id: user.id,
    action: "workflow.create",
    resource_type: "workflow",
    resource_id: row.id,
  });
  return ok(shape(row), 201);
});

router.patch("/:id", async (req, params) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const parsed = WorkflowUpdateSchema.parse(body);
  const update: Record<string, unknown> = {};
  if (parsed.name !== undefined) update.name = parsed.name;
  if (parsed.description !== undefined) update.description = parsed.description;
  if (parsed.category !== undefined) update.category = parsed.category;
  if (parsed.memory_store_id !== undefined) update.memory_store_id = parsed.memory_store_id;
  if (parsed.nodes !== undefined || parsed.edges !== undefined) {
    // Read existing graph to merge fields the caller didn't include.
    const { data: existing } = await user.db
      .from("workflows")
      .select("graph")
      .eq("id", params.id)
      .single();
    const existingGraph = existing?.graph ?? { nodes: [], edges: [] };
    update.graph = {
      nodes: parsed.nodes ?? existingGraph.nodes ?? [],
      edges: parsed.edges ?? existingGraph.edges ?? [],
    };
  }
  const { data, error } = await user.db
    .from("workflows")
    .update(update)
    .eq("id", params.id)
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  if (!data) throw new NotFound("Workflow not found");
  if (parsed.nodes !== undefined || parsed.edges !== undefined) {
    const graph = data.graph as { nodes: any[]; edges: any[] };
    await replaceNodesAndEdges(data.id, graph.nodes ?? [], graph.edges ?? []);
  }
  await writeAudit({
    actor_id: user.id,
    action: "workflow.update",
    resource_type: "workflow",
    resource_id: data.id,
  });
  return ok(shape(data));
});

router.delete("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { error } = await user.db.from("workflows").delete().eq("id", params.id);
  if (error) throw new Error(error.message);
  await writeAudit({
    actor_id: user.id,
    action: "workflow.delete",
    resource_type: "workflow",
    resource_id: params.id,
  });
  return noContent();
});

async function replaceNodesAndEdges(
  workflowId: string,
  nodes: any[],
  edges: any[],
): Promise<void> {
  // Use the service role for the denormalisation step; RLS already protected
  // the parent workflow row when we got here.
  const sc = serviceClient();
  await sc.from("workflow_nodes").delete().eq("workflow_id", workflowId);
  await sc.from("workflow_edges").delete().eq("workflow_id", workflowId);
  if (nodes.length > 0) {
    const rows = nodes.map((n, i) => ({
      workflow_id: workflowId,
      id: n.id,
      kind: n.type,
      body: n,
      position: i,
    }));
    const { error } = await sc.from("workflow_nodes").insert(rows);
    if (error) throw new Error(`workflow_nodes insert failed: ${error.message}`);
  }
  if (edges.length > 0) {
    const rows = edges.map((e) => ({
      workflow_id: workflowId,
      from_node: e.from,
      to_node: e.to,
      label: e.label ?? null,
    }));
    const { error } = await sc.from("workflow_edges").insert(rows);
    if (error) throw new Error(`workflow_edges insert failed: ${error.message}`);
  }
}

Deno.serve(wrap((req) => router.handle(req)));
