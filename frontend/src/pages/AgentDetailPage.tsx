// /agents/:id — Two-pane agent detail. Chat on the left (auto-creates a
// session against the first available environment on the first message),
// config on the right (system prompt, goal/rubric, model, skills, MCP
// servers). Mirrors Anthropic Managed Agents: the goal is sent as a
// `user.define_outcome` event when the chat session is created.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  LuArrowLeft, LuTrash, LuSend, LuRefreshCw, LuEye, LuPencil,
  LuSparkles, LuTarget, LuBot, LuDatabase, LuFileText,
  LuPaperclip, LuClock, LuPlus, LuPause, LuPlay, LuX,
} from "react-icons/lu";
import {
  api, type Agent, type AgentSchedule, type Environment, type KbFile,
  type MemoryStore, type Session, type SessionEvent, type Skill,
} from "../lib/api";
import { refresh, useApi } from "../lib/swr";
import { Page, StatusPill } from "../components/Page";
import { humanCron } from "../lib/cron";
import { ChatStream, LiveActivity } from "../components/ChatEvents";

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { data: agent, mutate: mutateAgent } = useApi<Agent>(id ? `/agents/${id}` : null);

  if (!agent) {
    return (
      <Page title="Agent" subtitle="Loading…">
        <div className="p-6 text-ink-500">Loading agent…</div>
      </Page>
    );
  }

  return (
    <Page
      title={
        <span className="flex items-center gap-3">
          <button
            className="btn-ghost size-8 p-0 grid place-items-center"
            onClick={() => nav("/agents")}
            title="Back to agents"
          >
            <LuArrowLeft className="size-4" />
          </button>
          <span className="size-9 rounded-xl bg-violet-50 grid place-items-center text-lg">
            {agent.emoji || "🤖"}
          </span>
          <span className="text-xl font-semibold tracking-tight">{agent.name}</span>
        </span>
      }
      subtitle={agent.role || "—"}
      actions={
        <button
          className="btn-danger"
          onClick={async () => {
            if (!confirm(`Archive ${agent.name}?`)) return;
            await api.del(`/agents/${agent.id}`);
            refresh("/agents");
            nav("/agents");
          }}
        >
          <LuTrash className="size-4" /> Archive
        </button>
      }
    >
      <div className="h-full grid grid-cols-1 xl:grid-cols-[1fr_440px]">
        <ChatPanel agent={agent} />
        <ConfigPanel agent={agent} onSaved={() => mutateAgent()} />
      </div>
    </Page>
  );
}

// -- Chat -----------------------------------------------------------------

