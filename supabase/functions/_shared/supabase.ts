// Supabase client factories.
// - serviceClient: bypasses RLS. Used for cross-user reads and inserts the
//   user is allowed to make but our RLS policy can't easily express (eg
//   audit_log inserts).
// - userClient: scoped to the caller's JWT. Use this for any mutation a user
//   could legitimately do via RLS, so the policies stay enforced.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { ENV } from "./env.ts";

export function serviceClient(): SupabaseClient {
  return createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "X-Client-Info": "hubbackend-edge-function/service" } },
  });
}

export function userClient(jwt: string): SupabaseClient {
  return createClient(ENV.SUPABASE_URL, ENV.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-Client-Info": "hubbackend-edge-function/user",
      },
    },
  });
}

export type { SupabaseClient };
