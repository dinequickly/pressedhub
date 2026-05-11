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

export function AgentsPage() {
  const { data } = useApi<{ data: Agent[] }>("/agents");
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();

  return (
    <Page
      title="Agents"
      subtitle="Reusable agent configurations. Each one mirrors an Anthropic Managed Agent."
      actions={
        <button className="btn-primary" onClick={() => setCreating(true)}>
          <LuPlus className="size-4" /> New agent
        </button>
      }
    >
      <div className="p-6">
        {!data?.data?.length ? (
          <EmptyState
            title="No agents yet"
            body="Creating an agent calls Anthropic POST /v1/agents under the hood."
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
                  <div className="size-10 rounded-xl bg-violet-50 grid place-items-center text-lg">
                    {a.emoji || "🤖"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{a.name}</div>
                    <div className="text-xs text-ink-500 truncate">{a.role || "—"}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="pill">{a.model}</span>
                  {a.anthropic_id && (
                    <span className="pill bg-violet-50 text-violet-600">
                      {a.anthropic_id.slice(0, 12)}…
                    </span>
                  )}
                </div>
                <p className="text-xs text-ink-500 mt-3 line-clamp-3">{a.system_prompt || "(no system prompt)"}</p>
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
  const [model, setModel] = useState("claude-opus-4-7");
  const [systemPrompt, setSystemPrompt] = useState("You are a helpful assistant.");
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
                  name, role, emoji, model, system_prompt: systemPrompt,
                });
                refresh("/agents"); onClose();
                setName(""); setRole(""); setSystemPrompt("You are a helpful assistant.");
              } catch (e) { setErr((e as Error).message); }
              finally { setBusy(false); }
            }}
          >
            Create
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
          <label className="label block mb-1">Model</label>
          <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="claude-opus-4-7">claude-opus-4-7</option>
            <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
            <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</option>
          </select>
        </div>
        <div>
          <label className="label block mb-1">System prompt</label>
          <textarea className="input font-mono text-xs" rows={5} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
        </div>
        {err && <div className="text-rose-600 text-sm">{err}</div>}
        <div className="text-[11px] text-ink-500">
          Creates an Anthropic agent under the hood — needs <code>ANTHROPIC_API_KEY</code>.
        </div>
      </div>
    </Modal>
  );
}