function ChatPanel({ agent }: { agent: Agent }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Resources for the next session. Pre-filled with the agent's saved
  // defaults; user can tweak via the paperclip menu before sending.
  // Locked once a session is created so we don't lie about what's mounted.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [kbFileIds, setKbFileIds] = useState<Set<string>>(
    () => new Set(agent.default_resources?.kb_file_ids ?? []),
  );
  const [memStoreIds, setMemStoreIds] = useState<Set<string>>(
    () => new Set(agent.default_resources?.memory_store_ids ?? []),
  );
  const { data: kbFiles } = useApi<{ data: KbFile[] }>(pickerOpen ? "/kb/files" : null);
  const { data: memStores } = useApi<{ data: MemoryStore[] }>(pickerOpen ? "/memory/stores" : null);

  const { data: run, mutate } = useApi<{ session: Session; events: SessionEvent[] }>(
    sessionId ? `/runs/${sessionId}` : null,
    { refreshInterval: sessionId ? 3000 : 0 },
  );

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [run?.events?.length]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true); setErr(null);
    try {
      let sid = sessionId;
      if (!sid) {
        // Always fetch live: a stale SWR cache could point at an environment
        // that was deleted out from under us, which would 400 on session
        // create. Pick the most-recently-updated one (the list endpoint is
        // already ordered desc by updated_at).
        const fresh = await api.get<{ data: Environment[] }>("/environments");
        let env = fresh.data?.[0];
        if (!env) {
          env = await api.post<Environment>("/environments", {
            name: "Default",
            config: { type: "cloud", networking: { type: "unrestricted" } },
          });
        }
        refresh("/environments");
        const created = await api.post<Session>("/sessions", {
          agent_id: agent.id,
          environment_id: env.id,
          title: `Chat with ${agent.name}`,
          initial_message: text,
          outcome: agent.outcome ?? undefined,
          kb_file_ids: [...kbFileIds],
          memory_store_ids: [...memStoreIds],
        });
        sid = created.id;
        setSessionId(sid);
      } else {
        await api.post(`/sessions/${sid}/events`, {
          events: [{ type: "user.message", content: [{ type: "text", text }] }],
        });
      }
      setInput("");
      mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const events = run?.events ?? [];

  return (
    <div className="flex flex-col h-full min-h-0 border-r border-neutral-200">
      <div className="px-6 py-3 border-b border-neutral-200 flex items-center gap-2 bg-neutral-50">
        <LuBot className="size-4 text-violet-500" />
        <div className="text-sm font-medium">Chat</div>
        {run?.session && <StatusPill status={run.session.status} />}
        <div className="relative ml-auto">
          <button
            className={[
              "btn-ghost text-xs",
              kbFileIds.size + memStoreIds.size > 0 ? "text-violet-700" : "",
              sessionId ? "opacity-50 cursor-not-allowed" : "",
            ].join(" ")}
            onClick={() => !sessionId && setPickerOpen((v) => !v)}
            disabled={!!sessionId}
            title={
              sessionId
                ? "Resources are locked once the session has started — start a new chat to change them."
                : "Attach KB files / memory stores"
            }
          >
            <LuPaperclip className="size-3.5" />
            {kbFileIds.size + memStoreIds.size > 0
              ? `${kbFileIds.size + memStoreIds.size} attached`
              : "Attach"}
          </button>
          {pickerOpen && (
            <ResourcePicker
              kbFiles={kbFiles?.data ?? []}
              memStores={memStores?.data ?? []}
              kbSelected={kbFileIds}
              memSelected={memStoreIds}
              onChangeKb={setKbFileIds}
              onChangeMem={setMemStoreIds}
              onSaveAsDefault={async () => {
                await api.patch(`/agents/${agent.id}`, {
                  default_resources: {
                    kb_file_ids: [...kbFileIds],
                    memory_store_ids: [...memStoreIds],
                  },
                });
                refresh(`/agents/${agent.id}`);
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>
        {sessionId && (
          <button
            className="btn-ghost text-xs"
            onClick={() => mutate()}
            title="Refresh"
          >
            <LuRefreshCw className="size-3.5" />
          </button>
        )}
        {sessionId && (
          <button
            className="btn-ghost text-xs"
            onClick={() => { setSessionId(null); setInput(""); }}
            title="Start a new conversation"
          >
            New chat
          </button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-3">
        {!sessionId && (
          <div className="text-sm text-ink-500">
            Send a message to start chatting with {agent.name}. The first
            message creates a session against your first environment.
          </div>
        )}
        {events.length > 0 && <ChatStream events={events} />}
        {run?.session.status === "running" && <LiveActivity events={events} />}
      </div>

      {err && <div className="px-6 pb-2 text-rose-600 text-sm">{err}</div>}

      <div className="border-t border-neutral-200 p-3 flex gap-2">
        <textarea
          className="input flex-1 resize-none"
          rows={2}
          placeholder={`Message ${agent.name}…`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          className="btn-primary self-stretch"
          disabled={!input.trim() || busy}
          onClick={send}
        >
          <LuSend className="size-4" /> Send
        </button>
      </div>
    </div>
  );
}

function ResourcePicker({
  kbFiles, memStores, kbSelected, memSelected,
  onChangeKb, onChangeMem, onSaveAsDefault, onClose,
}: {
  kbFiles: KbFile[];
  memStores: MemoryStore[];
  kbSelected: Set<string>;
  memSelected: Set<string>;
  onChangeKb: (s: Set<string>) => void;
  onChangeMem: (s: Set<string>) => void;
  onSaveAsDefault: () => Promise<void>;
  onClose: () => void;
}) {
  const [savingDefault, setSavingDefault] = useState(false);
  const toggleKb = (id: string) => {
    const next = new Set(kbSelected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChangeKb(next);
  };
  const toggleMem = (id: string) => {
    const next = new Set(memSelected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChangeMem(next);
  };
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div
        className="absolute right-0 mt-1 w-[380px] bg-white rounded-xl shadow-card border border-neutral-200 z-20"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-neutral-100">
          <div className="flex items-center gap-2">
            <LuFileText className="size-4 text-violet-500" />
            <div className="text-sm font-medium">Knowledge bank</div>
            <span className="pill ml-auto">{kbSelected.size}</span>
          </div>
          <div className="mt-2 max-h-48 overflow-y-auto">
            {kbFiles.length === 0 ? (
              <div className="text-xs text-ink-500 px-1 py-2">No KB files yet.</div>
            ) : kbFiles.map((f) => (
              <label key={f.id} className="flex items-start gap-2 p-1.5 rounded hover:bg-neutral-50 cursor-pointer">
                <input type="checkbox" className="mt-0.5"
                  checked={kbSelected.has(f.id)}
                  onChange={() => toggleKb(f.id)}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{f.name}</div>
                  <div className="text-[10px] text-ink-500 truncate">
                    {f.anthropic_file_id ? "Ready to attach" : "Will finish preparing on send"}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>
        <div className="p-3 border-b border-neutral-100">
          <div className="flex items-center gap-2">
            <LuDatabase className="size-4 text-violet-500" />
            <div className="text-sm font-medium">Memory stores</div>
            <span className="pill ml-auto">{memSelected.size}</span>
          </div>
          <div className="mt-2 max-h-48 overflow-y-auto">
            {memStores.length === 0 ? (
              <div className="text-xs text-ink-500 px-1 py-2">No memory stores yet.</div>
            ) : memStores.map((s) => (
              <label key={s.id} className="flex items-start gap-2 p-1.5 rounded hover:bg-neutral-50 cursor-pointer">
                <input type="checkbox" className="mt-0.5"
                  checked={memSelected.has(s.id)}
                  onChange={() => toggleMem(s.id)}
                  disabled={!s.anthropic_id}
                  title={s.anthropic_id ? undefined : "This memory store still needs a sync from the Memory page."}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{s.name}</div>
                  <div className="text-[10px] text-ink-500 truncate">
                    {s.anthropic_id ? "Ready to use" : "Needs sync before use"}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>
        <div className="p-3 flex gap-2">
          <button
            className="btn-ghost text-xs"
            disabled={savingDefault}
            onClick={async () => {
              setSavingDefault(true);
              try { await onSaveAsDefault(); }
              finally { setSavingDefault(false); }
            }}
            title="Pre-select these for every future chat with this agent"
          >
            {savingDefault ? "Saving…" : "Save as agent default"}
          </button>
          <button className="btn-primary text-xs ml-auto" onClick={onClose}>Done</button>
        </div>
      </div>
    </>
  );
}

// -- Config ---------------------------------------------------------------

function ConfigPanel({ agent, onSaved }: { agent: Agent; onSaved: () => void }) {
  const { data: skills } = useApi<{ data: Skill[] }>("/skills");

  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [emoji, setEmoji] = useState(agent.emoji);
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt);
  const [goalDesc, setGoalDesc] = useState(agent.outcome?.description ?? "");
  const [rubricMd, setRubricMd] = useState(agent.outcome?.rubric_md ?? "");
  const [maxIters, setMaxIters] = useState(agent.outcome?.max_iterations ?? 5);
  const [previewRubric, setPreviewRubric] = useState(false);

  const initialSkillIds = useMemo(
    () => extractSkillIds(agent.skills as unknown[]),
    [agent.skills],
  );
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(
    new Set(initialSkillIds),
  );
  const [pinnedKbNames, setPinnedKbNames] = useState<string[]>(
    () => agent.default_resources?.pinned_kb_names ?? [],
  );
  const [pinnedInput, setPinnedInput] = useState("");

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const dirty =
    name !== agent.name ||
    role !== agent.role ||
    emoji !== agent.emoji ||
    systemPrompt !== agent.system_prompt ||
    goalDesc !== (agent.outcome?.description ?? "") ||
    rubricMd !== (agent.outcome?.rubric_md ?? "") ||
    maxIters !== (agent.outcome?.max_iterations ?? 5) ||
    !setEq(selectedSkillIds, new Set(initialSkillIds)) ||
    JSON.stringify(pinnedKbNames) !== JSON.stringify(agent.default_resources?.pinned_kb_names ?? []);

  async function save() {
    setSaving(true); setErr(null);
    try {
      const skillsPayload = (skills?.data ?? [])
        .filter((s) => selectedSkillIds.has(s.id) && s.anthropic_skill_id)
        .map((s) => ({
          // local_id round-trips the picker selection; the backend strips it
          // before forwarding to Anthropic (which only accepts type/skill_id/version).
          local_id: s.id,
          type: s.type,
          skill_id: s.anthropic_skill_id as string,
          ...(s.type === "custom" ? { version: "latest" } : {}),
        }));
      const outcome = goalDesc || rubricMd
        ? { description: goalDesc, rubric_md: rubricMd, max_iterations: maxIters }
        : null;
      await api.patch<Agent>(`/agents/${agent.id}`, {
        name, role, emoji, model: agent.model,
        system_prompt: systemPrompt,
        skills: skillsPayload,
        mcp_servers: agent.mcp_servers,
        outcome,
        default_resources: {
          kb_file_ids: agent.default_resources?.kb_file_ids ?? [],
          memory_store_ids: agent.default_resources?.memory_store_ids ?? [],
          pinned_kb_names: pinnedKbNames,
        },
      });
      refresh(`/agents/${agent.id}`);
      refresh("/agents");
      setSavedAt(Date.now());
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overflow-y-auto bg-neutral-50">
      <div className="p-5 space-y-5">
        <Section icon={<LuBot className="size-4" />} title="Identity">
          <div className="grid grid-cols-[64px_1fr] gap-2">
            <div>
              <label className="label block mb-1">Emoji</label>
              <input className="input text-center text-lg" maxLength={2} value={emoji} onChange={(e) => setEmoji(e.target.value)} />
            </div>
            <div>
              <label className="label block mb-1">Name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          <div className="mt-2">
            <label className="label block mb-1">Role</label>
            <input className="input" value={role} onChange={(e) => setRole(e.target.value)} />
          </div>
        </Section>

        <Section icon={<LuTarget className="size-4" />} title="Goal">
          <div className="text-[11px] text-ink-500 mb-2">
            The grader iterates until the rubric is satisfied.
          </div>
          <label className="label block mb-1">Description</label>
          <textarea
            className="input"
            rows={2}
            placeholder="1-page PDF brief covering funding, team, product, and news."
            value={goalDesc}
            onChange={(e) => setGoalDesc(e.target.value)}
          />
          <div className="flex items-center justify-between mt-3 mb-1">
            <label className="label">Rubric (markdown)</label>
            <button
              className="btn-ghost text-[11px]"
              onClick={() => setPreviewRubric((v) => !v)}
            >
              {previewRubric
                ? <><LuPencil className="size-3" /> Edit</>
                : <><LuEye className="size-3" /> Rubric preview</>}
            </button>
          </div>
          {previewRubric ? (
            <div className="card p-3 text-sm">
              <Markdown src={rubricMd || "*(empty)*"} />
            </div>
          ) : (
            <textarea
              className="input font-mono text-xs"
              rows={8}
              placeholder={`# Research brief\n## Coverage\n- Funding round + amount + date\n- Approximate headcount\n- Top 3 products\n- 3 recent news items (last 90 days)\n## Format\n- Single PDF, 1 page`}
              value={rubricMd}
              onChange={(e) => setRubricMd(e.target.value)}
            />
          )}
          <div className="mt-3">
            <label className="label block mb-1">Max iterations</label>
            <input
              type="number"
              min={1}
              max={20}
              className="input w-24"
              value={maxIters}
              onChange={(e) => setMaxIters(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            />
          </div>
        </Section>

        <Section icon={<LuBot className="size-4" />} title="Instructions">
          <textarea
            className="input font-mono text-xs"
            rows={6}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </Section>

        <Section icon={<LuSparkles className="size-4" />} title="Skills">
          {(skills?.data ?? []).length === 0 ? (
            <div className="text-xs text-ink-500">
              No skills yet. Create one on the Skills page.
            </div>
          ) : (
            <div className="space-y-1">
              {(skills?.data ?? []).map((s) => (
                <label key={s.id} className="flex items-start gap-2 p-2 rounded-lg hover:bg-white cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selectedSkillIds.has(s.id)}
                    onChange={(e) => {
                      const next = new Set(selectedSkillIds);
                      if (e.target.checked) next.add(s.id);
                      else next.delete(s.id);
                      setSelectedSkillIds(next);
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-medium truncate">{s.name}</div>
                      <SkillTypeBadge type={s.type} />
                    </div>
                    {s.description && (
                      <div className="text-[11px] text-ink-500 truncate">{s.description}</div>
                    )}
                  </div>
                </label>
              ))}
            </div>
          )}
        </Section>

        <Section icon={<LuFileText className="size-4" />} title="Pinned KB files">
          <div className="text-[11px] text-ink-500 mb-2">
            Filenames (or substrings) automatically attached on every session start.
            Useful for templates or reference docs the agent always needs.
          </div>
          <div className="space-y-1 mb-2">
            {pinnedKbNames.length === 0 ? (
              <div className="text-xs text-ink-400 italic">No pinned files.</div>
            ) : pinnedKbNames.map((name, i) => (
              <div key={i} className="flex items-center gap-2 px-2 py-1 rounded-lg border border-neutral-200 bg-white">
                <div className="flex-1 text-xs font-mono truncate">{name}</div>
                <button
                  className="text-ink-400 hover:text-rose-500 transition-colors"
                  onClick={() => setPinnedKbNames((prev) => prev.filter((_, j) => j !== i))}
                >
                  <LuX className="size-3" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              className="input flex-1 text-sm font-mono"
              placeholder="FY26 Template (name or substring)"
              value={pinnedInput}
              onChange={(e) => setPinnedInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pinnedInput.trim()) {
                  setPinnedKbNames((prev) => [...prev, pinnedInput.trim()]);
                  setPinnedInput("");
                }
              }}
            />
            <button
              className="btn-ghost"
              disabled={!pinnedInput.trim()}
              onClick={() => {
                if (pinnedInput.trim()) {
                  setPinnedKbNames((prev) => [...prev, pinnedInput.trim()]);
                  setPinnedInput("");
                }
              }}
            >
              <LuPlus className="size-4" /> Add
            </button>
          </div>
        </Section>

        <SchedulesSection agentId={agent.id} />

        {err && <div className="text-rose-600 text-sm">{err}</div>}

        <div className="sticky bottom-0 -mx-5 -mb-5 px-5 py-3 bg-white border-t border-neutral-200 flex items-center gap-2">
          <div className="text-[11px] text-ink-500">
            {dirty
              ? "Unsaved changes"
              : savedAt
                ? `Saved ${new Date(savedAt).toLocaleTimeString()}`
                : "Up to date"}
          </div>
          <button
            className="btn-primary ml-auto"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  icon, title, children,
}: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="card p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="size-7 rounded-lg bg-violet-50 text-violet-500 grid place-items-center">
          {icon}
        </div>
        <div className="font-medium text-sm">{title}</div>
      </div>
      {children}
    </section>
  );
}

function SkillTypeBadge({ type }: { type: Skill["type"] }) {
  const label = type === "anthropic" ? "Managed" : "Custom";
  const cls = type === "anthropic"
    ? "bg-neutral-100 text-ink-600"
    : "bg-violet-50 text-violet-700";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium uppercase tracking-wide ${cls}`}>
      {label}
    </span>
  );
}

// -- Helpers --------------------------------------------------------------

function setEq<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// Pull the local skill id from whatever shape we previously persisted.
// Current shape: { local_id, type, skill_id, version? }. Older shapes used
// {id} (local) or {anthropic_skill_id}; we still match those for back-compat.
function extractSkillIds(stored: unknown[]): string[] {
  return (stored ?? [])
    .map((x) => {
      if (typeof x !== "object" || x === null) return null;
      const o = x as Record<string, unknown>;
      return (o.local_id as string) ?? (o.id as string) ?? null;
    })
    .filter(Boolean) as string[];
}

// -- Tiny markdown renderer (h1/h2/h3, ul, code, paragraphs). Good enough
// for showing a rubric preview without pulling in a dep. ---
function Markdown({ src }: { src: string }) {
  const lines = src.split("\n");
  const blocks: React.ReactNode[] = [];
  let listBuf: string[] = [];
  const flushList = () => {
    if (listBuf.length) {
      blocks.push(
        <ul key={`ul-${blocks.length}`} className="list-disc pl-5 space-y-0.5 text-sm">
          {listBuf.map((l, i) => <li key={i}>{inline(l)}</li>)}
        </ul>,
      );
      listBuf = [];
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^- /.test(line)) {
      listBuf.push(line.slice(2));
      continue;
    }
    flushList();
    if (/^### /.test(line)) {
      blocks.push(<h3 key={blocks.length} className="font-medium text-sm mt-2">{inline(line.slice(4))}</h3>);
    } else if (/^## /.test(line)) {
      blocks.push(<h2 key={blocks.length} className="font-semibold text-sm mt-2">{inline(line.slice(3))}</h2>);
    } else if (/^# /.test(line)) {
      blocks.push(<h1 key={blocks.length} className="font-semibold text-base mt-2">{inline(line.slice(2))}</h1>);
    } else if (line.trim() === "") {
      blocks.push(<div key={blocks.length} className="h-2" />);
    } else {
      blocks.push(<p key={blocks.length} className="text-sm">{inline(line)}</p>);
    }
  }
  flushList();
  return <div className="space-y-1">{blocks}</div>;
}

function inline(s: string): React.ReactNode {
  // Just handle backtick inline code and bold/italic minimally.
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < s.length) {
    const codeStart = s.indexOf("`", i);
    if (codeStart === -1) { parts.push(s.slice(i)); break; }
    if (codeStart > i) parts.push(s.slice(i, codeStart));
    const codeEnd = s.indexOf("`", codeStart + 1);
    if (codeEnd === -1) { parts.push(s.slice(codeStart)); break; }
    parts.push(
      <code key={key++} className="px-1 py-0.5 rounded bg-neutral-100 font-mono text-[11px]">
        {s.slice(codeStart + 1, codeEnd)}
      </code>,
    );
    i = codeEnd + 1;
  }
  return parts;
}

// -- Schedules ------------------------------------------------------------

const FREQUENCY_PRESETS: Array<{
  value: "hourly" | "daily" | "weekdays" | "weekly" | "custom";
  label: string;
}> = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays (Mon–Fri)" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom cron" },
];

function SchedulesSection({ agentId }: { agentId: string }) {
  const { data, mutate } = useApi<{ data: AgentSchedule[] }>(
    `/schedules?agent_id=${agentId}`,
  );
  const [creating, setCreating] = useState(false);
  const list = data?.data ?? [];

  return (
    <Section icon={<LuClock className="size-4" />} title="Schedules">
      <div className="text-[11px] text-ink-500 mb-3">
        Wakes the agent on a recurring cron tick. Each tick starts a new session
        with the trigger message (if set).
      </div>
      {list.length === 0 ? (
        <div className="text-xs text-ink-500 italic mb-3">No schedules yet.</div>
      ) : (
        <div className="space-y-2 mb-3">
          {list.map((s) => (
            <ScheduleRow key={s.id} schedule={s} onChanged={() => mutate()} />
          ))}
        </div>
      )}
      <button className="btn-ghost" onClick={() => setCreating(true)}>
        <LuPlus className="size-4" /> Add schedule
      </button>
      {creating && (
        <ScheduleEditor
          agentId={agentId}
          initial={null}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); mutate(); }}
        />
      )}
    </Section>
  );
}

function ScheduleRow({
  schedule, onChanged,
}: { schedule: AgentSchedule; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 hover:border-violet-300 transition-colors">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{schedule.name}</div>
          <div className="text-[11px] text-ink-500 font-mono truncate">
            {humanCron(schedule.cron, schedule.timezone)}
            {" · next "}{new Date(schedule.next_run_at).toLocaleString()}
          </div>
        </div>
        <button
          className="btn-ghost text-[11px]"
          title={schedule.status === "active" ? "Pause" : "Resume"}
          onClick={async () => {
            const next = schedule.status === "active" ? "paused" : "active";
            await api.patch(`/schedules/${schedule.id}`, { status: next });
            onChanged();
          }}
        >
          {schedule.status === "active"
            ? <LuPause className="size-3.5" />
            : <LuPlay className="size-3.5" />}
        </button>
        <button className="btn-ghost text-[11px]" onClick={() => setEditing(true)}>
          <LuPencil className="size-3.5" />
        </button>
        <button
          className="btn-ghost text-rose-600 text-[11px]"
          onClick={async () => {
            if (!confirm(`Delete schedule "${schedule.name}"?`)) return;
            await api.del(`/schedules/${schedule.id}`);
            onChanged();
          }}
        >
          <LuTrash className="size-3.5" />
        </button>
      </div>
      {editing && (
        <ScheduleEditor
          agentId={schedule.agent_id}
          initial={schedule}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); onChanged(); }}
        />
      )}
    </>
  );
}

function ScheduleEditor({
  agentId, initial, onClose, onSaved,
}: {
  agentId: string;
  initial: AgentSchedule | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [freq, setFreq] = useState<"hourly" | "daily" | "weekdays" | "weekly" | "custom">(() =>
    initial ? guessFreq(initial.cron) : "daily",
  );
  const [hour, setHour] = useState(() => {
    if (!initial) return 9;
    const m = initial.cron.match(/^\d+\s+(\d+)/);
    return m ? parseInt(m[1]) : 9;
  });
  const [minute, setMinute] = useState(() => {
    if (!initial) return 0;
    const m = initial.cron.match(/^(\d+)/);
    return m ? parseInt(m[1]) : 0;
  });
  const [weekday, setWeekday] = useState(() => {
    if (!initial) return 1; // Mon
    const m = initial.cron.match(/(\d)$/);
    return m ? parseInt(m[1]) : 1;
  });
  const [customCron, setCustomCron] = useState(initial?.cron ?? "0 9 * * 1-5");
  const [tz, setTz] = useState(initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [triggerMessage, setTriggerMessage] = useState(initial?.trigger_message ?? "");
  const [status, setStatus] = useState<"active" | "paused">(initial?.status ?? "active");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cron = freq === "custom"
    ? customCron
    : freq === "hourly"
    ? `${minute} * * * *`
    : freq === "daily"
    ? `${minute} ${hour} * * *`
    : freq === "weekdays"
    ? `${minute} ${hour} * * 1-5`
    : `${minute} ${hour} * * ${weekday}`;

  async function save() {
    if (!name.trim()) { setErr("Name is required"); return; }
    setSaving(true); setErr(null);
    try {
      const body = {
        agent_id: agentId,
        name,
        cron,
        timezone: tz,
        trigger_message: triggerMessage || undefined,
        status,
      };
      if (initial) await api.patch(`/schedules/${initial.id}`, body);
      else await api.post("/schedules", body);
      onSaved();
    } catch (e) { setErr((e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-sm grid place-items-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden">
        <header className="flex items-center justify-between px-5 py-3 border-b border-neutral-200">
          <div className="text-sm font-medium">{initial ? "Edit schedule" : "New schedule"}</div>
          <button className="btn-ghost size-8 p-0 grid place-items-center" onClick={onClose}>
            <LuX className="size-4" />
          </button>
        </header>
        <div className="p-5 space-y-3">
          <div>
            <label className="label block mb-1">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly board recap" />
          </div>
          <div>
            <label className="label block mb-1">Frequency</label>
            <select className="input" value={freq} onChange={(e) => setFreq(e.target.value as typeof freq)}>
              {FREQUENCY_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
          {freq === "hourly" && (
            <div>
              <label className="label block mb-1">Minute of hour</label>
              <input type="number" min={0} max={59} className="input"
                value={minute} onChange={(e) => setMinute(parseInt(e.target.value || "0"))} />
            </div>
          )}
          {(freq === "daily" || freq === "weekdays" || freq === "weekly") && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label block mb-1">Hour</label>
                <input type="number" min={0} max={23} className="input"
                  value={hour} onChange={(e) => setHour(parseInt(e.target.value || "0"))} />
              </div>
              <div>
                <label className="label block mb-1">Minute</label>
                <input type="number" min={0} max={59} className="input"
                  value={minute} onChange={(e) => setMinute(parseInt(e.target.value || "0"))} />
              </div>
            </div>
          )}
          {freq === "weekly" && (
            <div>
              <label className="label block mb-1">Day of week</label>
              <select className="input" value={weekday} onChange={(e) => setWeekday(parseInt(e.target.value))}>
                <option value={1}>Monday</option>
                <option value={2}>Tuesday</option>
                <option value={3}>Wednesday</option>
                <option value={4}>Thursday</option>
                <option value={5}>Friday</option>
                <option value={6}>Saturday</option>
                <option value={0}>Sunday</option>
              </select>
            </div>
          )}
          {freq === "custom" && (
            <div>
              <label className="label block mb-1">Cron expression</label>
              <input className="input font-mono text-xs" value={customCron}
                onChange={(e) => setCustomCron(e.target.value)} placeholder="0 9 * * 1-5" />
              <div className="text-[11px] text-ink-500 mt-1 font-mono">m h dom mon dow</div>
            </div>
          )}
          <div>
            <label className="label block mb-1">Timezone</label>
            <input className="input font-mono text-xs" value={tz} onChange={(e) => setTz(e.target.value)} />
          </div>
          <div>
            <label className="label block mb-1">Trigger message (optional)</label>
            <textarea className="input" rows={3} value={triggerMessage}
              onChange={(e) => setTriggerMessage(e.target.value)}
              placeholder="Generate this week's board recap." />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="active" checked={status === "active"}
              onChange={(e) => setStatus(e.target.checked ? "active" : "paused")} />
            <label htmlFor="active" className="text-sm">Active</label>
          </div>
          <div className="text-[11px] text-ink-500 font-mono">
            cron: {cron}
          </div>
          {err && <div className="text-rose-600 text-sm">{err}</div>}
        </div>
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-neutral-200">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : initial ? "Save" : "Create"}
          </button>
        </footer>
      </div>
    </div>
  );
}

// Naive but good-enough: classify a saved cron expression back to one of our
// presets so the editor opens with the right inputs populated.
function guessFreq(cron: string): "hourly" | "daily" | "weekdays" | "weekly" | "custom" {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "custom";
  const [, h, dom, mon, dow] = parts;
  if (h === "*" && dom === "*" && mon === "*" && dow === "*") return "hourly";
  if (dom === "*" && mon === "*" && dow === "*") return "daily";
  if (dom === "*" && mon === "*" && dow === "1-5") return "weekdays";
  if (dom === "*" && mon === "*" && /^\d$/.test(dow)) return "weekly";
  return "custom";
}
