// Shared event-stream rendering for any view that walks a session's events:
// the chat surface (/chat) and the engineering runs view (/runs) both use it.
// Each event type the Managed Agents harness can emit gets its own icon,
// tint, and short summary line.

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { IconType } from "react-icons";
import {
  LuMessageSquare, LuActivity, LuTerminal, LuBot,
  LuBan, LuFileText, LuBrain,
  LuFilePlus, LuPencil, LuFolderSearch, LuSearch, LuGlobe,
  LuBookOpen, LuLibrary, LuPaperclip, LuPlug, LuPuzzle,
  LuTriangleAlert, LuTarget, LuArchive,
  LuZap, LuShare2, LuCitrus, LuCopy, LuRotateCcw, LuCheck, LuCpu,
  LuChevronDown, LuChevronRight, LuFile, LuPresentation,
} from "react-icons/lu";
import type { ChartSpec, SessionEvent } from "../lib/api";
import { relativeTime, renderMarkdown } from "../lib/format";
import { PressedSpinner } from "./PressedSpinner";

const LazyChartView = lazy(() =>
  import("./ChartView").then((m) => ({ default: m.ChartView }))
);

type Seg = { kind: "md"; text: string } | { kind: "chart"; json: string };

function splitChartBlocks(text: string): Seg[] {
  const out: Seg[] = [];
  const re = /```chart\s*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: "md", text: text.slice(last, m.index) });
    out.push({ kind: "chart", json: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "md", text: text.slice(last) });
  return out.filter((s) => s.kind === "chart" || (s as { kind: "md"; text: string }).text.trim() !== "");
}

function tryParseChartSpec(json: string): ChartSpec | null {
  try {
    const s = JSON.parse(json) as Record<string, unknown>;
    if (!["bar", "line", "area", "pie", "donut"].includes(s.type as string)) return null;
    if (!Array.isArray(s.data) || !Array.isArray(s.series)) return null;
    return s as unknown as ChartSpec;
  } catch { return null; }
}

type Tint =
  | "amber" | "violet" | "indigo" | "sky" | "emerald" | "rose"
  | "neutral" | "fuchsia" | "teal" | "blue";

const TINT: Record<Tint, { bg: string; icon: string; label: string }> = {
  amber:    { bg: "bg-neutral-900", icon: "text-white", label: "text-neutral-900" },
  violet:   { bg: "bg-neutral-900", icon: "text-white", label: "text-neutral-900" },
  indigo:   { bg: "bg-neutral-900", icon: "text-white", label: "text-neutral-900" },
  sky:      { bg: "bg-neutral-900", icon: "text-white", label: "text-neutral-900" },
  emerald:  { bg: "bg-neutral-900", icon: "text-white", label: "text-neutral-900" },
  rose:     { bg: "bg-neutral-900", icon: "text-white", label: "text-neutral-900" },
  fuchsia:  { bg: "bg-neutral-900", icon: "text-white", label: "text-neutral-900" },
  teal:     { bg: "bg-neutral-900", icon: "text-white", label: "text-neutral-900" },
  blue:     { bg: "bg-neutral-900", icon: "text-white", label: "text-neutral-900" },
  neutral:  { bg: "bg-neutral-900", icon: "text-white", label: "text-neutral-900" },
};

type ToolMeta = {
  icon: IconType;
  tint: Tint;
  verb: string;
  arg: (input: Record<string, unknown>) => string | null;
};

// Names match the `agent_toolset_20260401` built-ins and our custom kb_* tools.
const TOOL_META: Record<string, ToolMeta> = {
  bash:       { icon: LuTerminal,     tint: "neutral", verb: "ran",          arg: (i) => str(i.command) },
  read:       { icon: LuFileText,     tint: "sky",     verb: "read",         arg: (i) => str(i.path ?? i.file_path) },
  write:      { icon: LuFilePlus,     tint: "sky",     verb: "wrote",        arg: (i) => str(i.path ?? i.file_path) },
  edit:       { icon: LuPencil,       tint: "amber",   verb: "edited",       arg: (i) => str(i.path ?? i.file_path) },
  glob:       { icon: LuFolderSearch, tint: "sky",     verb: "globbed",      arg: (i) => str(i.pattern) },
  grep:       { icon: LuSearch,       tint: "sky",     verb: "grepped",      arg: (i) => str(i.pattern ?? i.query) },
  web_fetch:  { icon: LuGlobe,        tint: "emerald", verb: "fetched",      arg: (i) => str(i.url) },
  web_search: { icon: LuSearch,       tint: "emerald", verb: "searched web", arg: (i) => str(i.query) },
  kb_list:    { icon: LuBookOpen,     tint: "violet",  verb: "browsed KB",   arg: (i) => str(i.folder_id) ?? "all files" },
  kb_search:  { icon: LuLibrary,      tint: "violet",  verb: "searched KB",  arg: (i) => str(i.query) },
  kb_attach:  { icon: LuPaperclip,    tint: "violet",  verb: "attached",     arg: (i) => str(i.kb_file_id) },
  set_roster_status: {
    icon: LuMessageSquare,
    tint: "amber",
    verb: "updated roster",
    arg: (i) => str(i.label) ?? str(i.summary) ?? str(i.tone),
  },
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function extractContent(event: SessionEvent): { thinking: string; text: string; signature: string } {
  const t = event.event_type;
  const p = (event.payload ?? {}) as Record<string, unknown>;
  let thinking = "";
  let text = "";
  let signature = "";

  // Content-block shape: agent.message uses this for text; some thinking
  // variants nest inside a content array too.
  const blocks = Array.isArray(p.content) ? (p.content as Array<Record<string, unknown>>) : [];
  for (const b of blocks) {
    const bt = b.type as string | undefined;
    if (bt === "thinking" && typeof b.thinking === "string") thinking += b.thinking;
    if (bt === "thinking" && typeof b.signature === "string") signature ||= b.signature;
    else if (bt === "text" && typeof b.text === "string") text += b.text;
  }

  // Discrete agent.thinking events: per the docs the payload carries the
  // thinking text plus an opaque signature. The exact field varies by API
  // version — walk the payload looking for a `thinking` key with a string
  // value, anywhere, then fall back to `text`. Belt-and-suspenders so we
  // don't render raw JSON when Anthropic shifts the shape.
  if (!thinking && t.includes("thinking")) {
    thinking = findStringDeep(p, ["thinking", "text"]) ?? "";
  }
  if (!signature) {
    signature = findStringDeep(p, ["signature"]) ?? "";
  }
  return { thinking, text, signature };
}

// Depth-limited DFS for a string at any of `keys`. Returns the first match
// or null. We skip very short strings so we don't accidentally surface
// metadata.
function findStringDeep(
  obj: unknown,
  keys: string[],
  depth = 0,
): string | null {
  if (depth > 4 || obj === null || typeof obj !== "object") return null;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === "string" && v.length > 2) return v;
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (v && typeof v === "object") {
      const hit = findStringDeep(v, keys, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function extractResult(payload: Record<string, unknown>): { text: string; isError: boolean } {
  const isError = payload.is_error === true;
  const c = payload.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (b && typeof b === "object" && typeof (b as Record<string, unknown>).text === "string") {
        text += (b as Record<string, unknown>).text as string;
      }
    }
  }
  return { text, isError };
}

function Bubble({ icon: Icon, tint }: { icon: IconType; tint: Tint }) {
  const cls = TINT[tint];
  return (
    <div className={`size-7 rounded-lg ${cls.bg} ${cls.icon} grid place-items-center shrink-0 mt-0.5`}>
      <Icon className="size-3.5" />
    </div>
  );
}

function Caption({ tint, label, time }: { tint: Tint; label: string; time: string | null }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-mono">
      <span className={`font-medium ${TINT[tint].label}`}>{label}</span>
      <span className="text-ink-400">·</span>
      <span className="text-ink-500">{relativeTime(time)}</span>
    </div>
  );
}

// Compact tool-call row that doubles as a disclosure: shows `verb arg` and
// expands to reveal the tool's result. Mimics ai-elements' Tool primitive —
// no big bubble, just a colored icon + mono summary that you can drill into.
function ToolStep({
  Icon, tint, label, verb, arg,
}: {
  Icon: IconType;
  tint: Tint;
  label: string;
  verb: string;
  arg: string | null;
}) {
  const cls = TINT[tint];
  return (
    <div className="text-sm">
      <div className="w-full flex items-center gap-2 text-left rounded-2xl border border-neutral-200/80 bg-white/90 px-3 py-2">
        <Icon className={`size-3.5 ${cls.icon} shrink-0`} />
        <span className={`text-[11px] font-medium font-mono uppercase tracking-wider ${cls.label} shrink-0`}>{label}</span>
        <span className="text-ink-500 shrink-0">{verb}</span>
        {arg && <span className="text-ink-700 truncate font-mono text-[13px]">{arg}</span>}
      </div>
    </div>
  );
}

function MessageActions({
  text,
  time,
  onRetry,
}: {
  text: string;
  time?: string | null;
  onRetry?: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // No-op — Safari without permission may throw; nothing useful to do.
    }
  }
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] font-mono text-ink-400">
      <button
        onClick={copy}
        title={copied ? "Copied" : "Copy"}
        className="p-1 rounded text-ink-400 hover:text-ink-700 hover:bg-neutral-100"
      >
        {copied ? <LuCheck className="size-3.5" /> : <LuCopy className="size-3.5" />}
      </button>
      {onRetry && (
        <button
          onClick={() => onRetry(text)}
          title="Retry"
          className="p-1 rounded text-ink-400 hover:text-ink-700 hover:bg-neutral-100"
        >
          <LuRotateCcw className="size-3.5" />
        </button>
      )}
      {time && (
        <>
          <span className="text-ink-300">·</span>
          <span>{relativeTime(time)}</span>
        </>
      )}
    </div>
  );
}

// Event types that are pure plumbing — already reflected in the status pill
// in the chat header, or part of multiagent infra we don't surface yet. We
// hide these in the chat view so the conversation isn't drowned in noise.
const NOISE_PREFIXES = [
  "span.model_request",
  "session.status_",          // running / idle / rescheduled / terminated — pill covers it
  "session.thread_",          // multiagent sub-threads
  "agent.thread_status_",
  "agent.thread_message_",
  "pressed.kb_dispatch_started",
  "pressed.image_dispatch_started",
  "pressed.roster_status_dispatch_started",
  "pressed.kb_attached",
  "pressed.roster_status_set",
];

export function isNoiseEvent(event: SessionEvent): boolean {
  const t = event.event_type;
  return NOISE_PREFIXES.some((p) => t.startsWith(p));
}

// Walks events once, drops noise, and pairs each tool_use with its matching
// tool_result so the chat surface can render them as a single collapsible
// row. Result events that found a parent are dropped from the visible list.
export function groupChatEvents(
  events: SessionEvent[],
): Array<{ event: SessionEvent; result?: SessionEvent }> {
  const useIdToResult = new Map<string, SessionEvent>();
  for (const e of events) {
    if (e.event_type !== "agent.tool_result"
        && e.event_type !== "agent.mcp_tool_result"
        && e.event_type !== "user.custom_tool_result") continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const id = (p.tool_use_id ?? p.custom_tool_use_id) as string | undefined;
    if (id) useIdToResult.set(id, e);
  }
  const consumed = new Set<string>();
  const out: Array<{ event: SessionEvent; result?: SessionEvent }> = [];
  for (const e of events) {
    if (consumed.has(e.id)) continue;
    if (isNoiseEvent(e)) continue;
    const t = e.event_type;
    if (t === "agent.tool_use" || t === "agent.custom_tool_use" || t === "agent.mcp_tool_use") {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const id = (p.id ?? p.tool_use_id) as string | undefined;
      const result = id ? useIdToResult.get(id) : undefined;
      if (result) consumed.add(result.id);
      out.push({ event: e, result });
      continue;
    }
    out.push({ event: e });
  }
  return out;
}

export function EventRow({
  event,
  resultEvent,
  onRetry,
}: {
  event: SessionEvent;
  resultEvent?: SessionEvent;
  onRetry?: (text: string) => void;
}) {
  const t = event.event_type;
  const p = (event.payload ?? {}) as Record<string, unknown>;

  if (isNoiseEvent(event)) return null;

  const { thinking, text: msgText, signature } = extractContent(event);
  if ((thinking || signature) && (t.includes("thinking") || t === "agent.message")) {
    if (t === "agent.message" && msgText) {
      return (
        <>
          <ThinkingTrace text={thinking} signature={signature || null} />
          <div className="mt-3">
            <AssistantBubble text={msgText} time={event.processed_at} onRetry={onRetry} />
          </div>
        </>
      );
    }
    return <ThinkingTrace text={thinking} signature={signature || null} />;
  }

  if (t === "agent.message" && msgText) {
    return <AssistantBubble text={msgText} time={event.processed_at} onRetry={onRetry} />;
  }

  if (t === "user.message") {
    const text = msgText || extractResult(p).text;
    if (!text) return null;
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] bg-white rounded-2xl rounded-tr-md shadow-soft px-4 py-2.5 text-sm text-ink-800 whitespace-pre-wrap">
          {text}
        </div>
      </div>
    );
  }

  if (t === "agent.tool_use" || t === "agent.custom_tool_use" || t === "agent.mcp_tool_use") {
    const name = (p.name as string) ?? "tool";
    const input = (p.input as Record<string, unknown>) ?? {};
    const isMcp = t === "agent.mcp_tool_use";
    const isCustom = t === "agent.custom_tool_use";
    const meta = TOOL_META[name];
    const Icon = meta?.icon ?? (isMcp ? LuPlug : isCustom ? LuPuzzle : LuTerminal);
    const tint: Tint = meta?.tint ?? (isMcp ? "teal" : isCustom ? "fuchsia" : "neutral");
    const verb = meta?.verb ?? "called";
    const arg = meta?.arg(input) ?? (Object.values(input).find((v) => typeof v === "string") as string | undefined) ?? null;
    const server = isMcp && typeof p.server_name === "string" ? p.server_name : null;
    const label = server ? `${server} · ${name}` : name;

    return <ToolStep
      Icon={Icon}
      tint={tint}
      label={label}
      verb={verb}
      arg={arg}
    />;
  }

  // Standalone result rows only render when they couldn't be paired with a
  // tool_use upstream (rare — usually means the use was filtered or absent).
  if (t === "agent.tool_result" || t === "agent.mcp_tool_result" || t === "user.custom_tool_result") {
    return null;
  }

  if (t === "agent.thread_context_compacted") {
    return (
      <div className="flex items-start gap-2.5">
        <Bubble icon={LuArchive} tint="neutral" />
        <div className="min-w-0 flex-1">
          <Caption tint="neutral" label="history compacted" time={event.processed_at} />
          <div className="mt-0.5 text-xs text-ink-500">Older turns were summarized to fit the context window.</div>
        </div>
      </div>
    );
  }

  if (t.startsWith("agent.thread_message_") || t.startsWith("session.thread_")) {
    return (
      <div className="flex items-start gap-2.5">
        <Bubble icon={LuShare2} tint="blue" />
        <div className="min-w-0 flex-1">
          <Caption tint="blue" label={t.replace(/^agent\.|^session\./, "")} time={event.processed_at} />
        </div>
      </div>
    );
  }

  if (t.startsWith("span.outcome")) {
    return (
      <div className="flex items-start gap-2.5">
        <Bubble icon={LuTarget} tint="emerald" />
        <div className="min-w-0 flex-1">
          <Caption tint="emerald" label={t.replace(/^span\./, "")} time={event.processed_at} />
        </div>
      </div>
    );
  }

  if (t.startsWith("span.model_request")) {
    return (
      <div className="flex items-start gap-2.5">
        <Bubble icon={LuCpu} tint="neutral" />
        <div className="min-w-0 flex-1">
          <Caption tint="neutral" label={t.replace(/^span\./, "")} time={event.processed_at} />
        </div>
      </div>
    );
  }

  if (t === "session.error") {
    const msg = (p.error as Record<string, unknown> | undefined)?.message;
    return (
      <div className="flex items-start gap-2.5">
        <Bubble icon={LuTriangleAlert} tint="rose" />
        <div className="min-w-0 flex-1">
          <Caption tint="rose" label="session error" time={event.processed_at} />
          {typeof msg === "string" && <div className="mt-0.5 text-xs text-rose-700">{msg}</div>}
        </div>
      </div>
    );
  }

  if (t.startsWith("session.status_")) {
    const status = t.replace("session.status_", "");
    const tint: Tint = status === "running" ? "emerald"
      : status === "terminated" ? "rose"
      : status === "rescheduled" ? "amber"
      : "neutral";
    const Icon = status === "running" ? LuZap : LuActivity;
    return (
      <div className="flex items-start gap-2.5">
        <Bubble icon={Icon} tint={tint} />
        <div className="min-w-0 flex-1">
          <Caption tint={tint} label={`status: ${status}`} time={event.processed_at} />
        </div>
      </div>
    );
  }

  if (t === "user.interrupt") {
    return (
      <div className="flex items-start gap-2.5">
        <Bubble icon={LuBan} tint="rose" />
        <div className="min-w-0 flex-1">
          <Caption tint="rose" label="interrupted" time={event.processed_at} />
        </div>
      </div>
    );
  }

  return null;
}

// ─── Live activity ──────────────────────────────────────────────────────────
// Renders below the last event when the session is `running`. Walks the event
// list from the end to surface the agent's CURRENT action — the file it's
// editing, the tool it's running, the thinking it's mid-stream. Falls back to
// rotating juice phrases when there's nothing specific to show.

const JUICE_PHRASES = [
  "Getting all the juice out of the squeeze",
  "Cold-pressing some answers",
  "Squeezing the lemons",
  "Letting the pulp settle",
  "Catching the drip",
  "Adding a splash of citrus",
  "Spinning up the centrifuge",
  "Straining out the seeds",
  "Reaching peak pulp",
  "Topping off with ginger",
  "Pouring the next round",
  "Adding zest",
  "Mixing in the greens",
  "Chilling on ice",
  "Garnishing with mint",
];

function useJuicePhrase(active: boolean): string {
  const [idx, setIdx] = useState<number>(() => Math.floor(Math.random() * JUICE_PHRASES.length));
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setIdx((i) => (i + 1) % JUICE_PHRASES.length), 3500);
    return () => clearInterval(id);
  }, [active]);
  return JUICE_PHRASES[idx];
}

function firstSentence(s: string, max = 120): string {
  const trimmed = s.trim();
  const cut = trimmed.search(/[.!?]\s/);
  const slice = cut > 0 && cut < max ? trimmed.slice(0, cut + 1) : trimmed.slice(0, max);
  return slice;
}

type ActivityInfo = {
  icon: IconType;
  tint: Tint;
  title: string;
  detail: string | null;
};

// Scan events newest-first and turn the most recent meaningful one into a
// status card. Tool results don't count as "current action" — we want the
// preceding tool_use or the thinking that came before.
function deriveActivity(events: SessionEvent[]): ActivityInfo | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const t = e.event_type;
    const p = (e.payload ?? {}) as Record<string, unknown>;

    if (t === "agent.thinking" || (t.includes("thinking") && !t.includes("tool"))) {
      return { icon: LuBrain, tint: "indigo", title: "Reviewing the request", detail: null };
    }

    if (t === "agent.tool_use" || t === "agent.custom_tool_use" || t === "agent.mcp_tool_use") {
      const name = (p.name as string) ?? "tool";
      const input = (p.input as Record<string, unknown>) ?? {};
      const meta = TOOL_META[name];
      const Icon = meta?.icon ?? LuTerminal;
      const tint: Tint = meta?.tint ?? "neutral";
      const verb = meta?.verb ?? "Running";
      const arg = meta?.arg(input) ?? null;
      const titleVerb = verb.charAt(0).toUpperCase() + verb.slice(1);
      return {
        icon: Icon,
        tint,
        title: arg ? `${titleVerb}…` : `${titleVerb}…`,
        detail: arg,
      };
    }

    if (t === "agent.message") {
      // Hit a finished assistant turn — agent is between turns; bail.
      return null;
    }
  }
  return null;
}

// Small inline loader for generic "loading something" moments. Uses the
// same rotating juice phrases as LiveActivity so the brand voice is
// consistent across the app.
export function JuiceLoader({ className = "" }: { className?: string }) {
  const juice = useJuicePhrase(true);
  return (
    <div className={`flex items-center gap-2 text-sm text-ink-500 italic ${className}`}>
      <PressedSpinner size={18} />
      <span>{juice}…</span>
    </div>
  );
}

export function LiveActivity({ events }: { events: SessionEvent[] }) {
  const activity = deriveActivity(events);
  const juice = useJuicePhrase(true);
  const isJuiceFallback = !activity;

  const info: ActivityInfo = activity ?? {
    icon: LuCitrus,
    tint: "amber",
    title: juice,
    detail: null,
  };
  const cls = TINT[info.tint];

  return (
    <div className="flex items-start gap-2.5">
      <div
        className={`size-7 rounded-lg ${cls.bg} ${cls.icon} grid place-items-center shrink-0 mt-0.5 ${isJuiceFallback ? "" : "animate-pulse"}`}
      >
        {isJuiceFallback
          ? <PressedSpinner size={16} />
          : <info.icon className="size-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className={`${isJuiceFallback ? "activity-juice-text text-base" : "text-sm"} font-semibold ${cls.label}`}>
          {info.title}
        </div>
        {info.detail && (
          <div
            className="mt-0.5 text-sm text-ink-500 line-clamp-2 italic"
            style={{
              maskImage: "linear-gradient(to right, black 75%, transparent)",
              WebkitMaskImage: "linear-gradient(to right, black 75%, transparent)",
            }}
          >
            {info.detail}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Chat stream ────────────────────────────────────────────────────────────
// Higher-level renderer used by /chat (not /runs). Groups consecutive tool
// calls of the same category into a single collapsible summary row
// ("Ran 2 commands", "Explored 1 file"), renders raw reasoning traces as
// visible transcript items, and turns recognizable file paths into clickable
// chips.

type ToolCategory =
  | "command" | "explored" | "created" | "edited"
  | "browsed_web" | "searched_kb" | "attached" | "other";

const TOOL_CATEGORY: Record<string, ToolCategory> = {
  bash: "command",
  read: "explored",
  glob: "explored",
  grep: "explored",
  write: "created",
  edit: "edited",
  web_fetch: "browsed_web",
  web_search: "browsed_web",
  kb_search: "searched_kb",
  kb_list: "searched_kb",
  kb_attach: "attached",
};

const CATEGORY_META: Record<ToolCategory, {
  label: (n: number) => string;
  icon: IconType;
  tint: Tint;
}> = {
  command:      { label: (n) => `Ran ${n} command${n === 1 ? "" : "s"}`,    icon: LuTerminal,     tint: "neutral" },
  explored:     { label: (n) => `Explored ${n} file${n === 1 ? "" : "s"}`,  icon: LuFolderSearch, tint: "sky" },
  created:      { label: (n) => `Created ${n} file${n === 1 ? "" : "s"}`,   icon: LuFilePlus,     tint: "emerald" },
  edited:       { label: (n) => `Edited ${n} file${n === 1 ? "" : "s"}`,    icon: LuPencil,       tint: "amber" },
  browsed_web:  { label: (n) => `Browsed ${n} URL${n === 1 ? "" : "s"}`,    icon: LuGlobe,        tint: "emerald" },
  searched_kb:  { label: () => "Searched the knowledge base",               icon: LuLibrary,      tint: "violet" },
  attached:     { label: (n) => `Attached ${n} file${n === 1 ? "" : "s"}`,  icon: LuPaperclip,    tint: "violet" },
  other:        { label: (n) => `Used ${n} tool${n === 1 ? "" : "s"}`,      icon: LuPuzzle,       tint: "fuchsia" },
};

type ToolStepData = {
  name: string;
  input: Record<string, unknown>;
  result: { text: string; isError: boolean } | null;
  eventId: string;
};

type ChatItem =
  | { kind: "user"; event: SessionEvent }
  | { kind: "thinking"; event: SessionEvent; text: string; signature: string | null }
  | { kind: "assistant"; event: SessionEvent; text: string }
  | { kind: "tool-group"; key: string; category: ToolCategory; steps: ToolStepData[] }
  | { kind: "fallback"; event: SessionEvent };

function categoryFor(name: string): ToolCategory {
  return TOOL_CATEGORY[name] ?? "other";
}

export function buildChatItems(events: SessionEvent[]): ChatItem[] {
  // Pair tool_use → tool_result by id
  const resultByUseId = new Map<string, SessionEvent>();
  for (const e of events) {
    if (e.event_type !== "agent.tool_result"
        && e.event_type !== "agent.mcp_tool_result"
        && e.event_type !== "user.custom_tool_result") continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const id = (p.tool_use_id ?? p.custom_tool_use_id) as string | undefined;
    if (id) resultByUseId.set(id, e);
  }

  const items: ChatItem[] = [];
  let pendingGroup: { category: ToolCategory; steps: ToolStepData[]; firstId: string } | null = null;

  const flush = () => {
    if (pendingGroup) {
      items.push({
        kind: "tool-group",
        key: `g-${pendingGroup.firstId}`,
        category: pendingGroup.category,
        steps: pendingGroup.steps,
      });
      pendingGroup = null;
    }
  };

  for (const e of events) {
    if (isNoiseEvent(e)) continue;
    const t = e.event_type;
    const p = (e.payload ?? {}) as Record<string, unknown>;

    // Skip standalone result events — they've been paired above.
    if (t === "agent.tool_result" || t === "agent.mcp_tool_result" || t === "user.custom_tool_result") {
      continue;
    }

    if (t === "agent.tool_use" || t === "agent.custom_tool_use" || t === "agent.mcp_tool_use") {
      const name = (p.name as string) ?? "tool";
      const input = (p.input as Record<string, unknown>) ?? {};
      const id = (p.id ?? p.tool_use_id) as string | undefined;
      const result = id ? resultByUseId.get(id) : undefined;
      const step: ToolStepData = {
        name,
        input,
        eventId: e.id,
        result: result ? extractResult((result.payload ?? {}) as Record<string, unknown>) : null,
      };
      const category = categoryFor(name);
      if (pendingGroup && pendingGroup.category === category) {
        pendingGroup.steps.push(step);
      } else {
        flush();
        pendingGroup = { category, steps: [step], firstId: e.id };
      }
      continue;
    }

    // Anything that isn't a tool breaks the group.
    flush();

    const { thinking, text: msgText, signature } = extractContent(e);
    if (thinking || signature) {
      items.push({ kind: "thinking", event: e, text: thinking, signature: signature || null });
    }
    if (t === "agent.message" && msgText) {
      items.push({ kind: "assistant", event: e, text: msgText });
      continue;
    }
    if (t === "user.message") {
      items.push({ kind: "user", event: e });
      continue;
    }
    items.push({ kind: "fallback", event: e });
  }
  flush();
  return items;
}

// File-path detection: rough but good enough for chat. Recognizes absolute
// posix paths, relative-with-slash paths, and bare basenames with a known
// extension. We pull these out of tool input args (the obvious key like
// `path` / `file_path`, then `command` / `pattern` etc) and out of tool
// result text so the chip set ends up close to what the user expects.
const EXT_RE = /\.(?:py|js|jsx|ts|tsx|md|json|yaml|yml|sh|css|html|sql|txt|csv|xlsx|pptx|docx|pdf|png|jpe?g|svg|webp|gif)$/i;
const PATH_HINT_KEYS = ["path", "file_path", "filepath", "filename", "file"];

function isPptxPath(s: string): boolean {
  return /\.pptx$/i.test(s);
}

// Extract the first .pptx filename referenced in a bash command string.
// Handles bare filenames ("output.pptx"), paths ("/tmp/deck.pptx"), and
// filenames embedded in longer args ("node gen.js -o deck.pptx").
function pptxFromCommand(cmd: string): string | null {
  const m = cmd.match(/(?:^|\s|=|'|")([^\s'"]+\.pptx)/i);
  return m ? m[1] : null;
}

function isFilePathLike(s: string): boolean {
  if (!s || s.length > 256) return false;
  if (/\s/.test(s)) return false;
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.includes("/")) return true;
  return EXT_RE.test(s);
}

function pathsFromInput(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of PATH_HINT_KEYS) {
    const v = input[k];
    if (typeof v === "string" && isFilePathLike(v)) out.push(v);
  }
  return out;
}

function FilePathChip({
  path, onOpenFile,
}: { path: string; onOpenFile?: (path: string) => void }) {
  const base = path.split("/").filter(Boolean).pop() ?? path;
  return (
    <button
      onClick={onOpenFile ? () => onOpenFile(path) : undefined}
      disabled={!onOpenFile}
      title={path}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-neutral-900 hover:bg-neutral-800 disabled:hover:bg-neutral-900 disabled:cursor-default text-[12px] font-mono text-white align-middle"
    >
      <LuFile className="size-3 text-neutral-400" />
      {base}
    </button>
  );
}

function ToolGroup({
  category, steps, onOpenFile,
}: {
  category: ToolCategory;
  steps: ToolStepData[];
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = CATEGORY_META[category];
  const tint = TINT[meta.tint];
  const ChevIcon = open ? LuChevronDown : LuChevronRight;

  return (
    <div className="text-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-left text-ink-700 hover:text-ink-900"
      >
        <meta.icon className={`size-4 ${tint.icon} shrink-0`} />
        <span className="font-medium">{meta.label(steps.length)}</span>
        <ChevIcon className="size-3.5 text-ink-400" />
      </button>
      {open && (
        <div className="mt-1.5 ml-6 space-y-1.5">
          {steps.map((step) => (
            <ToolDetail key={step.eventId} step={step} category={category} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolDetail({
  step, category, onOpenFile,
}: {
  step: ToolStepData;
  category: ToolCategory;
  onOpenFile?: (path: string) => void;
}) {
  const tm = TOOL_META[step.name];
  const verb = tm?.verb ?? "called";
  const arg = tm?.arg(step.input) ?? null;
  const paths = pathsFromInput(step.input);
  const primaryPath = paths[0];
  const showArg = arg && !primaryPath;

  const FILE_CATEGORIES = new Set<ToolCategory>(["explored", "created", "edited", "attached"]);
  const isFileOp = FILE_CATEGORIES.has(category);

  // Detect pptx for the "View slides" chip: either a direct file-path input
  // (write/read/edit tools) or a .pptx filename embedded in a bash command.
  const commandBody = category === "command" && typeof step.input.command === "string"
    ? (step.input.command as string)
    : null;
  const pptxFromCmd = commandBody ? pptxFromCommand(commandBody) : null;
  const pptxTarget = (primaryPath && isPptxPath(primaryPath) ? primaryPath : null) ?? pptxFromCmd;
  const isPptx = !!pptxTarget;

  return (
    <div className="text-[13px] rounded-2xl border border-neutral-200/80 bg-white/85 px-3 py-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-ink-500 capitalize">{verb}</span>
        {primaryPath && <FilePathChip path={primaryPath} onOpenFile={onOpenFile} />}
        {isPptx && onOpenFile && pptxTarget && (
          <button
            onClick={() => onOpenFile(pptxTarget)}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-violet-100 hover:bg-violet-200 text-[12px] font-medium text-violet-700 align-middle"
          >
            <LuPresentation className="size-3 text-violet-500" />
            View slides
          </button>
        )}
        {!isFileOp && showArg && <span className="font-mono text-ink-700 truncate">{arg}</span>}
        {!isFileOp && !showArg && <span className="text-ink-400">in progress</span>}
      </div>
    </div>
  );
}

export function ChatStream({
  events, onRetry, onOpenFile,
}: {
  events: SessionEvent[];
  onRetry?: (text: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const items = buildChatItems(events);
  return (
    <>
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return <UserBubble key={`${item.event.id}-user`} event={item.event} />;
          case "thinking":
            return <ThinkingTrace key={`${item.event.id}-thinking`} text={item.text} signature={item.signature} />;
          case "assistant":
            return <AssistantBubble key={`${item.event.id}-assistant`} text={item.text} time={item.event.processed_at} onRetry={onRetry} />;
          case "tool-group":
            return <ToolGroup key={item.key} category={item.category} steps={item.steps} onOpenFile={onOpenFile} />;
          case "fallback":
            return <EventRow key={`${item.event.id}-fallback`} event={item.event} />;
        }
      })}
    </>
  );
}

function UserBubble({ event }: { event: SessionEvent }) {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const { text: msgText } = extractContent(event);
  const text = msgText || extractResult(p).text;
  if (!text) return null;
  return (
    <div className="flex justify-end">
      <div className="max-w-[75%] bg-white rounded-2xl rounded-tr-md shadow-soft px-4 py-2.5 text-sm text-ink-800 whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}

function AssistantBubble({
  text,
  time,
  onRetry,
}: {
  text: string;
  time?: string | null;
  onRetry?: (text: string) => void;
}) {
  const segments = useMemo(() => splitChartBlocks(text), [text]);
  const hasCharts = segments.some((s) => s.kind === "chart");

  return (
    <div className="flex justify-start">
      <div className={`${hasCharts ? "max-w-[90%] w-full" : "max-w-[75%]"} min-w-0`}>
        <div className="bg-white rounded-2xl rounded-tl-md shadow-soft px-4 py-2.5 text-sm text-ink-800">
          {segments.map((seg, i) =>
            seg.kind === "md" ? (
              <div
                key={i}
                className="markdown-body"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.text) }}
              />
            ) : (
              <InlineChart key={i} json={seg.json} />
            )
          )}
        </div>
        <MessageActions text={text} time={time} onRetry={onRetry} />
      </div>
    </div>
  );
}

function InlineChart({ json }: { json: string }) {
  const spec = useMemo(() => tryParseChartSpec(json), [json]);
  if (!spec) {
    return (
      <div className="my-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-mono text-rose-600">
        Invalid chart spec
      </div>
    );
  }
  return (
    <div className="my-3 -mx-1">
      <Suspense fallback={<div className="h-[224px] animate-pulse rounded-xl bg-neutral-50" />}>
        <LazyChartView spec={spec} />
      </Suspense>
    </div>
  );
}

function ThinkingTrace({ text, signature }: { text: string; signature?: string | null }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[78%] min-w-0 rounded-2xl rounded-tl-md border border-indigo-100/80 bg-indigo-50/70 px-4 py-3 shadow-soft">
        <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] text-indigo-600">
          <LuBrain className="size-3.5" />
          Reasoning trace
        </div>
        <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink-700">
          {text || "Thinking text omitted; preserved signature returned by Anthropic."}
        </div>
        {signature && (
          <div className="mt-3 rounded-xl border border-indigo-200/80 bg-white/70 px-3 py-2">
            <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-indigo-500">Signature</div>
            <div className="mt-1 break-all font-mono text-[11px] leading-5 text-ink-500">
              {signature}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
