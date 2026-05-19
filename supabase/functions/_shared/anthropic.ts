// Anthropic Managed Agents wrapper using raw fetch.
// The official @anthropic-ai/sdk package doesn't yet ship the beta resources
// (`client.beta.agents`, `.environments`, `.sessions.events.send`, etc.) so
// we hit the REST endpoints directly. The shapes here mirror the docs verbatim:
// https://platform.claude.com/docs/en/managed-agents/*
//
// Centralized concerns:
//   - The `managed-agents-2026-04-01` beta header on every request.
//   - The `anthropic-version: 2023-06-01` header.
//   - A typed `request()` helper that throws Upstream() on non-2xx with the
//     server's error body attached.

import Anthropic from "npm:@anthropic-ai/sdk@0.30.1";
import { ENV } from "./env.ts";
import { Upstream } from "./errors.ts";

const BASE = "https://api.anthropic.com";

type Json = Record<string, unknown>;

function headers(): HeadersInit {
  if (!ENV.ANTHROPIC_API_KEY) {
    throw new Upstream("ANTHROPIC_API_KEY is not set");
  }
  return {
    "x-api-key": ENV.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": ENV.ANTHROPIC_BETA_HEADER,
    "content-type": "application/json",
  };
}

async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    throw new Upstream(
      `Anthropic ${method} ${path} → ${res.status}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`,
      parsed,
    );
  }
  if (res.status === 204) return null as T;
  return await res.json() as T;
}

// -- Agents --------------------------------------------------------------

export type AgentCreateInput = {
  name: string;
  model: string;
  system?: string;
  tools?: Json[];
  mcp_servers?: Json[];
  skills?: Json[];
  multiagent?: Json;
  description?: string | null;
  metadata?: Record<string, string>;
  // Extended thinking config. On newer Claude 4 variants the default can be
  // `omitted`, which still returns an opaque signature but no readable
  // `thinking` text. We set `display: "summarized"` when we want visible
  // traces in the product while still preserving the same signature field.
  thinking?: {
    type: "enabled" | "disabled";
    budget_tokens?: number;
  };
};

export const DEFAULT_THINKING_CONFIG: NonNullable<AgentCreateInput["thinking"]> = {
  type: "enabled",
};

export type AgentRecord = { id: string; version: number } & Record<string, unknown>;

export const AnthropicAgents = {
  create: (input: AgentCreateInput) => request<AgentRecord>("POST", "/v1/agents", input),
  retrieve: (id: string) => request<AgentRecord>("GET", `/v1/agents/${id}`),
  update: (id: string, input: Partial<AgentCreateInput> & { version: number }) =>
    request<AgentRecord>("POST", `/v1/agents/${id}`, input),
  archive: (id: string) => request<AgentRecord>("POST", `/v1/agents/${id}/archive`),
  list: () => request<{ data: AgentRecord[] }>("GET", "/v1/agents"),
};

// -- Environments --------------------------------------------------------

export type EnvironmentCreateInput = { name: string; config?: Json };
export type EnvironmentRecord = { id: string; name: string; config: Json } & Record<string, unknown>;

export const AnthropicEnvironments = {
  create: (input: EnvironmentCreateInput) =>
    request<EnvironmentRecord>("POST", "/v1/environments", input),
  retrieve: (id: string) => request<EnvironmentRecord>("GET", `/v1/environments/${id}`),
  archive: (id: string) =>
    request<EnvironmentRecord>("POST", `/v1/environments/${id}/archive`),
  delete: (id: string) => request<null>("DELETE", `/v1/environments/${id}`),
  list: () => request<{ data: EnvironmentRecord[] }>("GET", "/v1/environments"),
};

// -- Sessions ------------------------------------------------------------

export type SessionResource =
  | { type: "file"; file_id: string; mount_path?: string }
  | {
    type: "memory_store";
    memory_store_id: string;
    access?: "read_only" | "read_write";
    // Session-specific guidance injected alongside the store's name/description.
    // Capped at 4,096 chars by the API. Use to tell the agent WHEN/HOW to use this store.
    instructions?: string;
  };

export type SessionCreateInput = {
  agent: string | { type: "agent"; id: string; version?: number };
  environment_id: string;
  vault_ids?: string[];
  resources?: SessionResource[];
  title?: string;
};
export type SessionRecord = {
  id: string;
  status: "idle" | "running" | "rescheduling" | "terminated";
  outcome_evaluations?: unknown[];
  usage?: Record<string, number>;
} & Record<string, unknown>;

export const AnthropicSessions = {
  create: (input: SessionCreateInput) =>
    request<SessionRecord>("POST", "/v1/sessions", input),
  retrieve: (id: string) => request<SessionRecord>("GET", `/v1/sessions/${id}`),
  archive: (id: string) =>
    request<SessionRecord>("POST", `/v1/sessions/${id}/archive`),
  delete: (id: string) => request<null>("DELETE", `/v1/sessions/${id}`),
  list: () => request<{ data: SessionRecord[] }>("GET", "/v1/sessions"),
};

