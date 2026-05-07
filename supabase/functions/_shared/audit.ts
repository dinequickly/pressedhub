// Append-only audit logger. Edge functions call writeAudit() on every
// non-trivial mutation. Failures here are swallowed because audit writes
// should never block the user-visible operation.

import { serviceClient } from "./supabase.ts";

export async function writeAudit(entry: {
  actor_id?: string | null;
  action: string;
  resource_type: string;
  resource_id?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const sc = serviceClient();
    await sc.from("audit_log").insert({
      actor_id: entry.actor_id ?? null,
      action: entry.action,
      resource_type: entry.resource_type,
      resource_id: entry.resource_id ?? null,
      metadata: entry.metadata ?? {},
    });
  } catch (err) {
    console.warn("audit write failed:", err);
  }
}
