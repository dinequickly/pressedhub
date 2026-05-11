// /runs — Sessions list (left) + run detail with live SSE event stream
// (right). The "Start session" button on the page opens a modal that picks
// the agent + environment and posts the user.message kickoff.

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  LuPlus, LuActivity, LuBan, LuRotateCcw, LuFile, LuFileText,
  LuFileSpreadsheet, LuImage, LuFileCode, LuPresentation,
} from "react-icons/lu";
import { api, type Agent, type Environment, type RunOutput, type Session, type SessionEvent } from "../lib/api";
import { refresh, useApi } from "../lib/swr";
import { EmptyState, Modal, Page, StatusPill } from "../components/Page";
import { OutputPreview } from "../components/OutputPreview";
import { ChatStream, LiveActivity } from "../components/ChatEvents";
import { humanizeBytes } from "../lib/format";
import { FN_URL, supabase } from "../lib/supabase";

export function RunsPage() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const nav = useNavigate();
  const { data: sessions } = useApi<{ data: Session[] }>("/sessions", {
    refreshInterval: 5000,
  });
  const [creating, setCreating] = useState(false);

  const list = sessions?.data ?? [];
  const selectedId = sessionId ?? list[0]?.id ?? null;

  return (
    <Page
      title="Runs"
      subtitle="Live work in progress, with outputs and activity in one place."
      actions={
        <button className="btn-primary" onClick={() => setCreating(true)}>
          <LuPlus className="size-4" /> Start session
        </button>
      }
    >
      <div className="h-full grid grid-cols-[320px_1fr]">
        <div className="border-r border-neutral-200 overflow-y-auto p-2">
          {!list.length ? (
            <EmptyState title="No runs yet" />
          ) : list.map((s) => (
            <button
              key={s.id}
              onClick={() => nav(`/runs/${s.id}`)}
              className={[
                "w-full text-left px-3 py-2 rounded-lg flex items-start gap-2 transition-colors",
                selectedId === s.id ? "bg-amber-50" : "hover:bg-neutral-100",
              ].join(" ")}
            >
              <div className="size-7 rounded-lg bg-amber-50 text-amber-500 grid place-items-center mt-0.5">
                <LuActivity className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="text-sm font-medium truncate">{s.title ?? "Untitled"}</div>
                  <StatusPill status={s.status} />
                </div>
                <div className="text-[11px] text-ink-500 truncate">
                  {new Date(s.started_at).toLocaleString()}
                </div>
              </div>
            </button>
          ))}
        </div>
        <div className="overflow-y-auto">
          {selectedId ? (
            <RunDetail sessionId={selectedId} />
          ) : (
            <EmptyState title="Pick a run" />
          )}
        </div>
      </div>

      <StartSessionModal open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

function RunDetail({ sessionId }: { sessionId: string }) {
  const { data, mutate } = useApi<{ session: Session; events: SessionEvent[]; outputs?: RunOutput[] }>(
    `/runs/${sessionId}`,
    { refreshInterval: 4000 },
  );
  const [message, setMessage] = useState("");
  const [streaming, setStreaming] = useState(false);
  const eventsRef = useRef<HTMLDivElement>(null);
  const [selectedOutput, setSelectedOutput] = useState<string | null>(null);

  const outputs = data?.outputs ?? [];
  // Auto-select the most recently produced output when a new one shows up.
  useEffect(() => {
    if (!selectedOutput && outputs.length > 0) {
      setSelectedOutput(outputs[outputs.length - 1].file_id);
    }
  }, [outputs.length, selectedOutput]);
  const activeOutput = outputs.find((o) => o.file_id === selectedOutput) ?? null;

  useEffect(() => {
    if (eventsRef.current) {
      eventsRef.current.scrollTop = eventsRef.current.scrollHeight;
    }
  }, [data?.events?.length]);

  if (!data) return <div className="p-6 text-ink-500">Loading…</div>;
  const { session, events } = data;

  async function send() {
    if (!message.trim()) return;
    await api.post(`/sessions/${sessionId}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: message }] }],
    });
    setMessage("");
    mutate();
  }

  async function attachStream() {
    setStreaming(true);
    try {
      const { data: sessData } = await supabase.auth.getSession();
      const jwt = sessData.session?.access_token;
      const res = await fetch(`${FN_URL}/sessions/${sessionId}/stream`, {
        headers: {
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${jwt}`,
          Accept: "text/event-stream",
        },
      });
      if (!res.body) return;
      const reader = res.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
        // We don't render the raw stream; the persistence side-effect inside
        // the edge function writes to session_events, and the polling
        // refreshInterval picks it up.
        await mutate();
      }
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="h-full grid grid-cols-[1fr_320px]">
      <div className="p-6 space-y-4 overflow-y-auto">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-semibold">{session.title ?? "Untitled"}</h2>
        <StatusPill status={session.status} />
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs text-ink-500">
        <div>started {new Date(session.started_at).toLocaleString()}</div>
        <div>{session.finished_at ? `finished ${new Date(session.finished_at).toLocaleString()}` : "in progress"}</div>
        <div>{events.length} updates recorded</div>
        <div>{outputs.length} file{outputs.length === 1 ? "" : "s"} produced</div>
      </div>

      <div className="flex items-center gap-2">
        <button className="btn-ghost" onClick={attachStream} disabled={streaming || session.status === "terminated"}>
          <LuRotateCcw className="size-3.5" /> {streaming ? "Refreshing…" : "Refresh live"}
        </button>
        <button
          className="btn-danger"
          onClick={async () => {
            if (!confirm("Interrupt this session?")) return;
            await api.post(`/sessions/${sessionId}/interrupt`);
            mutate();
          }}
        >
          <LuBan className="size-3.5" /> Interrupt
        </button>
      </div>

      <div ref={eventsRef} className="space-y-3 max-h-[55vh] overflow-y-auto rounded-[28px] border border-neutral-200/80 bg-neutral-100/80 p-4">
        {events.length === 0 ? (
          <div className="text-sm text-ink-500">No events yet.</div>
        ) : (
          <ChatStream events={events} />
        )}
        {session.status === "running" && <LiveActivity events={events} />}
      </div>

      <div className="flex gap-2 sticky bottom-0 bg-white pt-3 border-t border-neutral-200">
        <input
          className="input"
          placeholder="Send a follow-up…"
          value={message} onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
        />
        <button className="btn-primary" onClick={send} disabled={!message.trim()}>
          Send
        </button>
      </div>
      </div>
      <OutputsPanel
        sessionId={sessionId}
        outputs={outputs}
        selectedId={selectedOutput}
        onSelect={setSelectedOutput}
        activeOutput={activeOutput}
      />
    </div>
  );
}