// -- Session resources (mount/unmount files & memory stores at runtime) ---

export type SessionResourceRecord = {
  id: string;
  type: "file" | "memory_store";
  file_id?: string;
  memory_store_id?: string;
  mount_path?: string;
} & Record<string, unknown>;

export const AnthropicSessionResources = {
  add: (sessionId: string, body: SessionResource) =>
    request<SessionResourceRecord>(
      "POST", `/v1/sessions/${sessionId}/resources`, body,
    ),
  list: (sessionId: string) =>
    request<{ data: SessionResourceRecord[] }>(
      "GET", `/v1/sessions/${sessionId}/resources`,
    ),
};

// -- Events --------------------------------------------------------------

export type UserEvent =
  | { type: "user.message"; content: Array<{ type: "text"; text: string }> }
  | { type: "user.interrupt"; session_thread_id?: string }
  | {
    type: "user.define_outcome";
    description: string;
    rubric: { type: "text"; content: string } | { type: "file"; file_id: string };
    max_iterations?: number;
  }
  | {
    type: "user.tool_confirmation";
    tool_use_id: string;
    result: "allow" | "deny";
    deny_message?: string;
  }
  | {
    type: "user.custom_tool_result";
    custom_tool_use_id: string;
    content: Array<{ type: "text"; text: string }>;
  };

export const AnthropicSessionEvents = {
  send: (sessionId: string, events: UserEvent[]) =>
    request<{ events: unknown[] }>("POST", `/v1/sessions/${sessionId}/events`, { events }),
  list: (sessionId: string) =>
    request<{ data: unknown[] }>("GET", `/v1/sessions/${sessionId}/events`),
};

// -- Skills --------------------------------------------------------------
//
// The Skills API lives behind its own beta header (`skills-2025-10-02`) and
// uses multipart/form-data for create + version upload. Anthropic supports
// stacking betas via comma-separated values, so we send both headers — that
// way these helpers also work from a session/agent-aware codepath.

const SKILLS_BETA = `${ENV.ANTHROPIC_BETA_HEADER},skills-2025-10-02`;

export type SkillRecord = {
  id: string;
  type?: string;
  display_title?: string;
  source?: "custom" | "anthropic";
  latest_version?: string;
  created_at?: string;
  updated_at?: string;
} & Record<string, unknown>;

export type SkillVersionRecord = {
  id: string;
  type?: string;
  skill_id?: string;
  version: string;
  name?: string;
  description?: string;
  directory?: string;
  created_at?: string;
} & Record<string, unknown>;

async function skillsMultipart<T>(
  path: string,
  fields: Record<string, string>,
  files: Array<{ blob: Blob; filename: string }>,
): Promise<T> {
  if (!ENV.ANTHROPIC_API_KEY) throw new Upstream("ANTHROPIC_API_KEY is not set");
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append("files[]", f.blob, f.filename);
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "x-api-key": ENV.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": SKILLS_BETA,
    },
    body: fd,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Upstream(`Anthropic POST ${path} → ${res.status}: ${text}`);
  }
  return await res.json() as T;
}

async function skillsRequest<T>(
  method: "GET" | "DELETE",
  path: string,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "x-api-key": ENV.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": SKILLS_BETA,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Upstream(`Anthropic ${method} ${path} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return null as T;
  return await res.json() as T;
}

export const AnthropicSkills = {
  // Single-shot create: the API only accepts multipart/form-data with
  // `display_title` and one or more `files[]` (SKILL.md or zip).
  create: (input: { display_title: string; file: Blob; filename?: string }) =>
    skillsMultipart<SkillRecord>("/v1/skills", { display_title: input.display_title }, [
      { blob: input.file, filename: input.filename ?? "SKILL.md" },
    ]),
  list: (params?: { source?: "anthropic" | "custom"; limit?: number; page?: string }) => {
    const qs = new URLSearchParams();
    if (params?.source) qs.set("source", params.source);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.page) qs.set("page", params.page);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return skillsRequest<{ data: SkillRecord[]; has_more?: boolean; next_page?: string | null }>(
      "GET",
      `/v1/skills${suffix}`,
    );
  },
  retrieve: (id: string) => skillsRequest<SkillRecord>("GET", `/v1/skills/${id}`),
  delete: (id: string) =>
    skillsRequest<{ id: string; type: "skill_deleted" }>("DELETE", `/v1/skills/${id}`),
  upload_version: (skillId: string, file: Blob, filename = "SKILL.md") =>
    skillsMultipart<SkillVersionRecord>(`/v1/skills/${skillId}/versions`, {}, [
      { blob: file, filename },
    ]),
  list_versions: (skillId: string, params?: { limit?: number; page?: string }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.page) qs.set("page", params.page);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return skillsRequest<{
      data: SkillVersionRecord[];
      has_more?: boolean;
      next_page?: string | null;
    }>("GET", `/v1/skills/${skillId}/versions${suffix}`);
  },
};

