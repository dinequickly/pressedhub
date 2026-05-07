// /functions/v1/connectors
//   GET /             List all connectors (auth required).
//   GET /:id          Get a single connector definition.

import { wrap } from "../_shared/cors.ts";
import { Router } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { NotFound, ok } from "../_shared/errors.ts";

const router = new Router("connectors");

router.get("/", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("connectors").select("*").order("name");
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("connectors")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Connector not found");
  return ok(data);
});

Deno.serve(wrap((req) => router.handle(req)));
