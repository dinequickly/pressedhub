// JWT verification + caller resolution. Edge functions call requireUser()
// at the top of every handler that needs a logged-in caller.

import { Forbidden, Unauthorized } from "./errors.ts";
import { serviceClient, userClient } from "./supabase.ts";

export type AuthedUser = {
  id: string;
  email: string;
  role: "admin" | "member";
  jwt: string;
  /** Supabase client scoped to this user's JWT. RLS applies. */
  db: ReturnType<typeof userClient>;
};

export async function requireUser(req: Request): Promise<AuthedUser> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    throw new Unauthorized("Missing Bearer token");
  }
  const jwt = auth.slice("Bearer ".length);
  const db = userClient(jwt);
  const { data: userResp, error } = await db.auth.getUser(jwt);
  if (error || !userResp.user) {
    throw new Unauthorized(error?.message ?? "Invalid JWT");
  }
  const authUser = userResp.user;
  // Look up the application-level profile to resolve role. Use the service
  // client so we can fetch even if RLS would block the user (it shouldn't
  // here, but defense in depth).
  const sc = serviceClient();
  const { data: profile, error: profErr } = await sc
    .from("profiles")
    .select("id,email,role")
    .eq("id", authUser.id)
    .maybeSingle();
  if (profErr) throw new Unauthorized(profErr.message);
  if (!profile) throw new Unauthorized("Profile row missing for user");
  return {
    id: profile.id,
    email: profile.email,
    role: profile.role,
    jwt,
    db,
  };
}

export function requireAdmin(user: AuthedUser): void {
  if (user.role !== "admin") {
    throw new Forbidden("Admin role required");
  }
}
