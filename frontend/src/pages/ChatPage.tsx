// /chat — Conversation surface for talking to agents. The app shell owns the
// recent-chat list when chat mode is active, so this page focuses on the
// active transcript, composer, and file/output context.

import { Component, type ErrorInfo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  LuPlus, LuBan, LuSend, LuFile, LuFileText,
  LuFileSpreadsheet, LuImage, LuFileCode, LuPresentation, LuPaperclip,
  LuDownload, LuExternalLink, LuSearch, LuUpload, LuChevronDown,
} from "react-icons/lu";

import type { IconType } from "react-icons";
import {
  api, type Agent, type Environment, type KbFile, type RunOutput, type Session, type SessionEvent,
} from "../lib/api";
import { refresh, useApi } from "../lib/swr";
import { Page, Modal, StatusPill } from "../components/Page";
import { OutputPreview } from "../components/OutputPreview";
import { ChatStream, JuiceLoader, LiveActivity } from "../components/ChatEvents";
import { FN_URL, supabase } from "../lib/supabase";
import { humanizeBytes } from "../lib/format";
import { uploadKbFile } from "../lib/kb";
import { OrbAvatar } from "../components/OrbAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ChatPage() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const location = useLocation();
  const nav = useNavigate();

  // Agent pre-selected via Roster "Chat" button — read once then clear state
  const preselectedAgentId = (location.state as { newChatAgentId?: string } | null)?.newChatAgentId;
  useEffect(() => {
    if (preselectedAgentId) window.history.replaceState({}, "");
  }, [preselectedAgentId]);

  return (
    <Page
      title="Chat"
      subtitle="Conversations with your agents, plus the files and outputs they work with along the way."
      actions={
        sessionId ? (
          <Button size="sm" onClick={() => nav("/chat")}>
            <LuPlus className="size-4" /> New chat
          </Button>
        ) : undefined
      }
    >
      <div className="h-full overflow-hidden">
        {sessionId ? (
          <ChatSurface sessionId={sessionId} />
        ) : (
          <NewChatComposer initialAgentId={preselectedAgentId} />
        )}
      </div>
    </Page>
  );
}

