// /agents — List + create. Click a card → /agents/:id (chat + config).
// Creating an agent ALSO creates an Anthropic agent (server-side) when
// ANTHROPIC_API_KEY is set; otherwise the create call returns a 502 we
// surface to the user.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LuPlus } from "react-icons/lu";
import { api, type Agent } from "../lib/api";
import { refresh, useApi } from "../lib/swr";
import { EmptyState, Modal, Page } from "../components/Page";
import { OrbAvatar } from "../components/OrbAvatar";

const DEFAULT_AGENT_MODEL = "claude-opus-4-7";

export function AgentsPage() {
  const { data } = useApi<{ data: Agent[] }>("/agents");
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();

  return (
    <Page
      title="Agents"
      subtitle="Reusable teammates with saved instructions, skills, and working style."
      actions={
        <button className="btn-primary" onClick={() => setCreating(true)} title="New agent" style={{ padding: "0.375rem 0.5rem" }}>
          <LuPlus className="size-4" />
        </button>
      }
    >
      <div className="p-6">
        {!data?.data?.length ? (
          <EmptyState
            title="No agents yet"
            body="Create a teammate with a clear role and strong instructions."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {data.data.map((a) => (
              <button
                key={a.id}
                onClick={() => nav(`/agents/${a.id}`)}
                className="card text-left p-4 hover:border-violet-300 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <OrbAvatar seed={a.id} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{a.name}</div>
                    <div className="text-xs text-ink-500 truncate">{a.role || "—"}</div>
                  </div>
                </div>
                <p className="text-xs text-ink-500 mt-3 line-clamp-3">{a.system_prompt || "(no instructions yet)"}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      <CreateAgentModal open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

function CreateAgentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [emoji, setEmoji] = useState("🤖");
  const [systemPrompt, setSystemPrompt] = useState("You are a helpful assistant.");
  const [autoMemory, setAutoMemory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal
      open={open} onClose={onClose} title="New agent"
      footer={
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary" disabled={!name || busy}
            onClick={async () => {
              setBusy(true); setErr(null);
              try {
                await api.post<Agent>("/agents", {
                  name, role, emoji, model: DEFAULT_AGENT_MODEL,
                  system_prompt: systemPrompt,
                  auto_memory: autoMemory,
                });
                refresh("/agents"); onClose();
                setName(""); setRole(""); setEmoji("🤖");
                setSystemPrompt("You are a helpful assistant."); setAutoMemory(false);
              } catch (e) { setErr((e as Error).message); }
              finally { setBusy(false); }
            }}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-[80px_1fr] gap-3">
          <div>
            <label className="label block mb-1">Emoji</label>
            <input className="input text-center text-xl" value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={2} />
          </div>
          <div>
            <label className="label block mb-1">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
        </div>
        <div>
          <label className="label block mb-1">Role</label>
          <input className="input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Triage, Researcher, …" />
        </div>
        <div>
          <label className="label block mb-1">Instructions</label>
          <textarea className="input font-mono text-xs" rows={5} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
        </div>
        <label className="flex items-start gap-3 p-3 rounded-lg border border-neutral-200 hover:border-violet-300 cursor-pointer transition-colors">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={autoMemory}
            onChange={(e) => setAutoMemory(e.target.checked)}
          />
          <div>
            <div className="text-sm font-medium">Persistent memory</div>
            <div className="text-[11px] text-ink-500 mt-0.5">
              Provisions a private memory store so this agent remembers findings
              and context across sessions. The agent reads and writes it at{" "}
              <code className="font-mono">/mnt/memory/</code>.
            </div>
          </div>
        </label>
        {err && <div className="text-rose-600 text-sm">{err}</div>}
      </div>
    </Modal>
  );
}