function OutputsPanel({
  sessionId, outputs, selectedId, onSelect, activeOutput,
}: {
  sessionId: string;
  outputs: RunOutput[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  activeOutput: RunOutput | null;
}) {
  const [previewing, setPreviewing] = useState<RunOutput | null>(null);
  return (
    <aside className="border-l border-neutral-200 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-neutral-200">
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
          Outputs
        </div>
        <div className="text-[11px] text-ink-500">
          {outputs.length === 0 ? "Nothing produced yet" : `${outputs.length} file${outputs.length === 1 ? "" : "s"}`}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {outputs.map((o) => {
          const Icon = iconFor(o);
          const isActive = selectedId === o.file_id;
          return (
            <button
              key={o.file_id}
              onClick={() => { onSelect(o.file_id); setPreviewing(o); }}
              className={[
                "w-full text-left px-3 py-2 rounded-lg flex items-start gap-2 transition-colors",
                isActive ? "bg-amber-50" : "hover:bg-neutral-100",
              ].join(" ")}
            >
              <div className="size-7 rounded-lg bg-violet-50 text-violet-500 grid place-items-center mt-0.5">
                <Icon className="size-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{o.name ?? o.file_id}</div>
                <div className="text-[11px] text-ink-500 font-mono truncate">
                  {(o.mime ?? "—")}{o.size != null ? ` · ${humanizeBytes(o.size)}` : ""}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {previewing && activeOutput && (
        <Modal
          open={!!previewing}
          onClose={() => setPreviewing(null)}
          title={activeOutput.name ?? activeOutput.file_id}
        >
          <div className="h-[70vh] -m-5">
            <OutputPreview sessionId={sessionId} output={activeOutput} />
          </div>
        </Modal>
      )}
    </aside>
  );
}

function iconFor(o: RunOutput) {
  const lower = (o.name ?? "").toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const m = (o.mime ?? "").toLowerCase();
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "svg", "webp", "gif"].includes(ext)) return LuImage;
  if (ext === "xlsx" || ext === "csv" || m.includes("spreadsheetml")) return LuFileSpreadsheet;
  if (ext === "pptx" || m.includes("presentationml")) return LuPresentation;
  if (ext === "json" || m === "application/json") return LuFileCode;
  if (ext === "md" || ext === "txt" || ext === "docx" || ext === "pdf") return LuFileText;
  return LuFile;
}

// Event-row rendering moved to components/ChatEvents.tsx so /chat and /runs share it.
function StartSessionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: agents } = useApi<{ data: Agent[] }>(open ? "/agents" : null);
  const { data: envs } = useApi<{ data: Environment[] }>(open ? "/environments" : null);
  const [agentId, setAgentId] = useState("");
  const [envId, setEnvId] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <Modal
      open={open} onClose={onClose} title="Start session"
      footer={
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary" disabled={!agentId || !envId || busy}
            onClick={async () => {
              setBusy(true); setErr(null);
              try {
                const created = await api.post<Session>("/sessions", {
                  agent_id: agentId, environment_id: envId, title,
                  initial_message: message || undefined,
                });
                refresh("/sessions");
                onClose();
                setTitle(""); setMessage("");
                window.location.assign(`/runs/${created.id}`);
              } catch (e) { setErr((e as Error).message); }
              finally { setBusy(false); }
            }}
          >
            Start
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label block mb-1">Agent</label>
          <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Pick an agent…</option>
            {(agents?.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label block mb-1">Environment</label>
          <select className="input" value={envId} onChange={(e) => setEnvId(e.target.value)}>
            <option value="">Pick an environment…</option>
            {(envs?.data ?? []).map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label block mb-1">Title (optional)</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <label className="label block mb-1">Initial user.message</label>
          <textarea className="input font-mono text-xs" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />
        </div>
        {err && <div className="text-rose-600 text-sm">{err}</div>}
      </div>
    </Modal>
  );
}