function ChatSurface({ sessionId }: { sessionId: string }) {
  const { data, mutate } = useApi<{ session: Session; events: SessionEvent[]; outputs?: RunOutput[] }>(
    `/runs/${sessionId}`,
    // Poll faster while the agent is actively producing events. SWR accepts
    // a function so we can react to the latest status without re-subscribing.
    {
      refreshInterval: (latest) => latest?.session?.status === "running" ? 1500 : 4000,
      dedupingInterval: 800,
    },
  );
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const [filesOpen, setFilesOpen] = useState(true);
  const [previewing, setPreviewing] = useState<RunOutput | null>(null);
  const [kbPickerOpen, setKbPickerOpen] = useState(false);
  const [attaching, setAttaching] = useState(false);
  // Events the user just sent that haven't shown up in the polled response
  // yet. We splice these onto the rendered list so the UI feels instant. Each
  // optimistic entry is keyed by a temp id and dropped once a real event with
  // matching text arrives.
  const [optimistic, setOptimistic] = useState<SessionEvent[]>([]);
  const [optimisticAttached, setOptimisticAttached] = useState<AttachedFile[]>([]);
  const [dropTarget, setDropTarget] = useState(false);
  const dragCounter = useRef(0);
  const eventsRef = useRef<HTMLDivElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Prevent the browser from navigating when a file is dropped outside our zone.
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  const status = data?.session?.status;
  const realEvents = data?.events ?? [];

  // Drop optimistic events once the real one arrives. Match on user.message
  // payloads by text since the temp id won't match.
  useEffect(() => {
    if (optimistic.length === 0) return;
    const realTexts = new Set<string>();
    for (const e of realEvents) {
      if (e.event_type !== "user.message") continue;
      const c = ((e.payload ?? {}) as Record<string, unknown>).content;
      if (Array.isArray(c)) {
        for (const b of c) {
          const t = (b as Record<string, unknown> | undefined)?.text;
          if (typeof t === "string") realTexts.add(t);
        }
      }
    }
    if (realTexts.size === 0) return;
    setOptimistic((prev) => prev.filter((o) => {
      const c = ((o.payload ?? {}) as Record<string, unknown>).content;
      if (!Array.isArray(c)) return true;
      for (const b of c) {
        const t = (b as Record<string, unknown> | undefined)?.text;
        if (typeof t === "string" && realTexts.has(t)) return false;
      }
      return true;
    }));
  }, [realEvents]);

  useEffect(() => {
    if (optimisticAttached.length === 0) return;
    const attachedNow = collectAttachedFiles(realEvents);
    setOptimisticAttached((prev) => prev.filter((pending) => !attachedNow.some((real) =>
      (pending.kb_file_id && real.kb_file_id === pending.kb_file_id)
      || (pending.mount_path && real.mount_path === pending.mount_path)
      || real.file_name === pending.file_name
    )));
  }, [realEvents, optimisticAttached.length]);

  // Attach to the session SSE stream as soon as the chat opens, not just once
  // the local status flips to `running`. Thinking events can arrive before the
  // next poll notices the session is active, and Anthropic may not replay that
  // content from events.list later. The backend stream proxy persists events to
  // session_events as they arrive, then we re-fetch (SWR dedupes).
  useEffect(() => {
    if (status === "terminated") return;
    let cancelled = false;
    let abort: AbortController | null = null;
    (async () => {
      try {
        const { data: sessData } = await supabase.auth.getSession();
        const jwt = sessData.session?.access_token;
        abort = new AbortController();
        const res = await fetch(`${FN_URL}/sessions/${sessionId}/stream`, {
          headers: {
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${jwt}`,
            Accept: "text/event-stream",
          },
          signal: abort.signal,
        });
        if (!res.body || cancelled) return;
        const reader = res.body.getReader();
        while (!cancelled) {
          const { done } = await reader.read();
          if (done) break;
          // Pull a fresh snapshot from the DB — dedupingInterval throttles.
          mutate();
        }
      } catch {
        // Stream errored or aborted — fall back to plain polling.
      }
    })();
    return () => { cancelled = true; abort?.abort(); };
  }, [status, sessionId, mutate]);

  // Auto-scroll only when the user is already near the bottom — otherwise
  // we'd yank them away from what they were reading every time an event
  // arrived. 60px tolerance covers "basically at the bottom" without
  // counting "scrolled up to read."
  useEffect(() => {
    const el = eventsRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 60) el.scrollTop = el.scrollHeight;
  }, [realEvents.length, optimistic.length]);

  useEffect(() => {
    if (!awaiting) return;
    if (status === "running" || status === "terminated") {
      setAwaiting(false);
      return;
    }
    let lastUserAt: string | null = null;
    for (const e of realEvents) {
      if (e.event_type === "user.message") lastUserAt = e.created_at;
    }
    if (!lastUserAt) return;
    const replied = realEvents.some(
      (e) => e.event_type === "agent.message" && e.created_at > lastUserAt!,
    );
    if (replied) setAwaiting(false);
  }, [awaiting, realEvents, status]);

  useEffect(() => {
    setMessage("");
    setSending(false);
    setAwaiting(false);
    setPreviewing(null);
    setKbPickerOpen(false);
    setAttaching(false);
    setOptimistic([]);
    setOptimisticAttached([]);
  }, [sessionId]);

  const events = useMemo(() => [...realEvents, ...optimistic], [realEvents, optimistic]);
  const attached = useMemo(() => mergeAttachedFiles(collectAttachedFiles(events), optimisticAttached), [events, optimisticAttached]);

  if (!data) return <div className="p-6"><JuiceLoader /></div>;
  const { session } = data;
  const terminated = session.status === "terminated";

  async function sendText(text: string) {
    if (!text.trim() || sending) return;
    setSending(true);
    setAwaiting(true);
    const optimisticId = `optimistic-${Date.now()}`;
    setOptimistic((prev) => [...prev, {
      id: optimisticId,
      session_id: sessionId,
      anthropic_event_id: null,
      event_type: "user.message",
      payload: { content: [{ type: "text", text }] },
      processed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    } as SessionEvent]);
    try {
      await api.post(`/sessions/${sessionId}/events`, {
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      });
      mutate();
    } catch (err) {
      // Roll back the optimistic message if the post failed.
      setOptimistic((prev) => prev.filter((o) => o.id !== optimisticId));
      setAwaiting(false);
      alert(`Send failed: ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  }

  async function send() {
    if (!message.trim()) return;
    const text = message;
    setMessage("");
    await sendText(text);
  }

  async function retry() {
    // Re-send the most recent user message verbatim. Managed Agents can't
    // truncate the assistant's last turn, so the agent will respond again as
    // a fresh turn — closest analog to "regenerate".
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].event_type === "user.message") {
        const c = (events[i].payload as Record<string, unknown> | undefined)?.content;
        let text = "";
        if (Array.isArray(c)) {
          for (const b of c) {
            if (b && typeof b === "object" && typeof (b as Record<string, unknown>).text === "string") {
              text += (b as Record<string, unknown>).text as string;
            }
          }
        }
        if (text) { await sendText(text); return; }
      }
    }
  }

  async function interrupt() {
    if (!confirm("Interrupt this conversation?")) return;
    await api.post(`/sessions/${sessionId}/interrupt`);
    mutate();
  }

  const outputs = data.outputs ?? [];
  const totalFiles = outputs.length + attached.length;

  function addOptimisticAttachment(file: KbFile) {
    setOptimisticAttached((prev) => mergeAttachedFiles(prev, [{
      file_name: file.name,
      mount_path: `/mnt/session/uploads/${file.name}`,
      kb_file_id: file.id,
    }]));
  }

  async function attachKbFile(file: KbFile) {
    if (attaching) return;
    setAttaching(true);
    setFilesOpen(true);
    addOptimisticAttachment(file);
    try {
      const res = await api.post<AttachKbResponse>(`/sessions/${sessionId}/attachments/kb`, {
        kb_file_id: file.id,
      });
      if (!res.attached) throw new Error(res.error ?? `Couldn't attach ${file.name}`);
      setKbPickerOpen(false);
      mutate();
    } catch (err) {
      setOptimisticAttached((prev) => prev.filter((item) => item.kb_file_id !== file.id));
      alert(`Attach failed: ${(err as Error).message}`);
    } finally {
      setAttaching(false);
    }
  }

  async function uploadAndAttach(file: File) {
    setAttaching(true);
    setFilesOpen(true);
    let uploaded: KbFile | null = null;
    try {
      uploaded = await uploadKbFile(file);
      addOptimisticAttachment(uploaded);
      const res = await api.post<AttachKbResponse>(`/sessions/${sessionId}/attachments/kb`, {
        kb_file_id: uploaded.id,
      });
      if (!res.attached) throw new Error(res.error ?? `Couldn't attach ${uploaded.name}`);
      refresh("/kb/files");
      mutate();
    } catch (err) {
      if (uploaded) {
        setOptimisticAttached((prev) => prev.filter((item) => item.kb_file_id !== uploaded?.id));
      }
      alert(`Upload failed: ${(err as Error).message}`);
    } finally {
      setAttaching(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  }

  // Resolve a file chip's path to something we can open. Anthropic doesn't
  // expose arbitrary container files via API — we can only preview things
  // that already exist as Anthropic Files (outputs) or as attached KB rows.
  // Match by basename and open the right surface; otherwise just pop the
  // Files panel so the user sees what's available.
  function openFile(path: string) {
    const base = (path.split("/").filter(Boolean).pop() ?? path).toLowerCase();
    const output = outputs.find((o) => (o.name ?? "").toLowerCase() === base);
    if (output) {
      setPreviewing(output);
      setFilesOpen(true);
      return;
    }
    const kb = attached.find((a) => a.file_name.toLowerCase() === base);
    if (kb?.kb_file_id) {
      window.open(`/knowledge?file=${kb.kb_file_id}`, "_blank", "noopener");
      return;
    }
    setFilesOpen(true);
  }

  return (
    <div
      className="h-full flex relative"
      onDragEnter={(e) => { e.preventDefault(); dragCounter.current++; if (dragCounter.current === 1) setDropTarget(true); }}
      onDragLeave={(e) => { e.preventDefault(); dragCounter.current--; if (dragCounter.current === 0) setDropTarget(false); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDrop={(e) => { e.preventDefault(); dragCounter.current = 0; setDropTarget(false); const f = e.dataTransfer.files?.[0]; if (f && !terminated) void uploadAndAttach(f); }}
    >
      {dropTarget && !terminated && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/80 border-2 border-dashed border-primary pointer-events-none">
          <LuUpload className="size-8 text-primary" />
          <span className="text-base font-medium text-primary">Drop to attach file</span>
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col">
      <div className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="text-base font-semibold truncate">{session.title ?? "Untitled"}</h2>
          <StatusPill status={session.status} />
        </div>
        <div className="flex items-center gap-2" />
      </div>

      <div ref={eventsRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-3 bg-muted/20">
        {events.length === 0 ? (
          <div className="text-sm text-muted-foreground">Say something to get started…</div>
        ) : (
          <ChatErrorBoundary>
            <ChatStream events={events} onRetry={retry} onOpenFile={openFile} />
          </ChatErrorBoundary>
        )}
        {(awaiting || session.status === "running") && <LiveActivity events={events} />}
      </div>

      <div className="border-t border-border px-4 py-3 flex gap-2 bg-background">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              disabled={terminated || attaching}
              title="Attach a file"
            >
              <LuPaperclip className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start">
            <DropdownMenuItem onClick={() => setKbPickerOpen(true)}>
              <LuPaperclip className="size-4" />
              Attach from knowledge base
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => uploadInputRef.current?.click()}>
              <LuUpload className="size-4" />
              Upload from computer
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input
          ref={uploadInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void uploadAndAttach(file);
          }}
        />
        <Input
          placeholder={terminated ? "This chat ended." : "Message your agent…"}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          disabled={terminated || sending}
          className="flex-1"
        />
        <Button
          onClick={send}
          disabled={!message.trim() || terminated || sending}
          size="sm"
        >
          <LuSend className="size-3.5" /> Send
        </Button>
      </div>
      </div>
      {filesOpen && (
        <FilesPanel
          sessionId={sessionId}
          outputs={outputs}
          attached={attached}
          previewing={previewing}
          setPreviewing={setPreviewing}
          onUpload={uploadAndAttach}
        />
      )}
      <AttachKbModal
        open={kbPickerOpen}
        onClose={() => setKbPickerOpen(false)}
        onAttach={(file) => attachKbFile(file)}
        busy={attaching}
      />
    </div>
  );
}

// Walks events for kb_attach custom-tool results. Each kb_attach result is a
// JSON-stringified `{attached, file_name, mount_path, ...}` payload, sent as
// user.custom_tool_result. Dedupes by mount_path.
type AttachedFile = {
  file_name: string;
  mount_path: string | null;
  kb_file_id: string | null;
};

type AttachKbResponse = {
  attached: boolean;
  error?: string;
};

// Group sessions into "Today / Yesterday / This week / Older" buckets based
// on started_at. Sessions inside each group stay newest-first.
// Error boundary so a single malformed event payload doesn't blank out the
// chat. We surface a small inline notice instead of unmounting the surface.
class ChatErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[chat] render error:", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-3">
          Something glitched while rendering this conversation. Reload to retry.
          <pre className="mt-2 text-[11px] font-mono text-rose-600 whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function collectAttachedFiles(events: SessionEvent[]): AttachedFile[] {
  const byPath = new Map<string, AttachedFile>();
  // Build a tool_use_id → kb_file_id lookup from kb_attach invocations, so we
  // can carry the kb_file_id forward onto the result row.
  const idToKbFile = new Map<string, string>();
  for (const e of events) {
    if (e.event_type !== "agent.custom_tool_use") continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (p.name !== "kb_attach") continue;
    const id = (p.id ?? p.tool_use_id) as string | undefined;
    const kbId = ((p.input as Record<string, unknown>) ?? {}).kb_file_id;
    if (id && typeof kbId === "string") idToKbFile.set(id, kbId);
  }
  for (const e of events) {
    if (e.event_type === "pressed.kb_attached") {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (p.attached !== true || typeof p.file_name !== "string") continue;
      const mount = typeof p.mount_path === "string" ? p.mount_path : null;
      const key = mount ?? (p.file_name as string);
      if (byPath.has(key)) continue;
      byPath.set(key, {
        file_name: p.file_name as string,
        mount_path: mount,
        kb_file_id: typeof p.kb_file_id === "string" ? p.kb_file_id : null,
      });
      continue;
    }
    if (e.event_type !== "user.custom_tool_result") continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const useId = (p.custom_tool_use_id ?? p.tool_use_id) as string | undefined;
    const content = p.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (b && typeof b === "object" && typeof (b as Record<string, unknown>).text === "string") {
          text += (b as Record<string, unknown>).text as string;
        }
      }
    }
    if (!text || !text.includes("attached")) continue;
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      if (obj.attached !== true || typeof obj.file_name !== "string") continue;
      const mount = typeof obj.mount_path === "string" ? obj.mount_path : null;
      const key = mount ?? (obj.file_name as string);
      if (byPath.has(key)) continue;
      byPath.set(key, {
        file_name: obj.file_name as string,
        mount_path: mount,
        kb_file_id: useId ? (idToKbFile.get(useId) ?? null) : null,
      });
    } catch {
      // Not a JSON-attached result — skip.
    }
  }
  return Array.from(byPath.values());
}

function mergeAttachedFiles(primary: AttachedFile[], secondary: AttachedFile[]): AttachedFile[] {
  const merged = new Map<string, AttachedFile>();
  for (const file of [...primary, ...secondary]) {
    const key = file.kb_file_id ?? file.mount_path ?? file.file_name;
    if (!merged.has(key)) merged.set(key, file);
  }
  return Array.from(merged.values());
}

function iconFor(name: string | null | undefined, mime?: string | null): IconType {
  const lower = (name ?? "").toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "svg", "webp", "gif"].includes(ext)) return LuImage;
  if (ext === "xlsx" || ext === "csv" || m.includes("spreadsheetml")) return LuFileSpreadsheet;
  if (ext === "pptx" || m.includes("presentationml")) return LuPresentation;
  if (ext === "json" || m === "application/json") return LuFileCode;
  if (ext === "md" || ext === "txt" || ext === "docx" || ext === "pdf") return LuFileText;
  return LuFile;
}

function FilesPanel({
  sessionId, outputs, attached, previewing, setPreviewing, onUpload,
}: {
  sessionId: string;
  outputs: RunOutput[];
  attached: AttachedFile[];
  previewing: RunOutput | null;
  setPreviewing: (o: RunOutput | null) => void;
  onUpload: (file: File) => Promise<void>;
}) {
  const empty = outputs.length === 0 && attached.length === 0;
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <aside className="w-72 shrink-0 border-l border-border bg-background flex flex-col overflow-hidden">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onUpload(file);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }}
      />

      <div className="px-4 py-3 border-b border-border">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Files</div>
        <div className="text-[11px] text-muted-foreground">
          {empty ? "None yet" : `${outputs.length + attached.length} in this chat`}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {attached.length > 0 && (
          <Section title="Attached">
            {attached.map((f) => (
              <FileRow
                key={f.mount_path ?? f.file_name}
                Icon={LuPaperclip}
                tint="violet"
                name={f.file_name}
                hint={f.mount_path ?? "in session"}
                onClick={f.kb_file_id
                  ? () => window.open(`/knowledge?file=${f.kb_file_id}`, "_blank", "noopener")
                  : undefined}
                rightIcon={f.kb_file_id ? LuExternalLink : undefined}
              />
            ))}
          </Section>
        )}
        {outputs.length > 0 && (
          <Section title="Produced">
            {outputs.map((o) => {
              const Icon = iconFor(o.name, o.mime);
              return (
                <FileRow
                  key={o.file_id}
                  Icon={Icon}
                  tint="amber"
                  name={o.name ?? o.file_id}
                  hint={`${o.mime ?? "—"}${o.size != null ? ` · ${humanizeBytes(o.size)}` : ""}`}
                  onClick={() => setPreviewing(o)}
                  onDownload={() => downloadOutput(sessionId, o)}
                />
              );
            })}
          </Section>
        )}
        {empty && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex flex-col items-center justify-center gap-3 py-10 text-center px-3 w-full rounded-xl hover:bg-muted/50 transition-colors group"
          >
            <div className="size-11 rounded-2xl border-2 border-dashed border-border group-hover:border-foreground/30 flex items-center justify-center text-muted-foreground/40 group-hover:text-foreground/50 transition-colors">
              <LuUpload className="size-4" />
            </div>
            <div>
              <div className="text-xs font-medium text-foreground/70">Drop anywhere or click to attach</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">uploads to knowledge base and attaches here</div>
            </div>
          </button>
        )}
        {!empty && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors rounded-lg hover:bg-muted/50"
          >
            <LuUpload className="size-3" /> Add file
          </button>
        )}
      </div>
      {previewing && (
        <Modal open onClose={() => setPreviewing(null)} title={previewing.name ?? previewing.file_id}>
          <div className="h-[70vh] -m-5">
            <OutputPreview sessionId={sessionId} output={previewing} />
          </div>
        </Modal>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400 px-2 mb-1">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function FileRow({
  Icon, tint, name, hint, onClick, onDownload, rightIcon: RightIcon,
}: {
  Icon: IconType;
  tint: "violet" | "amber";
  name: string;
  hint: string;
  onClick?: () => void;
  onDownload?: () => void;
  rightIcon?: IconType;
}) {
  const cls = tint === "violet"
    ? "bg-neutral-900 text-white"
    : "bg-neutral-900 text-white";
  return (
    <div className="group flex items-start gap-1 px-2 py-2 rounded-lg hover:bg-neutral-100">
      <button
        onClick={onClick}
        disabled={!onClick}
        className="text-left flex items-start gap-2 min-w-0 flex-1 disabled:cursor-default"
      >
        <div className={`size-7 rounded-lg ${cls} grid place-items-center mt-0.5 shrink-0`}>
          <Icon className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{name}</div>
          <div className="text-[11px] text-ink-500 font-mono truncate">{hint}</div>
        </div>
        {RightIcon && <RightIcon className="size-3.5 text-ink-400 mt-1 shrink-0" />}
      </button>
      {onDownload && (
        <button
          onClick={(e) => { e.stopPropagation(); onDownload(); }}
          title="Download"
          className="p-1.5 rounded text-ink-400 hover:text-ink-700 hover:bg-neutral-200 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <LuDownload className="size-3.5" />
        </button>
      )}
    </div>
  );
}

