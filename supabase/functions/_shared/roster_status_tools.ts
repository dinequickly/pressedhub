// Universal roster-status tool. Agents can explicitly set the message that
// appears on the /roster sticky note instead of forcing the UI to infer it
// from the latest chat text. The status is persisted as a session_events row
// so it naturally scopes to a single session and can be read alongside the
// rest of the transcript.

import { AnthropicSessionEvents } from "./anthropic.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export const ROSTER_STATUS_TOOL_NAMES = ["set_roster_status"] as const;
export type RosterStatusToolName = typeof ROSTER_STATUS_TOOL_NAMES[number];
export type RosterTone = "running" | "warn" | "ok" | "idle";

export type PersistedRosterStatus = {
  tone: RosterTone;
  label: string | null;
  summary: string;
  cta: "open_chat" | "open_files" | "none" | null;
  file_name: string | null;
  updated_at: string;
  tool_use_id?: string;
};

export const ROSTER_STATUS_TOOL_DEFS: Array<Record<string, unknown>> = [
  {
    type: "custom",
    name: "set_roster_status",
    description:
      "Set the structured status shown for this run on the Roster page. Use this whenever you want the user's payroll-style roster card to say something specific, like WANTS CHAT, REVIEW DOC, DONE, or ON IT. Provide a short stamp label plus a short human-facing summary sentence. Call it again whenever your status changes.",
    input_schema: {
      type: "object",
      properties: {
        tone: {
          type: "string",
          enum: ["running", "warn", "ok", "idle"],
          description:
            "Visual tone for the roster note: running=actively working, warn=needs user attention, ok=completed/review-ready, idle=standing by.",
        },
        label: {
          type: "string",
          description:
            "Short stamp text shown on the sticky note, like 'WANTS CHAT', 'REVIEW DOC', 'DONE', or 'ON IT'. Keep it under ~18 characters.",
        },
        summary: {
          type: "string",
          description:
            "One short sentence shown as the main note text. Example: 'Need your call on the final headline before I ship it.'",
        },
        cta: {
          type: "string",
          enum: ["open_chat", "open_files", "none"],
          description:
            "Optional hint about what the user should do next. open_chat for discussion, open_files for artifact review, none when it's purely informative.",
        },
        file_name: {
          type: "string",
          description:
            "Optional related file name when you're asking the user to review an artifact.",
        },
      },
      required: ["tone", "summary"],
    },
  },
];

export type RosterStatusToolUseRef = {
  tool_use_id: string;
  name: RosterStatusToolName;
  input: Record<string, unknown>;
};

export function extractRosterStatusToolUses(payload: unknown): RosterStatusToolUseRef[] {
  const out: RosterStatusToolUseRef[] = [];
  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const t = obj.type;
    const name = obj.name;
    if (
      typeof t === "string" &&
      (t === "tool_use" || t === "agent.tool_use" || t === "agent.custom_tool_use") &&
      typeof name === "string" &&
      (ROSTER_STATUS_TOOL_NAMES as readonly string[]).includes(name)
    ) {
      const id = (obj.tool_use_id ?? obj.id) as string | undefined;
      if (id) {
        out.push({
          tool_use_id: id,
          name: name as RosterStatusToolName,
          input: (obj.input as Record<string, unknown>) ?? {},
        });
      }
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(payload);
  return out;
}

export async function dispatchRosterStatusTool(
  ref: RosterStatusToolUseRef,
  ctx: { userDb: SupabaseClient; localSessionId: string },
): Promise<string> {
  try {
    if (ref.name === "set_roster_status") {
      return await runSetRosterStatus(ctx, ref.tool_use_id, ref.input);
    }
    return `[ERROR] Unknown roster status tool: ${ref.name}`;
  } catch (err) {
    console.warn(`[roster_status_tools] ${ref.name} failed:`, err);
    return `[ERROR] ${(err as Error).message}`;
  }
}

async function runSetRosterStatus(
  ctx: { userDb: SupabaseClient; localSessionId: string },
  toolUseId: string,
  input: Record<string, unknown>,
): Promise<string> {
  const tone = normalizeTone(input.tone);
  const summary = clean(input.summary, 220);
  if (!summary) throw new Error("summary is required");
  const label = clean(input.label, 18);
  const cta = normalizeCta(input.cta);
  const fileName = clean(input.file_name, 255);
  const status: PersistedRosterStatus = {
    tone,
    label,
    summary,
    cta,
    file_name: fileName,
    updated_at: new Date().toISOString(),
    tool_use_id: toolUseId,
  };
  const { error } = await ctx.userDb.from("session_events").insert({
    session_id: ctx.localSessionId,
    anthropic_event_id: null,
    event_type: "pressed.roster_status_set",
    payload: status,
    processed_at: status.updated_at,
  });
  if (error) throw new Error(error.message);
  return JSON.stringify({ ok: true, roster_status: status });
}

export async function postRosterStatusToolResult(
  anthropicSessionId: string,
  toolUseId: string,
  text: string,
): Promise<void> {
  await AnthropicSessionEvents.send(anthropicSessionId, [
    {
      type: "user.custom_tool_result",
      custom_tool_use_id: toolUseId,
      content: [{ type: "text", text }],
    },
  ]);
}

function normalizeTone(v: unknown): RosterTone {
  if (v === "running" || v === "warn" || v === "ok" || v === "idle") return v;
  throw new Error("tone must be one of running, warn, ok, idle");
}

function normalizeCta(v: unknown): "open_chat" | "open_files" | "none" | null {
  if (v === undefined || v === null || v === "") return null;
  if (v === "open_chat" || v === "open_files" || v === "none") return v;
  throw new Error("cta must be open_chat, open_files, or none");
}

function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
