// /functions/v1/vault-connections
//   GET    /                  List the caller's connections.
//   POST   /                  Create a connection. Lazily creates the underlying
//                             Anthropic vault on first use, then registers the
//                             credential. The full auth payload goes straight
//                             through to Anthropic and is never persisted locally.
//   GET    /:id               Get one connection.
//   POST   /:id/check         Force a status refresh.
//   DELETE /:id               Archive the connection on both ends.

import { wrap } from "../_shared/cors.ts";
import { Router, readJson } from "../_shared/router.ts";
import { requireUser } from "../_shared/auth.ts";
import { BadRequest, NotFound, noContent, ok, Upstream } from "../_shared/errors.ts";
import { VaultConnectionCreateSchema } from "../_shared/schemas.ts";
import { AnthropicVaults, AnthropicVaultCredentials } from "../_shared/anthropic.ts";
import { writeAudit } from "../_shared/audit.ts";

const router = new Router("vault-connections");

router.get("/", async (req) => {
  const user = await requireUser(req);
  const { data, error } = await user.db
    .from("vault_connections")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ok({ data });
});

router.get("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data, error } = await user.db.from("vault_connections").select("*").eq("id", params.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Connection not found");
  return ok(data);
});

router.post("/", async (req) => {
  const user = await requireUser(req);
  const parsed = VaultConnectionCreateSchema.parse(await readJson(req));

  // Reuse a single per-user Anthropic vault. Look up by user_id metadata.
  const { data: anyExisting } = await user.db
    .from("vault_connections")
    .select("anthropic_vault_id")
    .eq("user_id", user.id)
    .not("anthropic_vault_id", "is", null)
    .limit(1)
    .maybeSingle();

  let vaultId = anyExisting?.anthropic_vault_id as string | undefined;
  if (!vaultId) {
    try {
      const v = await AnthropicVaults.create({
        display_name: user.email,
        metadata: { user_id: user.id },
      });
      vaultId = v.id;
    } catch (err) {
      throw new Upstream(`Anthropic vault create failed: ${(err as Error).message}`);
    }
  }

  // Register the credential (only if the auth payload was supplied).
  let credentialId: string | undefined;
  if (parsed.auth) {
    try {
      const cred = await AnthropicVaultCredentials.create(vaultId!, {
        display_name: parsed.account_label,
        auth: parsed.auth,
      });
      credentialId = cred.id;
    } catch (err) {
      throw new Upstream(`Anthropic credential create failed: ${(err as Error).message}`);
    }
  }

  const { data: row, error } = await user.db
    .from("vault_connections")
    .insert({
      user_id: user.id,
      connector_id: parsed.connector_id,
      account_label: parsed.account_label,
      scopes: parsed.scopes,
      mcp_server_url: parsed.mcp_server_url ?? null,
      anthropic_vault_id: vaultId ?? null,
      anthropic_credential_id: credentialId ?? null,
      status: parsed.auth ? "connected" : "never",
      connected_at: parsed.auth ? new Date().toISOString() : null,
    })
    .select()
    .single();
  if (error) throw new BadRequest(error.message);
  await writeAudit({
    actor_id: user.id,
    action: "vault_connection.create",
    resource_type: "vault_connection",
    resource_id: row.id,
  });
  return ok(row, 201);
});

router.post("/:id/check", async (req, params) => {
  const user = await requireUser(req);
  // Stub: we'd hit /v1/vaults/:id/credentials/:cid/mcp_oauth_validate and map
  // the response to status. Recorded as TODO for v1.
  const { data, error } = await user.db
    .from("vault_connections")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", params.id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return ok(data);
});

router.delete("/:id", async (req, params) => {
  const user = await requireUser(req);
  const { data: existing } = await user.db
    .from("vault_connections")
    .select("anthropic_vault_id,anthropic_credential_id")
    .eq("id", params.id)
    .maybeSingle();
  if (!existing) throw new NotFound("Connection not found");
  if (existing.anthropic_vault_id && existing.anthropic_credential_id) {
    try {
      await AnthropicVaultCredentials.archive(
        existing.anthropic_vault_id,
        existing.anthropic_credential_id,
      );
    } catch (err) {
      console.warn("anthropic credential archive failed:", err);
    }
  }
  const { error } = await user.db.from("vault_connections").delete().eq("id", params.id);
  if (error) throw new Error(error.message);
  return noContent();
});

Deno.serve(wrap((req) => router.handle(req)));
