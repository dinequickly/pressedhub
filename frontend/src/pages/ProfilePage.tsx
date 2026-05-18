// /profile — display the current profile, allow editing name, and (if
// admin) list members and promote. Also hosts the Connections section
// (Slack, etc.) since OAuth callbacks redirect here.

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LuShield, LuUser, LuPlug, LuCheck, LuTrash } from "react-icons/lu";
import { api, type Agent, type Profile, type VaultConnection, type WorkspaceSettings } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi, refresh } from "../lib/swr";
import { Page } from "../components/Page";
import { juicePfp } from "../lib/pfp";

export function ProfilePage() {
  const { profile, refreshProfile } = useAuth();
  const [name, setName] = useState(profile?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [bootstrapMsg, setBootstrapMsg] = useState<string | null>(null);

  const { data: members } = useApi<{ data: Profile[] }>(profile?.role === "admin" ? "/profiles" : null);

  if (!profile) return null;

  return (
    <Page title="Profile" subtitle={profile.email}>
      <div className="p-6 max-w-2xl space-y-6">
        <section className="card p-4">
          <div className="flex items-center gap-4">
            <img
              src={juicePfp(profile.id)}
              alt=""
              className="size-14 rounded-2xl object-cover bg-neutral-100"
            />
            <div className="min-w-0 flex-1">
              <div className="text-base font-medium">{profile.name}</div>
              <div className="text-xs text-ink-500">{profile.email}</div>
              <div className="mt-1">
                <span className={[
                  "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium",
                  profile.role === "admin" ? "bg-violet-50 text-violet-700" : "bg-neutral-100 text-ink-500",
                ].join(" ")}>
                  {profile.role === "admin" ? <LuShield className="size-3" /> : <LuUser className="size-3" />}
                  {profile.role}
                </span>
              </div>
            </div>
          </div>
          <div className="mt-5">
            <label className="label block mb-1">Display name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <button
            className="btn-primary mt-4"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.patch("/profiles/me", { name });
                await refreshProfile();
              } finally { setBusy(false); }
            }}
          >
            Save
          </button>
        </section>

        <ConnectionsSection />

        <section className="card p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">Admin</div>
              <div className="text-xs text-ink-500">
                The first user is auto-promoted on signup. If something went sideways, run bootstrap again.
              </div>
            </div>
            <button
              className="btn-ghost"
              onClick={async () => {
                const r = await api.post<{ promoted: boolean; reason?: string }>("/profiles/bootstrap-admin");
                setBootstrapMsg(r.promoted ? "Promoted." : r.reason ?? "—");
                await refreshProfile();
              }}
            >
              Bootstrap admin
            </button>
          </div>
          {bootstrapMsg && <div className="mt-2 text-xs text-ink-500">{bootstrapMsg}</div>}
        </section>

        {profile.role === "admin" && <WorkspaceNavSettings />}

        {profile.role === "admin" && members && (
          <section className="card p-4">
            <div className="font-medium mb-3">Members</div>
            <div className="space-y-1">
              {members.data.map((m) => (
                <div key={m.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-neutral-50">
                  <img
                    src={juicePfp(m.id)}
                    alt=""
                    className="size-7 rounded-full object-cover bg-neutral-100"
                  />
                  <div className="text-sm font-medium flex-1">{m.name}</div>
                  <div className="text-[11px] text-ink-500">{m.email}</div>
                  <span className={[
                    "px-2 py-0.5 rounded-md text-[11px] font-medium",
                    m.role === "admin" ? "bg-violet-50 text-violet-700" : "bg-neutral-100 text-ink-500",
                  ].join(" ")}>
                    {m.role}
                  </span>
                  {m.role !== "admin" && (
                    <button
                      className="btn-ghost"
                      onClick={async () => {
                        if (!confirm(`Promote ${m.name} to admin?`)) return;
                        await api.post(`/profiles/${m.id}/promote`);
                        refresh("/profiles");
                      }}
                    >
                      Promote
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </Page>
  );
}

// -- Workspace nav visibility (admin only) --------------------------------

const TOGGLEABLE_PAGES = [
  { key: "environments", label: "Environments" },
  { key: "runs", label: "Runs" },
  { key: "dreams", label: "Dreams" },
] as const;

function WorkspaceNavSettings() {
  const { data: wsSettings, mutate } = useApi<WorkspaceSettings>("/profiles/workspace-settings");
  const [saving, setSaving] = useState(false);
  const hidden = wsSettings?.hidden_nav_pages ?? [];

  async function toggle(key: string) {
    const next = hidden.includes(key)
      ? hidden.filter((p) => p !== key)
      : [...hidden, key];
    setSaving(true);
    try {
      await api.patch("/profiles/workspace-settings", { hidden_nav_pages: next });
      await mutate();
      refresh("/profiles/workspace-settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card p-4">
      <div className="font-medium mb-1">Sidebar pages</div>
      <div className="text-xs text-ink-500 mb-3">
        Choose which pages appear in the sidebar for all users.
      </div>
      <div className="space-y-2">
        {TOGGLEABLE_PAGES.map(({ key, label }) => {
          const visible = !hidden.includes(key);
          return (
            <label
              key={key}
              className="flex items-center justify-between gap-3 px-2 py-1.5 rounded-lg hover:bg-neutral-50 cursor-pointer"
            >
              <span className="text-sm">{label}</span>
              <button
                role="switch"
                aria-checked={visible}
                disabled={saving}
                onClick={() => toggle(key)}
                className={[
                  "relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                  visible ? "bg-violet-600" : "bg-neutral-200",
                  saving ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
                ].join(" ")}
              >
                <span
                  className={[
                    "pointer-events-none inline-block size-4 rounded-full bg-white shadow transition-transform",
                    visible ? "translate-x-4" : "translate-x-0",
                  ].join(" ")}
                />
              </button>
            </label>
          );
        })}
      </div>
    </section>
  );
}

// -- Connections (Slack, etc.) --------------------------------------------

type SlackMeta = {
  team_id?: string;
  team_name?: string;
  bot_user_id?: string;
  default_agent_id?: string;
};

function ConnectionsSection() {
  const { data: connections, mutate } = useApi<{ data: VaultConnection[] }>(
    "/vault-connections",
  );
  const { data: agents } = useApi<{ data: Agent[] }>("/agents");
  const [params, setParams] = useSearchParams();
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Soft toast when the OAuth callback bounces us back here.
  useEffect(() => {
    const flag = params.get("slack");
    if (flag === "connected") {
      setBanner("Slack connected.");
      mutate();
    } else if (flag === "denied") {
      setBanner(`Slack denied: ${params.get("error") ?? "unknown"}`);
    }
    if (flag) {
      const next = new URLSearchParams(params);
      next.delete("slack");
      next.delete("error");
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const slackConns = (connections?.data ?? []).filter((c) => c.connector_id === "slack");

  async function connectSlack() {
    setBusy(true);
    try {
      const { url } = await api.get<{ url: string }>("/slack-oauth/start");
      window.location.href = url;
    } catch (e) {
      setBanner(`Could not start OAuth: ${(e as Error).message}`);
      setBusy(false);
    }
  }

  return (
    <section className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-medium">Connections</div>
          <div className="text-xs text-ink-500">
            Authorize external services so agents can work with your tools securely.
          </div>
        </div>
        <button className="btn-primary" disabled={busy} onClick={connectSlack}>
          <LuPlug className="size-4" />
          {busy ? "Redirecting…" : "Connect Slack"}
        </button>
      </div>
      {banner && (
        <div className="mb-3 text-xs px-3 py-2 rounded-md bg-emerald-50 text-emerald-800 border border-emerald-100">
          {banner}
        </div>
      )}
      {slackConns.length === 0 ? (
        <div className="text-xs text-ink-500 italic">No Slack workspaces connected yet.</div>
      ) : (
        <div className="space-y-2">
          {slackConns.map((c) => (
            <SlackConnectionRow
              key={c.id}
              conn={c}
              agents={agents?.data ?? []}
              onChanged={mutate}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SlackConnectionRow({
  conn, agents, onChanged,
}: { conn: VaultConnection; agents: Agent[]; onChanged: () => void }) {
  const meta = (conn as unknown as { metadata?: SlackMeta }).metadata ?? {};
  const [agentId, setAgentId] = useState(meta.default_agent_id ?? "");
  const [saving, setSaving] = useState(false);

  async function setDefault(nextAgentId: string) {
    setSaving(true);
    try {
      const nextMeta = { ...meta, default_agent_id: nextAgentId || undefined };
      // PATCH writes the merged metadata back to vault_connections so the
      // events webhook can route mentions to this agent.
      await api.patch(`/vault-connections/${conn.id}`, { metadata: nextMeta });
      setAgentId(nextAgentId);
      onChanged();
    } catch (e) {
      alert(`Could not save: ${(e as Error).message}`);
    } finally { setSaving(false); }
  }

  async function disconnect() {
    if (!confirm(`Disconnect ${conn.account_label}?`)) return;
    await api.del(`/vault-connections/${conn.id}`);
    onChanged();
  }

  return (
    <div className="flex items-start gap-3 p-3 border border-neutral-200 rounded-lg">
      <div className="size-8 rounded-lg bg-emerald-50 grid place-items-center text-emerald-600 shrink-0">
        <LuCheck className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{conn.account_label}</div>
        <div className="text-[11px] text-ink-500 font-mono truncate">
          slack · team {meta.team_id ?? "—"}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <label className="label">Reply to mentions as</label>
          <select
            className="input flex-1"
            value={agentId}
            disabled={saving}
            onChange={(e) => setDefault(e.target.value)}
          >
            <option value="">— Pick an agent —</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>
            ))}
          </select>
        </div>
      </div>
      <button className="btn-ghost text-rose-600" onClick={disconnect}>
        <LuTrash className="size-4" />
      </button>
    </div>
  );
}
