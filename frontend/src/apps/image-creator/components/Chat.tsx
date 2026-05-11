// Director chat panel.
//
// Lifecycle:
//   1. If the board has no session_id yet, render a "Set up Director"
//      button. Click → POST /vibe-boards/setup → ensures the Director
//      agent + a default environment exist. Then click "Start chat" →
//      POST /sessions, PATCH the board to bind the session, attach SSE.
//   2. Once bound, render the live event timeline + composer. Each user
//      message is sent via POST /sessions/:id/events; the SSE stream
//      brings agent.message_chunk → agent.message back, plus tool_use
//      events the dispatcher handles server-side. We also watch for
//      tool_use_id="update_board" so the parent can refresh the board
//      and the canvas updates instantly.

import { useEffect, useRef, useState } from "react";
import {
  LuMessageCircle, LuSend, LuSparkles, LuTriangleAlert, LuPlay, LuRotateCw,
} from "react-icons/lu";
import { api, type Agent, type Session, type SessionEvent, type VibeBoard } from "../../../lib/api";
import { useApi, refresh } from "../../../lib/swr";
import { FN_URL, supabase } from "../../../lib/supabase";

type SetupResp = { agent: Agent; environment: { id: string; anthropic_id: string } };

export function DirectorChat({
  board,
  onAgentDidUpdateBoard,
}: {
  board: VibeBoard;
  onAgentDidUpdateBoard: () => void;
}) {
  const sessionId = board.session_id;
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupErr, setSetupErr] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupResp | null>(null);
  const [starting, setStarting] = useState(false);

  // The chat is unusable until we know the Director agent + environment
  // exist. On mount we always call /vibe-boards/setup — it's idempotent and
  // syncs the system prompt + tools to the latest version in code, so prompt
  // updates propagate without forcing the user to delete their agent.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.post<SetupResp>("/vibe-boards/setup", {});
        if (!cancelled) setSetup(resp);
      } catch { /* fall through to manual setup CTA */ }
    })();
    return () => { cancelled = true; };
  }, []);

  async function runSetup() {
    setSetupBusy(true); setSetupErr(null);
    try {
      const resp = await api.post<SetupResp>("/vibe-boards/setup", {});
      setSetup(resp);
    } catch (e) { setSetupErr((e as Error).message); }
    finally { setSetupBusy(false); }
  }

  async function startSession() {
    if (!setup) return;
    setStarting(true);
    try {
      const created = await api.post<Session>("/sessions", {
        agent_id: setup.agent.id,
        environment_id: setup.environment.id,
        title: board.name,
      });
      await api.patch(`/vibe-boards/${board.id}`, { session_id: created.id });
      refresh(`/vibe-boards/${board.id}`);
    } finally { setStarting(false); }
  }

  if (!sessionId) {
    return (
      <ChatShell>
        <div className="flex-1 grid place-items-center p-6">
          <div className="text-center max-w-[260px] space-y-3">
            <LuSparkles className="size-6 text-fuchsia-400 mx-auto" />
            {!setup ? (
              <>
                <div className="text-sm text-ink-700 font-medium">Set up the Director</div>
                <div className="text-xs text-ink-500">
                  One-time: creates the Image Studio Director agent and a default environment so this app can talk to Claude.
                </div>
                <button
                  className="btn-primary"
                  onClick={runSetup}
                  disabled={setupBusy}
                >
                  {setupBusy ? "Setting up…" : "Set up Director"}
                </button>
                {setupErr && <div className="text-xs text-rose-600">{setupErr}</div>}
              </>
            ) : (
              <>
                <div className="text-sm text-ink-700 font-medium">Start a Director conversation</div>
                <div className="text-xs text-ink-500">
                  Bound to <strong>{board.name}</strong>. Persistent across sessions.
                </div>
                <button className="btn-primary" onClick={startSession} disabled={starting}>
                  <LuPlay className="size-3.5" />
                  {starting ? "Starting…" : "Start chat"}
                </button>
              </>
            )}
          </div>
        </div>
      </ChatShell>
    );
  }

  // The "Refresh" affordance inside the bound chat starts a brand-new
  // Director session against the same agent + env, then re-binds it on the
  // board. The current chat history stays archived under its old session
  // row but the panel renders the fresh empty conversation.
  //
  // We resolve agent + env on demand here (instead of relying on cached
  // `setup` state) because the setup probe may not have completed yet, or
  // may have failed silently. /vibe-boards/setup is idempotent + fast.
  async function onNewSession() {
    const resolved = setup ?? await api.post<SetupResp>("/vibe-boards/setup", {});
    if (!setup) setSetup(resolved);
    const created = await api.post<Session>("/sessions", {
      agent_id: resolved.agent.id,
      environment_id: resolved.environment.id,
      title: board.name,
    });
    await api.patch(`/vibe-boards/${board.id}`, { session_id: created.id });
    refresh(`/vibe-boards/${board.id}`);
  }

  return (
    <ChatBound
      // key off session_id so a new session forces ChatBound to remount with
      // fresh local state (cleared message draft, fresh streamGen, etc).
      key={sessionId}
      sessionId={sessionId}
      onAgentDidUpdateBoard={onAgentDidUpdateBoard}
      onNewSession={onNewSession}
    />
  );
}

