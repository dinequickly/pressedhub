// /functions/v1/profiles
//   GET    /me                    Return the caller's profile.
//   GET    /                      List profiles (admin only).
//   PATCH  /me                    Update display name / tint.
//   POST   /bootstrap-admin       Promote the first user in the system to admin.
//   POST   /:id/promote           Promote a user to admin (admin only).

import { wrap } from "../_shared/cors.ts";
import { Router, readJson } from "../_shared/router.ts";
import { requireAdmin, requireUser } from "../_shared/auth.ts";
import { ok } from "../_shared/errors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { writeAudit } from "../_shared/audit.ts";

const router = new Router("profiles");

router.get("/me", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("profiles").select("*").eq("id", user.id).single();
  if (error) throw new Error(error.message);
  return ok(data);
});

router.patch("/me", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ name?: string; tint?: string }>(req);
  const update: Record<string, unknown> = {};
  if (body.name) {
    update.name = body.name;
    update.initial = body.name.slice(0, 1).toUpperCase();
  }
  if (body.tint) update.tint = body.tint;
  const { data, error } = await user.db
    .from("profiles")
    .update(update)
    .eq("id", user.id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return ok(data);
});

router.get("/", async (req) => {
  const user = await requireUser(req);
  requireAdmin(user);
  const { data, error } = await user.db.from("profiles").select("*").order("created_at");
  if (error) throw new Error(error.message);
  return ok({ data });
});

// Idempotent: if there are no admins yet, promote the *first user by created_at*
// to admin. Anyone can call it; it fails silently if an admin already exists.
router.post("/bootstrap-admin", async (req) => {
  const user = await requireUser(req);
  const sc = serviceClient();
  const { count } = await sc
    .from("profiles")
    .select("*", { count: "exact", head: true })
    .eq("role", "admin");
  if ((count ?? 0) > 0) {
    return ok({ promoted: false, reason: "Admin already exists" });
  }
  const { data: first, error } = await sc
    .from("profiles")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (error || !first) throw new Error(error?.message ?? "No profiles");
  await sc.from("profiles").update({ role: "admin" }).eq("id", first.id);
  await writeAudit({
    actor_id: user.id,
    action: "bootstrap_admin",
    resource_type: "profile",
    resource_id: first.id,
  });
  return ok({ promoted: true, profile_id: first.id });
});

router.post("/:id/promote", async (req, params) => {
  const user = await requireUser(req);
  requireAdmin(user);
  const sc = serviceClient();
  const { error } = await sc.from("profiles").update({ role: "admin" }).eq("id", params.id);
  if (error) throw new Error(error.message);
  await writeAudit({
    actor_id: user.id,
    action: "promote_admin",
    resource_type: "profile",
    resource_id: params.id,
  });
  return ok({ promoted: true });
});

Deno.serve(wrap((req) => router.handle(req)));
