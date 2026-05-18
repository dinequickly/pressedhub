// Single typed fetcher. Every page goes through `api.get/post/patch/del`.
// On 401 we let the caller decide; on the uniform error envelope we throw a
// nicely-shaped Error so SWR can surface it.

import { FN_URL, supabase } from "./supabase";

// Cached JWT, kept in sync by AuthProvider via setApiJwt and a fallback
// onAuthStateChange listener below. We avoid calling supabase.auth.getSession()
// on every request because that promise can hang for >5s when the auth client
// is mid-refresh, which would block /profiles/me and trap the user on the
// loading screen indefinitely.
let cachedJwt: string | null = null;

export function setApiJwt(jwt: string | null): void {
  cachedJwt = jwt;
}

// Best-effort sync from supabase auth events. AuthProvider also calls
// setApiJwt directly whenever its state updates — this listener is just a
// safety net if anything ever calls into api.* before AuthProvider mounts.
supabase.auth.onAuthStateChange((_event, session) => {
  cachedJwt = session?.access_token ?? null;
});

async function resolveJwt(): Promise<string | null> {
  if (cachedJwt) return cachedJwt;
  try {
    const result = await Promise.race([
      supabase.auth.getSession(),
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error("getSession timeout")), 1200);
      }),
    ]);
    const token = result.data.session?.access_token ?? null;
    if (token) cachedJwt = token;
    return token;
  } catch {
    return null;
  }
}

async function authedHeaders(): Promise<HeadersInit> {
  const jwt = await resolveJwt();
  return {
    "Content-Type": "application/json",
    apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  };
}

async function unwrap(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = json?.error?.message ?? res.statusText ?? "Request failed";
    const err = new Error(msg) as Error & { status: number; details?: unknown };
    err.status = res.status;
    err.details = json?.error?.details;
    throw err;
  }
  return json;
}

export const api = {
  async get<T = unknown>(path: string): Promise<T> {
    const res = await fetch(`${FN_URL}${path}`, { headers: await authedHeaders() });
    return (await unwrap(res)) as T;
  },
  // Fetch a binary endpoint with auth and return the raw Response. Caller
  // turns it into a blob URL or reads as text. Used by the file proxy since
  // <img>/<iframe> can't carry a bearer token.
  async getRaw(path: string): Promise<Response> {
    const headers = await authedHeaders();
    delete (headers as Record<string, string>)["Content-Type"];
    const res = await fetch(`${FN_URL}${path}`, { headers });
    if (!res.ok) {
      // Try to read the JSON error envelope if the body looks like one.
      // Falls back to a status-only message so we never block on a stuck
      // response.
      let msg = `Request failed: ${res.status}`;
      try {
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        const inner = json?.error?.message;
        if (typeof inner === "string" && inner) msg = inner;
      } catch { /* ignore */ }
      const err = new Error(msg) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return res;
  },
  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${FN_URL}${path}`, {
      method: "POST",
      headers: await authedHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await unwrap(res)) as T;
  },
  async patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${FN_URL}${path}`, {
      method: "PATCH",
      headers: await authedHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await unwrap(res)) as T;
  },
  // Stream a raw body (text or bytes) at a content-type we choose. Used
  // by the in-app file editor to PUT updated bytes back to storage.
  async putRaw<T = unknown>(path: string, body: BodyInit, contentType: string): Promise<T> {
    const headers = await authedHeaders();
    (headers as Record<string, string>)["Content-Type"] = contentType;
    const res = await fetch(`${FN_URL}${path}`, { method: "PUT", headers, body });
    return (await unwrap(res)) as T;
  },
  async del<T = unknown>(path: string): Promise<T> {
    const res = await fetch(`${FN_URL}${path}`, {
      method: "DELETE",
      headers: await authedHeaders(),
    });
    return (await unwrap(res)) as T;
  },
};

export type Profile = {
  id: string; name: string; email: string;
  role: "admin" | "member"; initial: string; tint: string;
};

export type WorkspaceSettings = {
  id: string;
  hidden_nav_pages: string[];
  updated_at: string;
};

export type Connector = {
  id: string; name: string; group: "apps" | "system" | "ai";
  icon_class: string; tint: string;
  operations: Record<string, { id: string; label: string; configFields?: string[]; filterableFields?: string[] }>;
};

export type Agent = {
  id: string; anthropic_id: string | null; name: string; role: string;
  emoji: string; accent: string; model: string; system_prompt: string;
  instructions: string; tools: unknown[]; skills: unknown[]; mcp_servers: unknown[];
  outcome: { description: string; rubric_md: string; max_iterations?: number } | null;
  brain: unknown[];
  default_resources: { kb_file_ids: string[]; memory_store_ids: string[]; pinned_kb_names: string[] };
  created_at: string; updated_at: string; archived_at: string | null;
};

export type Environment = {
  id: string; anthropic_id: string | null; name: string;
  config: Record<string, unknown>; created_at: string; updated_at: string;
};

