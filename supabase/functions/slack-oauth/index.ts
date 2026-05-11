// /functions/v1/slack-oauth
//   GET /start      User-initiated. Requires the user JWT in the Authorization
//                   header. Generates a signed state token (so we can recover
//                   the user_id on the callback when there's no JWT in scope)
//                   and 302s to slack.com/oauth/v2/authorize.
//   GET /callback   Public — Slack hits this with ?code&state. Verifies the
//                   state HMAC, exchanges the code for a bot token, persists
//                   the vault_connection row + Anthropic vault credential.
//                   Final redirect to HUB_BASE_URL with a `?slack=connected`
//                   query so the UI can refresh.
//
// JWT verification is OFF on the whole function (set in supabase/config.toml)
// so the callback works. /start re-implements the user check itself; if the
// JWT is missing we just return 401 — the frontend should never hit /start
// without a token anyway.

import { wrap } from "../_shared/cors.ts";
import { Router } from "../_shared/router.ts";
import { BadRequest, Unauthorized, Upstream } from "../_shared/errors.ts";
import { ENV } from "../_shared/env.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";

const router = new Router("slack-oauth");

// Bot scopes the agent will need at runtime. Tweaked here means re-installing
// to every workspace, so be explicit and conservative.
const BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "users:read",
];

function callbackUrl(): string {
  if (!ENV.PUBLIC_FUNCTIONS_URL) {
    throw new Upstream("PUBLIC_FUNCTIONS_URL not set; can't build Slack callback URL");
  }
  return `${ENV.PUBLIC_FUNCTIONS_URL.replace(/\/$/, "")}/slack-oauth/callback`;
}

function b64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

// Encode { user_id, nonce, exp } and sign with the Slack signing secret.
// Returns `payload.signature` (b64url). 10-minute TTL so an abandoned dance
// can't be replayed forever.
async function signState(userId: string): Promise<string> {
  const payload = {
    user_id: userId,
    nonce: b64urlEncode(crypto.getRandomValues(new Uint8Array(8))),
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = b64urlEncode(await hmac(ENV.SLACK_SIGNING_SECRET, body));
  return `${body}.${sig}`;
}

async function verifyState(state: string): Promise<{ user_id: string }> {
  const [body, sig] = state.split(".");
  if (!body || !sig) throw new BadRequest("Invalid state format");
  const expected = b64urlEncode(await hmac(ENV.SLACK_SIGNING_SECRET, body));
  if (expected !== sig) throw new BadRequest("Invalid state signature");
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new BadRequest("State expired — restart the OAuth flow");
  }
  if (!payload.user_id) throw new BadRequest("State missing user_id");
  return { user_id: payload.user_id as string };
}

// Returns `{ url }` for the frontend to navigate to. We can't 302 directly
// because browser navigation strips Authorization headers — the SPA fetches
// this with a JWT, then sets window.location to the returned Slack URL.
router.get("/start", async (req) => {
  if (!ENV.SLACK_CLIENT_ID) throw new Upstream("SLACK_CLIENT_ID not set");
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) throw new Unauthorized("Missing Bearer token");
  const jwt = auth.slice("Bearer ".length);
  const db = userClient(jwt);
  const { data: userResp, error } = await db.auth.getUser(jwt);
  if (error || !userResp.user) throw new Unauthorized(error?.message ?? "Invalid JWT");

  const state = await signState(userResp.user.id);
  const params = new URLSearchParams({
    client_id: ENV.SLACK_CLIENT_ID,
    scope: BOT_SCOPES.join(","),
    user_scope: "",
    redirect_uri: callbackUrl(),
    state,
  });
  return new Response(
    JSON.stringify({ url: `https://slack.com/oauth/v2/authorize?${params}` }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});

router.get("/callback", async (req) => {
  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) {
    return bounceToHub(`?slack=denied&error=${encodeURIComponent(error)}`);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new BadRequest("Missing code or state");
  const { user_id } = await verifyState(state);

  // Exchange the temporary code for a bot token.
  const exchange = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ENV.SLACK_CLIENT_ID,
      client_secret: ENV.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(),
    }),
  });
  const tokenJson = await exchange.json() as {
    ok: boolean;
    error?: string;
    access_token?: string;
    bot_user_id?: string;
    app_id?: string;
    scope?: string;
    team?: { id?: string; name?: string };
  };
  if (!tokenJson.ok || !tokenJson.access_token) {
    throw new Upstream(`Slack oauth.v2.access failed: ${tokenJson.error ?? "unknown"}`);
  }

  const sc = serviceClient();

  const accountLabel = tokenJson.team?.name
    ? `Slack · ${tokenJson.team.name}`
    : "Slack workspace";

  // We deliberately don't push this credential into Anthropic Vault.
  // Anthropic's vault only supports MCP-bound credentials (static_bearer or
  // mcp_oauth, both requiring an mcp_server_url). We don't run a Slack MCP
  // server today — the agent's Slack capabilities are wired as custom tools
  // that read this bot_token from `metadata` and call slack.com directly.
  // If we add an MCP server later, this is the place to also register a
  // static_bearer credential with that MCP URL.
  const { error: insertErr } = await sc.from("vault_connections").upsert({
    user_id,
    connector_id: "slack",
    account_label: accountLabel,
    scopes: (tokenJson.scope ?? "").split(",").filter(Boolean),
    anthropic_vault_id: null,
    anthropic_credential_id: null,
    status: "connected",
    connected_at: new Date().toISOString(),
    metadata: {
      team_id: tokenJson.team?.id ?? null,
      team_name: tokenJson.team?.name ?? null,
      app_id: tokenJson.app_id ?? null,
      bot_user_id: tokenJson.bot_user_id ?? null,
      // Bot token is sensitive; this row is RLS-gated to user_id and the
      // GET /vault-connections endpoint never returns it (we'll mask it
      // server-side when the UI lists connections).
      bot_token: tokenJson.access_token,
    },
  }, { onConflict: "user_id,connector_id,account_label" });
  if (insertErr) throw new Upstream(`vault_connections upsert: ${insertErr.message}`);

  return bounceToHub("?slack=connected");
});

function bounceToHub(query: string): Response {
  const base = ENV.HUB_BASE_URL || "/";
  return new Response(null, {
    status: 302,
    headers: { Location: `${base.replace(/\/$/, "")}/profile${query}` },
  });
}

Deno.serve(wrap((req) => router.handle(req)));
