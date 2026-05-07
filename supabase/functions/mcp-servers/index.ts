// /functions/v1/mcp-servers
//   GET    /         List the caller's MCP server registrations.
//   POST   /         Register a new MCP server.
//   PATCH  /:id      Update.
//   DELETE /:id      Delete.

import { wrap } from "../_shared/cors.ts";
import { Router, readJson } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { BadRequest, NotFound, noContent, ok } from "../_shared/errors.ts";
import { McpServerCreateSchema, McpServerUpdateSchema } from "../_shared/schemas.ts";

const router = new Router("mcp-servers");

router.get("/", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("mcp_servers").select("*").order("created_at");
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.post("/", async (req) => {
  const user = await requireUser(req);
  const parsed = McpServerCreateSchema.parse(await readJson(req));
  const { data, error } = await user.db
    .from("mcp_servers")
    .insert({ ...parsed, created_by: user.id })
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  return ok(data, 201);
});

router.patch("/:id", async (req, params) => {
  const user = await requireUser(req);
  const parsed = McpServerUpdateSchema.parse(await readJson(req));
  const { data, error } = await user.db
    .from("mcp_servers")
    .update(parsed)
    .eq("id", params.id)
    .select()
    .maybeSingle();
  if (error) throw new BadRequest(error.message);
  if (!data) throw new NotFound("MCP server not found");
  return ok(data);
});

router.delete("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { error } = await user.db.from("mcp_servers").delete().eq("id", params.id);
  if (error) throw new Error(error.message);
  return noContent();
});

Deno.serve(wrap((req) => router.handle(req)));