function ChatShell({
  children, headerActions,
}: { children: React.ReactNode; headerActions?: React.ReactNode }) {
  return (
    <aside className="border-l border-zinc-800 flex flex-col bg-zinc-950 min-h-0">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold flex items-center gap-1.5 text-zinc-100">
            <LuMessageCircle className="size-4 text-fuchsia-400" />
            Director
          </div>
          <div className="text-[11px] text-zinc-500">Image gen agent</div>
        </div>
        {headerActions}
      </div>
      {children}
    </aside>
  );
}

function ChatBound({
  sessionId, onAgentDidUpdateBoard, onNewSession,
}: {
  sessionId: string;
  onAgentDidUpdateBoard: () => void;
  /** Tear down the current session and start a fresh one against the same
   *  Director agent. The parent updates the board's session_id binding,
   *  which remounts ChatBound under a new key. */
  onNewSession: () => Promise<void>;
}) {
  const { data, mutate } = useApi<{ session: Session; events: SessionEvent[] }>(
    `/runs/${sessionId}`,
    { refreshInterval: 8000 },
  );
  const [streaming, setStreaming] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Bumping this counter cancels the current SSE-attach effect and starts a
  // fresh one — the user-facing "Refresh" button uses this to recover when
  // the stream gets stuck.
  const [streamGen, setStreamGen] = useState(0);
  // True from the moment the user hits send until the agent's next message
  // (or the session goes idle). Drives the "Director is thinking…" UI so the
  // user sees the agent acknowledged the request even before the SSE stream
  // catches up.
  const [awaiting, setAwaiting] = useState(false);
  const eventsRef = useRef<HTMLDivElement>(null);
  const lastUpdateBoardSeen = useRef<string | null>(null);

  // Auto-attach the SSE stream once the session exists, so tool calls run.
  // We use an AbortController so unmount/reset actually closes the stream
  // server-side — otherwise the previous stream's fetch keeps holding an
  // edge-function worker (the local runtime has very few), which is why
  // creating a new session used to take "forever" to free up resources.
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    (async () => {
      if (streaming) return;
      setStreaming(true);
      try {
        const sessData = (await supabase.auth.getSession()).data.session;
        const res = await fetch(`${FN_URL}/sessions/${sessionId}/stream`, {
          signal: ac.signal,
          headers: {
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${sessData?.access_token ?? ""}`,
            Accept: "text/event-stream",
          },
        });
        if (!res.body || cancelled) return;
        const reader = res.body.getReader();
        while (!cancelled) {
          const { done } = await reader.read();
          if (done) break;
          await mutate();
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.warn("[chat] stream error:", err);
        }
      } finally {
        setStreaming(false);
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, streamGen]);

  // Auto-scroll to bottom on new events.
  useEffect(() => {
    if (eventsRef.current) {
      eventsRef.current.scrollTop = eventsRef.current.scrollHeight;
    }
  }, [data?.events?.length]);

  // Detect agent update_board calls and notify the parent so the canvas
  // refreshes immediately — don't make the user wait for our 4s poll.
  useEffect(() => {
    if (!data?.events) return;
    for (const e of data.events) {
      if (lastUpdateBoardSeen.current && e.id <= lastUpdateBoardSeen.current) continue;
      const p = e.payload as Record<string, unknown>;
      if (mentionsUpdateBoard(p)) {
        onAgentDidUpdateBoard();
        lastUpdateBoardSeen.current = e.id;
      }
    }
  }, [data?.events, onAgentDidUpdateBoard]);

  // Clear the awaiting flag when either an agent.message lands or the session
  // returns to idle. We keep tool-use events from clearing it because the
  // agent might still be working through generation.
  useEffect(() => {
    if (!awaiting || !data) return;
    const status = data.session?.status;
    if (status === "idle" || status === "terminated") { setAwaiting(false); return; }
    // Look for an agent message *after* the most recent user message. If
    // there is one, the agent has replied and we can stop "thinking…".
    const events = data.events ?? [];
    let lastUserAt: string | null = null;
    for (const e of events) if (e.event_type === "user.message") lastUserAt = e.created_at;
    if (!lastUserAt) return;
    const replied = events.some(
      (e) => e.event_type === "agent.message" && e.created_at > lastUserAt!,
    );
    if (replied) setAwaiting(false);
  }, [data, awaiting]);

  async function send() {
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    setMessage("");
    setAwaiting(true);
    try {
      await api.post(`/sessions/${sessionId}/events`, {
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      });
      mutate();
    } finally { setSending(false); }
  }

  const events = data?.events ?? [];
  const status = data?.session?.status;
  const showThinking = awaiting || status === "running";
  const lastToolName = pickLastToolName(events);

  const [refreshError, setRefreshError] = useState<string | null>(null);
  async function onRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await onNewSession();
      // ChatBound is keyed by sessionId, so the parent's board prop update
      // will tear this component down and remount it on the new session.
    } catch (err) {
      const msg = (err as Error).message ?? "Couldn't start a new conversation";
      console.warn("[chat] new session failed:", err);
      setRefreshError(msg);
    } finally {
      setTimeout(() => setRefreshing(false), 300);
    }
  }

  const headerActions = (
    <button
      type="button"
      onClick={onRefresh}
      disabled={refreshing}
      className="size-7 grid place-items-center rounded-md text-zinc-500 hover:text-zinc-100 hover:bg-zinc-900 transition-colors disabled:opacity-50"
      title="Start a new Director conversation"
    >
      <LuRotateCw className={["size-3.5", refreshing ? "animate-spin" : ""].join(" ")} />
    </button>
  );

  return (
    <ChatShell headerActions={headerActions}>
      {refreshError && (
        <div className="text-[11px] text-rose-300 bg-rose-500/10 border-b border-rose-500/30 px-3 py-1.5 flex items-start gap-1">
          <LuTriangleAlert className="size-3 mt-0.5 shrink-0" /> {refreshError}
        </div>
      )}
      <div ref={eventsRef} className="flex-1 overflow-y-auto p-3 space-y-2">
        {events.length === 0 ? (
          <div className="text-xs text-zinc-500 italic px-2">
            Say something — try "look at my board and propose 3 hero image directions, then generate one with Gemini."
          </div>
        ) : events.map((e) => <ChatRow key={e.id} event={e} />)}
        {showThinking && (
          <div className="rounded-lg border border-fuchsia-200 bg-fuchsia-50/60 px-3 py-2 mr-6 flex items-center gap-2">
            <ThinkingDots />
            <div className="text-xs text-fuchsia-700">
              {lastToolName === "generate_image_openai"
                ? "Generating with OpenAI…"
                : lastToolName === "generate_image_gemini"
                ? "Generating with Gemini…"
                : lastToolName === "read_board"
                ? "Reading the board…"
                : lastToolName === "update_board"
                ? "Placing items on the canvas…"
                : "Director is thinking…"}
            </div>
          </div>
        )}
      </div>
      <div className="border-t border-zinc-800 bg-zinc-950 p-2 flex gap-1.5">
        <input
          className="flex-1 bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-fuchsia-400/50"
          placeholder="Ask the Director…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          disabled={sending}
        />
        <button
          className="rounded-md px-3 py-2 bg-fuchsia-500 text-white hover:bg-fuchsia-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          onClick={send}
          disabled={!message.trim() || sending}
          title="Send"
        >
          <LuSend className="size-3.5" />
        </button>
      </div>
    </ChatShell>
  );
}

function ChatRow({ event }: { event: SessionEvent }) {
  const t = event.event_type;
  const p = event.payload as Record<string, unknown>;

  // Render plain text for user.message and agent.message; condense everything
  // else as a small status chip so the chat stays readable.
  if (t === "user.message" || t === "agent.message") {
    const text = extractText(p);
    if (!text) return null;
    return (
      <div className={[
        "rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
        t === "user.message"
          ? "bg-fuchsia-500/15 text-zinc-100 ml-6 border border-fuchsia-400/20"
          : "bg-zinc-900 border border-zinc-800 text-zinc-100 mr-6",
      ].join(" ")}>
        {text}
      </div>
    );
  }
  if (t.startsWith("agent.tool_use") || (t === "agent.message_chunk" && hasToolUse(p))) {
    const tool = pickToolName(p);
    if (!tool) return null;
    return (
      <div className="text-[11px] font-mono text-zinc-500 px-3">
        → {tool}…
      </div>
    );
  }
  if (t.startsWith("session.error")) {
    const text = (p.message as string) ?? "";
    return (
      <div className="text-[11px] text-rose-400 px-3 flex items-start gap-1">
        <LuTriangleAlert className="size-3 mt-0.5" /> {text || "Error"}
      </div>
    );
  }
  return null;
}

function extractText(p: Record<string, unknown>): string {
  if (Array.isArray(p.content)) {
    return (p.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
  return "";
}

function hasToolUse(p: Record<string, unknown>): boolean {
  const blocks = (p.content as Array<Record<string, unknown>>) ?? [];
  return blocks.some((b) => b.type === "tool_use");
}

function pickToolName(p: Record<string, unknown>): string | null {
  if (typeof p.name === "string") return p.name;
  const blocks = (p.content as Array<Record<string, unknown>>) ?? [];
  const tu = blocks.find((b) => b.type === "tool_use" && typeof b.name === "string");
  return tu ? (tu.name as string) : null;
}

function mentionsUpdateBoard(p: Record<string, unknown>): boolean {
  if (p.name === "update_board") return true;
  const blocks = (p.content as Array<Record<string, unknown>>) ?? [];
  for (const b of blocks) {
    if (b?.type === "tool_use" && b?.name === "update_board") return true;
  }
  return false;
}

// Walk events newest-to-oldest and return the most recent tool name we
// surfaced — drives the contextual "Generating with Gemini…" copy on the
// thinking indicator.
function pickLastToolName(events: SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const name = pickToolName(e.payload as Record<string, unknown>);
    if (name) return name;
  }
  return null;
}

function ThinkingDots() {
  return (
    <span className="inline-flex gap-0.5">
      <span className="size-1 bg-fuchsia-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
      <span className="size-1 bg-fuchsia-400 rounded-full animate-bounce" style={{ animationDelay: "120ms" }} />
      <span className="size-1 bg-fuchsia-400 rounded-full animate-bounce" style={{ animationDelay: "240ms" }} />
    </span>
  );
}