export type Session = {
  id: string; anthropic_id: string | null;
  workflow_id: string | null; agent_id: string; environment_id: string;
  title: string | null; status: "idle" | "running" | "rescheduling" | "terminated";
  outcome_evaluations: unknown[]; iteration_count: number;
  usage: Record<string, number>;
  trigger_summary: string | null; trigger_payload: unknown;
  started_at: string; finished_at: string | null;
};

export type ChartSpec = {
  type: "bar" | "line" | "area" | "pie" | "donut";
  title?: string;
  description?: string;
  x?: string;
  series: Array<{ key: string; label?: string; color?: string }>;
  data: Array<Record<string, unknown>>;
  kb_file_id?: string;
};

export type SessionEvent = {
  id: string; session_id: string; anthropic_event_id: string | null;
  event_type: string; payload: Record<string, unknown>;
  processed_at: string | null; created_at: string;
};

export type RunOutput = {
  file_id: string;
  name: string | null;
  mime: string | null;
  size: number | null;
};

export type MemoryStore = {
  id: string; name: string; description: string;
  scope: "workflow" | "user" | "shared";
  workflow_id: string | null; owner_id: string; total_versions: number;
  anthropic_id: string | null;
  created_at: string; updated_at: string;
};

export type MemoryDocument = {
  id: string; store_id: string; path: string; content: string;
  size_bytes: number; version_count: number; created_at: string; updated_at: string;
};

export type MemoryTable = {
  id: string; store_id: string; name: string;
  schema: { columns: Array<{ name: string; type: string }> };
};

export type Dream = {
  id: string; store_id: string;
  status: "pending" | "running" | "completed" | "failed" | "canceled" | "approved" | "rejected";
  old_snapshot: Array<{ path: string; content: string }>;
  new_snapshot: Array<{ path: string; content: string }>;
  diff: {
    added: Array<{ path: string; content: string }>;
    removed: Array<{ path: string; content: string }>;
    changed: Array<{ path: string; before: string; after: string }>;
  } | null;
  instructions: string | null; session_count: number;
  created_at: string; ended_at: string | null;
};

export type KbFolder = {
  id: string; parent_id: string | null; name: string; path: string;
  created_at: string; updated_at: string;
};

export type KbFile = {
  id: string; folder_id: string | null; name: string; storage_path: string;
  mime: string; size_bytes: number; kind: string;
  status: "uploaded" | "extracted" | "chunked" | "embedded" | "failed";
  snippet: string; tags: string[];
  anthropic_file_id: string | null;
  created_at: string; updated_at: string;
};

export type VaultConnection = {
  id: string; user_id: string; connector_id: string;
  account_label: string; status: "connected" | "expired" | "never";
  scopes: string[]; mcp_server_url: string | null;
  anthropic_vault_id: string | null; anthropic_credential_id: string | null;
  metadata: Record<string, unknown>;
  connected_at: string | null; expires_at: string | null; last_used_at: string | null;
};

export type Skill = {
  id: string; type: "anthropic" | "custom"; name: string; description: string;
  version: string; content_md: string; pinned: boolean;
  anthropic_skill_id: string | null;
  created_at: string; updated_at: string;
};

export type AgentSchedule = {
  id: string;
  agent_id: string;
  environment_id: string | null;
  name: string;
  cron: string;
  timezone: string;
  trigger_message: string | null;
  trigger_payload: Record<string, unknown>;
  status: "active" | "paused";
  skip_if_running: boolean;
  last_run_at: string | null;
  last_session_id: string | null;
  next_run_at: string;
  created_at: string;
  updated_at: string;
};

export type ScheduleRun = {
  id: string;
  schedule_id: string;
  session_id: string | null;
  scheduled_for: string;
  started_at: string;
  finished_at: string | null;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  error: string | null;
};

// /schedules/roster shape: schedule + flattened agent + last-session view.
export type RosterEntry = {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  status: "active" | "paused";
  next_run_at: string;
  last_run_at: string | null;
  last_session_id: string | null;
  trigger_message: string | null;
  agent: { id: string; name: string; role: string; emoji: string; accent: string };
  last_session:
    | {
      id: string;
      status: string;
      title: string | null;
      started_at: string;
      finished_at: string | null;
      trigger_summary?: string | null;
      // Most recent agent.message text from this session, if any. Backend
      // pulls this from session_events when building /schedules/roster.
      latest_message?: string | null;
      // Most recent summarized thinking text from this session. Used to
      // announce what the agent is reasoning about while it's still running.
      latest_thinking?: string | null;
      // Explicit roster-card status set by the agent through the built-in
      // set_roster_status tool. Preferred over heuristics when present.
      roster_status?: {
        tone: "running" | "warn" | "ok" | "idle";
        label?: string | null;
        summary: string;
        cta?: "open_chat" | "open_files" | "none" | null;
        file_name?: string | null;
        updated_at?: string | null;
        chart?: ChartSpec | null;
      } | null;
    }
    | null;
};

export type McpServer = {
  id: string; name: string; url: string; description: string;
  metadata: Record<string, unknown>; created_at: string; updated_at: string;
};

// -- Image Creator app ----------------------------------------------------
//
// The board state is intentionally schemaless on the DB side; this is the
// frontend's source of truth. Adding new item types or fields means updating
// here + the canvas renderer, no migration.