// Download a session output through our auth'd proxy. Uses an off-DOM anchor
// so the browser respects the `download` attribute.
async function downloadOutput(sessionId: string, output: RunOutput): Promise<void> {
  try {
    const { data: sessData } = await supabase.auth.getSession();
    const jwt = sessData.session?.access_token;
    const url = `${FN_URL}/sessions/${sessionId}/files/${output.file_id}?download=1`;
    const res = await fetch(url, {
      headers: {
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${jwt}`,
      },
    });
    if (!res.ok) throw new Error(`download ${res.status}`);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = output.name ?? output.file_id;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
  } catch (err) {
    alert(`Download failed: ${(err as Error).message}`);
  }
}

function NewChatComposer({ initialAgentId }: { initialAgentId?: string }) {
  const nav = useNavigate();
  const { data: agentsData } = useApi<{ data: Agent[] }>("/agents");
  const { data: envsData } = useApi<{ data: Environment[] }>("/environments");
  const [agentId, setAgentId] = useState("");
  const [message, setMessage] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [queuedFiles, setQueuedFiles] = useState<KbFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);
  const dragCounter = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const agents = agentsData?.data ?? [];
  const envId = envsData?.data?.[0]?.id ?? "";

  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  useEffect(() => {
    if (!agents.length || agentId) return;
    if (initialAgentId && agents.find(a => a.id === initialAgentId)) {
      setAgentId(initialAgentId);
      return;
    }
    const librarian = agents.find(a => a.name.toLowerCase().includes("librarian"));
    setAgentId(librarian?.id ?? agents[0].id);
  }, [agents, initialAgentId, agentId]);

  const selectedAgent = agents.find(a => a.id === agentId);
  const modelShort = (selectedAgent?.model ?? "").replace("claude-", "").replace(/-\d{8,}/, "");

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const kbFile = await uploadKbFile(file);
      setQueuedFiles(prev => [...prev, kbFile]);
      refresh("/kb/files");
    } catch (e) {
      alert(`Upload failed: ${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  }

  async function start() {
    if (!agentId || !envId || !message.trim() || busy) return;
    setBusy(true);
    try {
      const created = await api.post<Session>("/sessions", {
        agent_id: agentId,
        environment_id: envId,
        initial_message: message,
      });
      // Attach any queued files to the new session
      for (const f of queuedFiles) {
        try {
          await api.post(`/sessions/${created.id}/attachments/kb`, { kb_file_id: f.id });
        } catch { /* non-fatal */ }
      }
      refresh("/sessions");
      nav(`/chat/${created.id}`, { replace: true });
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div
      className="h-full flex relative"
      onDragEnter={(e) => { e.preventDefault(); dragCounter.current++; if (dragCounter.current === 1) setDropTarget(true); }}
      onDragLeave={(e) => { e.preventDefault(); dragCounter.current--; if (dragCounter.current === 0) setDropTarget(false); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDrop={(e) => { e.preventDefault(); dragCounter.current = 0; setDropTarget(false); const f = e.dataTransfer.files?.[0]; if (f) void uploadFile(f); }}
    >
      {dropTarget && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/80 border-2 border-dashed border-primary pointer-events-none">
          <LuUpload className="size-8 text-primary" />
          <span className="text-base font-medium text-primary">Drop to attach file</span>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void uploadFile(file);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }}
      />

      {/* Composer area */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
          <button
            type="button"
            onClick={() => setPickerOpen(o => !o)}
            className="flex flex-col items-center gap-3 focus:outline-none group cursor-pointer"
          >
            <div style={{ padding: pickerOpen ? "3px" : "0", background: pickerOpen ? "var(--primary)" : "transparent", borderRadius: "50%", transition: "all 0.15s" }}
              className="transition-transform group-hover:scale-105 group-active:scale-95"
            >
              <OrbAvatar seed={agentId || "new"} size={104} />
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1.5">
                <span className="font-semibold text-base leading-tight group-hover:underline underline-offset-2">
                  {selectedAgent?.name ?? "…"}
                </span>
                <LuChevronDown className={`size-3.5 text-muted-foreground transition-transform ${pickerOpen ? "rotate-180" : ""}`} />
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">{modelShort || "—"}</div>
            </div>
          </button>

          {pickerOpen && (
            <div className="w-full max-w-md bg-background border border-border rounded-2xl shadow-lg overflow-hidden mt-1">
              <div className="p-3 grid grid-cols-2 gap-2">
                {agents.map(a => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => { setAgentId(a.id); setPickerOpen(false); inputRef.current?.focus(); }}
                    className={[
                      "flex items-center gap-2.5 rounded-xl px-3 py-2.5 border text-left transition-all",
                      agentId === a.id
                        ? "border-foreground/30 bg-muted font-medium"
                        : "border-transparent hover:bg-muted/60",
                    ].join(" ")}
                  >
                    <OrbAvatar seed={a.id} size={30} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate leading-tight">{a.name}</div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {a.model.replace("claude-", "").replace(/-\d{8,}/, "")}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Message bar */}
        <div className="border-t border-border px-4 py-3 bg-background">
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              placeholder={selectedAgent ? `Message ${selectedAgent.name}…` : "Message your agent…"}
              value={message}
              onChange={e => setMessage(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); start(); } }}
              disabled={busy}
              className="flex-1"
              autoFocus
            />
            <Button onClick={start} disabled={!message.trim() || !agentId || !envId || busy} size="sm">
              <LuSend className="size-3.5" />{busy ? "Starting…" : "Send"}
            </Button>
          </div>
          {err && <div className="text-rose-600 text-xs mt-1">{err}</div>}
        </div>
      </div>

      {/* Files panel */}
      <aside className="w-72 shrink-0 border-l border-border bg-background flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Files</div>
          <div className="text-[11px] text-muted-foreground">
            {uploading ? "Uploading…" : queuedFiles.length === 0 ? "None yet" : `${queuedFiles.length} queued`}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {queuedFiles.map(f => (
            <div key={f.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/40">
              <LuFile className="size-3.5 text-violet-500 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium truncate">{f.name}</div>
                <div className="text-[10px] text-muted-foreground truncate">{f.mime} · will attach on send</div>
              </div>
              <button
                type="button"
                onClick={() => setQueuedFiles(prev => prev.filter(q => q.id !== f.id))}
                className="text-muted-foreground hover:text-foreground transition-colors text-xs px-1"
              >✕</button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex flex-col items-center justify-center gap-3 py-10 text-center px-3 w-full rounded-xl hover:bg-muted/50 transition-colors group"
          >
            <div className="size-11 rounded-2xl border-2 border-dashed border-border group-hover:border-foreground/30 flex items-center justify-center text-muted-foreground/40 group-hover:text-foreground/50 transition-colors">
              <LuUpload className="size-4" />
            </div>
            <div>
              <div className="text-xs font-medium text-foreground/70">Drop anywhere or click to attach</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">attached when you send your first message</div>
            </div>
          </button>
        </div>
      </aside>
    </div>
  );
}



function AttachKbModal({
  open,
  onClose,
  onAttach,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onAttach: (file: KbFile) => Promise<void>;
  busy: boolean;
}) {
  const { data } = useApi<{ data: KbFile[] }>(open ? "/kb/files" : null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const files = data?.data ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((file) =>
      file.name.toLowerCase().includes(q)
      || (file.snippet ?? "").toLowerCase().includes(q)
      || (file.mime ?? "").toLowerCase().includes(q),
    );
  }, [files, query]);

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Attach from knowledge base"
    >
      <div className="space-y-3">
        <div className="relative">
          <LuSearch className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search files by name or snippet…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto space-y-1 pr-1">
          {filtered.length === 0 ? (
            <div className="text-sm text-ink-500 px-1 py-6 text-center">
              {files.length === 0 ? "No knowledge-base files yet." : "No files match that search."}
            </div>
          ) : filtered.map((file) => (
            <button
              key={file.id}
              className="w-full text-left rounded-xl border border-neutral-200 px-3 py-3 hover:border-violet-300 hover:bg-violet-50/40 transition-colors disabled:opacity-60"
              onClick={() => onAttach(file)}
              disabled={busy}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{file.name}</div>
                  <div className="text-[11px] text-ink-500 font-mono truncate">
                    {file.mime} · {humanizeBytes(file.size_bytes)}
                  </div>
                </div>
                <span className="text-[11px] font-medium text-violet-700 shrink-0">
                  {busy ? "Attaching…" : "Attach"}
                </span>
              </div>
              {file.snippet && (
                <div className="mt-1.5 text-xs text-ink-500 line-clamp-2">
                  {file.snippet}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