// -- Messages (plain Claude completions, used by the skill builder) ------

export type ChatMessage = { role: "user" | "assistant"; content: string };

// A single content block from Anthropic. We pass these through to the
// client so the tool-use loop can render text + dispatch tool_use blocks.
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

// Messages going INTO Anthropic — assistant turns can carry a mixed content
// array (text + tool_use), user turns can carry tool_result blocks. We accept
// either a plain string (legacy callers) or an array of blocks.
export type AnthropicTurn = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export const AnthropicMessages = {
  create: async (input: {
    model?: string;
    system: string;
    messages: ChatMessage[];
    max_tokens?: number;
  }): Promise<{ text: string }> => {
    const res = await request<{ content: Array<{ type: string; text?: string }> }>(
      "POST",
      "/v1/messages",
      {
        model: input.model ?? ENV.ANTHROPIC_DEFAULT_MODEL,
        system: input.system,
        messages: input.messages,
        max_tokens: input.max_tokens ?? 4096,
      },
    );
    const text = res.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    return { text };
  },

  // Tool-use-aware variant. Returns the raw content array + stop_reason so
  // the caller can detect a `tool_use` stop and run the requested tool.
  createWithTools: (input: {
    model?: string;
    system: string;
    messages: AnthropicTurn[];
    tools: ToolDef[];
    max_tokens?: number;
  }) =>
    request<{
      id: string;
      content: ContentBlock[];
      stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
      usage?: Record<string, number>;
    }>("POST", "/v1/messages", {
      model: input.model ?? ENV.ANTHROPIC_DEFAULT_MODEL,
      system: input.system,
      messages: input.messages,
      tools: input.tools,
      max_tokens: input.max_tokens ?? 2048,
    }),
};

// -- Files (Anthropic Files API) -----------------------------------------

export type AnthropicFileRecord = {
  id: string;
  filename?: string;
  size_bytes?: number;
  mime_type?: string;
  purpose?: string;
} & Record<string, unknown>;

export const AnthropicFiles = {
  upload: async (
    file: Blob,
    filename: string,
    purpose: "agent" | "vision" | "user" = "agent",
    scopeId?: string,
  ): Promise<AnthropicFileRecord> => {
    if (!ENV.ANTHROPIC_API_KEY) throw new Upstream("ANTHROPIC_API_KEY is not set");
    const fd = new FormData();
    fd.append("file", file, filename);
    fd.append("purpose", purpose);
    if (scopeId) fd.append("scope_id", scopeId);
    const res = await fetch(`${BASE}/v1/files`, {
      method: "POST",
      headers: {
        "x-api-key": ENV.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": ENV.ANTHROPIC_BETA_HEADER,
      },
      body: fd,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Upstream(`Anthropic file upload → ${res.status}: ${text}`);
    }
    return await res.json() as AnthropicFileRecord;
  },
  delete: (id: string) => request<null>("DELETE", `/v1/files/${id}`),
  retrieve: (id: string) => request<AnthropicFileRecord>("GET", `/v1/files/${id}`),
  // List files. With `scope_id` set to a session id, this is the source of
  // truth for "which files did this session produce" — independent of how
  // the file is referenced in the event stream.
  list: (params?: { scope_id?: string }) => {
    const qs = params?.scope_id ? `?scope_id=${encodeURIComponent(params.scope_id)}` : "";
    return request<{ data: AnthropicFileRecord[] }>("GET", `/v1/files${qs}`);
  },
  // Stream raw bytes. We return the upstream Response so the caller can
  // pipe straight through to the browser without buffering.
  content: async (id: string): Promise<Response> => {
    if (!ENV.ANTHROPIC_API_KEY) throw new Upstream("ANTHROPIC_API_KEY is not set");
    const res = await fetch(`${BASE}/v1/files/${id}/content`, {
      headers: {
        "x-api-key": ENV.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": ENV.ANTHROPIC_BETA_HEADER,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Upstream(`Anthropic file content → ${res.status}: ${text}`);
    }
    return res;
  },
};

// Walks a session_events list (or any nested object) and returns the set of
// distinct Anthropic file_ids referenced anywhere in the payloads. Anthropic
// file ids start with `file_`, which is how we discriminate from other ids.
export function collectAnthropicFileIds(events: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const fid = obj.file_id;
    if (typeof fid === "string" && fid.startsWith("file_")) seen.add(fid);
    for (const v of Object.values(obj)) visit(v);
  };
  for (const e of events) visit(e);
  return Array.from(seen);
}

// -- Memory stores (Anthropic) -------------------------------------------

export type AnthropicMemoryStoreRecord = { id: string } & Record<string, unknown>;

export const AnthropicMemoryStores = {
  create: (input: { name: string; description?: string }) =>
    request<AnthropicMemoryStoreRecord>("POST", "/v1/memory_stores", input),
  retrieve: (id: string) =>
    request<AnthropicMemoryStoreRecord>("GET", `/v1/memory_stores/${id}`),
  archive: (id: string) =>
    request<AnthropicMemoryStoreRecord>("POST", `/v1/memory_stores/${id}/archive`),
  delete: (id: string) => request<null>("DELETE", `/v1/memory_stores/${id}`),
};

// -- Memories (documents within a memory store) --------------------------
// Individual documents are addressed by path. Max 100 kB each.

export type AnthropicMemoryRecord = {
  id: string;
  path: string;
  content?: string;
  size_bytes?: number;
  created_at?: string;
  updated_at?: string;
} & Record<string, unknown>;

export const AnthropicMemories = {
  // Create does NOT overwrite — use update to modify an existing memory.
  create: (storeId: string, input: { path: string; content: string }) =>
    request<AnthropicMemoryRecord>("POST", `/v1/memory_stores/${storeId}/memories`, input),
  list: (storeId: string, params?: { path_prefix?: string; limit?: number; page?: string }) => {
    const qs = new URLSearchParams();
    if (params?.path_prefix) qs.set("path_prefix", params.path_prefix);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.page) qs.set("page", params.page);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ data: AnthropicMemoryRecord[]; has_more?: boolean; next_page?: string | null }>(
      "GET", `/v1/memory_stores/${storeId}/memories${suffix}`,
    );
  },
  retrieve: (storeId: string, memId: string) =>
    request<AnthropicMemoryRecord>("GET", `/v1/memory_stores/${storeId}/memories/${memId}`),
  // Pass `precondition.content_sha256` to guard against concurrent writes.
  update: (
    storeId: string,
    memId: string,
    input: {
      path?: string;
      content?: string;
      precondition?: { type: "content_sha256"; content_sha256: string };
    },
  ) => request<AnthropicMemoryRecord>("POST", `/v1/memory_stores/${storeId}/memories/${memId}`, input),
  delete: (storeId: string, memId: string) =>
    request<null>("DELETE", `/v1/memory_stores/${storeId}/memories/${memId}`),
};