export type VibeBoardItemBase = {
  id: string;
  x: number; y: number;
  w?: number; h?: number;
};

/** A single freeform pen stroke drawn on top of an image in the
 *  full-screen annotator. Coordinates are in image-space — i.e. relative
 *  to the natural pixel dimensions of the source image — so the same
 *  strokes render correctly at any display size. */
export type Stroke = {
  color: string;
  width: number;
  points: Array<{ x: number; y: number }>;
};

export type VibeBoardImageItem = VibeBoardItemBase & {
  type: "image";
  /** Anthropic file_id of the image, if generated by an agent gen tool. */
  anthropic_file_id?: string;
  /** Media library asset id for user-uploaded images. The canvas resolves
   *  this through /media/:id/content; survives reloads. */
  media_asset_id?: string;
  /** Direct URL — kept for backward compat with older items; new uploads
   *  store media_asset_id instead. */
  url?: string;
  /** Display name for the card header — defaults to filename for uploads. */
  name?: string;
  /** The prompt that produced this image (for agent-generated). */
  prompt?: string;
  /** User-editable description shown below the image. */
  caption?: string;
  /** Item id of the parent prompt or image this was spawned from. */
  parent_id?: string;
  /** Pen-tool annotations drawn on the full-screen viewer. */
  annotations?: Stroke[];
};
/** Image gen models the prompt-card UI offers. Two Google tiers (fast +
 *  quality) plus OpenAI (used by the agent's chat path; not in the prompt
 *  selector right now). Legacy `gemini` still accepted on persisted items. */
export type PromptModel = "openai" | "gemini" | "gemini-fast" | "gemini-quality";

/** Reference image attached to a prompt card — sent alongside the text on
 *  Send and shown as a chip strip above the textarea. */
export type PromptAttachment = {
  /** Stable id used for keyed rendering; not the media_asset_id. */
  id: string;
  media_asset_id: string;
  name: string;
  mime: string;
};

/** A single generation produced by the inline /vibe-boards/:id/generate
 *  endpoint. Hangs off the prompt card it was rendered from. */
export type Generation = {
  id: string;
  media_asset_id: string;
  model: PromptModel;
  generated_at: string;
  /** Pen-tool annotations drawn on the full-screen viewer. */
  annotations?: Stroke[];
};

export type VibeBoardPromptItem = VibeBoardItemBase & {
  type: "prompt";
  text: string;
  /** Per-prompt model preference. Old prompt cards may not have this. */
  model?: PromptModel;
  /** Reference images attached to this prompt; shown as a strip above the
   *  textarea and forwarded to the gen vendor on Send. */
  attachments?: PromptAttachment[];
  /** Generations produced from this prompt, in chronological order. */
  generations?: Generation[];
  /** Index into `generations` currently shown in the viewer. */
  current_generation_idx?: number;
};
export type VibeBoardReferenceItem = VibeBoardItemBase & {
  type: "reference";
  /** Media library asset id when this reference came from the user's
   *  canonical library or prior uploads. */
  media_asset_id?: string;
  /** Anthropic file_id once uploaded. */
  anthropic_file_id?: string;
  /** Direct URL of the reference image. */
  url?: string;
  /** Display name — set by the agent's attach_media_as_reference tool. */
  name?: string;
  /** Optional caption / description of the reference. */
  caption?: string;
  /** Pen-tool annotations drawn on the full-screen viewer. */
  annotations?: Stroke[];
};
export type VibeBoardNoteItem = VibeBoardItemBase & {
  type: "note";
  text: string;
};
export type VibeBoardItem =
  | VibeBoardImageItem
  | VibeBoardPromptItem
  | VibeBoardReferenceItem
  | VibeBoardNoteItem;

export type VibeBoardState = {
  items: VibeBoardItem[];
};

export type VibeBoard = {
  id: string;
  name: string;
  state: VibeBoardState;
  session_id: string | null;
  created_at: string;
  updated_at: string;
};

export type MediaAsset = {
  id: string;
  name: string;
  storage_path: string;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  tags: string[];
  anthropic_file_id: string | null;
  source_kind: "pressed_library" | "board_upload" | "board_generated";
  collection_key: string | null;
  product_key: string | null;
  shot_key: string | null;
  board_id: string | null;
  status: "pending" | "ready" | "failed";
  created_at: string;
  updated_at: string;
};

// -- Timeline -----------------------------------------------------------

export type TimelineChannel =
  | "email" | "paid" | "organic" | "in_store" | "retail" | "other";

export type TimelineCampaign = {
  id: string;
  name: string;
  channel: TimelineChannel;
  started_at: string;
  ended_at: string;
  description: string;
  metadata: Record<string, unknown>;
  source: string;
};

export type TimelineMetricPoint = {
  kind: string;
  occurred_at: string;
  value: number;
  dimensions: Record<string, unknown>;
  source: string;
};

export type TimelineAnnotationKind =
  | "product" | "holiday" | "weather" | "competition" | "team" | "other";

export type TimelineAnnotation = {
  id: string;
  at: string;
  kind: TimelineAnnotationKind;
  label: string;
  description: string;
  source: string;
};