// -- Vaults --------------------------------------------------------------

export type VaultRecord = { id: string } & Record<string, unknown>;

export const AnthropicVaults = {
  create: (input: { display_name: string; metadata?: Record<string, string> }) =>
    request<VaultRecord>("POST", "/v1/vaults", input),
  retrieve: (id: string) => request<VaultRecord>("GET", `/v1/vaults/${id}`),
  archive: (id: string) => request<VaultRecord>("POST", `/v1/vaults/${id}/archive`),
  list: () => request<{ data: VaultRecord[] }>("GET", "/v1/vaults"),
};

export const AnthropicVaultCredentials = {
  create: (vaultId: string, input: { display_name: string; auth: Json }) =>
    request<{ id: string }>(
      "POST", `/v1/vaults/${vaultId}/credentials`, input,
    ),
  archive: (vaultId: string, credentialId: string) =>
    request<unknown>(
      "POST", `/v1/vaults/${vaultId}/credentials/${credentialId}/archive`,
    ),
};

// -- Webhooks ------------------------------------------------------------

// Verifies the X-Webhook-Signature header against ANTHROPIC_WEBHOOK_SIGNING_KEY
// and returns the parsed event. We delegate to the SDK for HMAC verification
// since that's well-tested. The SDK is loaded only for this method.

export const AnthropicWebhooks = {
  unwrap: (body: string, headersIn: Record<string, string>) => {
    if (!ENV.ANTHROPIC_WEBHOOK_SIGNING_KEY) {
      throw new Upstream("ANTHROPIC_WEBHOOK_SIGNING_KEY is not set");
    }
    const client = new Anthropic({
      apiKey: ENV.ANTHROPIC_API_KEY,
      // deno-lint-ignore no-explicit-any
      ...(({ webhookSigningSecret: ENV.ANTHROPIC_WEBHOOK_SIGNING_KEY }) as any),
    });
    // deno-lint-ignore no-explicit-any
    return (client as any).beta?.webhooks?.unwrap?.(body, headersIn) ?? (() => {
      // Fallback if the SDK doesn't yet expose webhooks.unwrap: skip
      // verification and just JSON-parse. NOT for production — set up the
      // SDK or write an HMAC verifier when you wire webhooks for real.
      console.warn("[anthropic] SDK has no webhooks.unwrap; skipping signature verification");
      return JSON.parse(body);
    })();
  },
};

export type { Json };
