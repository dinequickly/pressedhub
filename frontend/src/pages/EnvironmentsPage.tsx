// /environments — Each row is an Anthropic Environment. Defaults to cloud +
// unrestricted networking; the form lets you set packages and switch to
// limited networking with an allowlist.

import { useState } from "react";
import { LuBox, LuPlus, LuTrash } from "react-icons/lu";
import { api, type Environment } from "../lib/api";
import { refresh, useApi } from "../lib/swr";
import { EmptyState, Modal, Page } from "../components/Page";

export function EnvironmentsPage() {
  const { data } = useApi<{ data: Environment[] }>("/environments");
  const [creating, setCreating] = useState(false);

  return (
    <Page
      title="Environments"
      subtitle="Containers your agents run inside. Maps 1:1 to Anthropic environments."
      actions={
        <button className="btn-primary" onClick={() => setCreating(true)}>
          <LuPlus className="size-4" /> New environment
        </button>
      }
    >
      <div className="p-6">
        {!data?.data?.length ? (
          <EmptyState title="No environments yet" />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {data.data.map((e) => (
              <div key={e.id} className="card p-4">
                <div className="flex items-start gap-3">
                  <div className="size-10 rounded-xl bg-sky-50 text-sky-500 grid place-items-center">
                    <LuBox className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{e.name}</div>
                    <div className="text-[11px] text-ink-500 font-mono truncate">
                      {e.anthropic_id ?? "no anthropic id"}
                    </div>
                  </div>
                  <button
                    className="btn-ghost text-rose-600 hover:bg-rose-50 -mr-2 -mt-1"
                    onClick={async () => {
                      if (!confirm(`Archive ${e.name}?`)) return;
                      await api.del(`/environments/${e.id}`);
                      refresh("/environments");
                    }}
                  >
                    <LuTrash className="size-3.5" />
                  </button>
                </div>
                <pre className="rounded-lg bg-neutral-50 mt-3 p-2 text-[11px] font-mono whitespace-pre-wrap">
                  {JSON.stringify(e.config, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>

      <CreateEnvModal open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

function CreateEnvModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [networking, setNetworking] = useState<"unrestricted" | "limited">("unrestricted");
  const [allowedHosts, setAllowedHosts] = useState("");
  const [pip, setPip] = useState("");
  const [npm, setNpm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <Modal
      open={open} onClose={onClose} title="New environment"
      footer={
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary" disabled={!name || busy}
            onClick={async () => {
              setBusy(true); setErr(null);
              try {
                const config: Record<string, unknown> = {
                  type: "cloud",
                  networking: networking === "limited"
                    ? {
                      type: "limited",
                      allowed_hosts: allowedHosts.split(",").map((s) => s.trim()).filter(Boolean),
                      allow_mcp_servers: true,
                      allow_package_managers: true,
                    }
                    : { type: "unrestricted" },
                };
                const packages: Record<string, string[]> = {};
                const pipPkgs = pip.split(",").map((s) => s.trim()).filter(Boolean);
                const npmPkgs = npm.split(",").map((s) => s.trim()).filter(Boolean);
                if (pipPkgs.length) packages.pip = pipPkgs;
                if (npmPkgs.length) packages.npm = npmPkgs;
                if (Object.keys(packages).length) config.packages = packages;
                await api.post("/environments", { name, config });
                refresh("/environments"); onClose();
                setName(""); setAllowedHosts(""); setPip(""); setNpm("");
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
        <div>
          <label className="label block mb-1">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div>
          <label className="label block mb-1">Networking</label>
          <select className="input" value={networking} onChange={(e) => setNetworking(e.target.value as typeof networking)}>
            <option value="unrestricted">Unrestricted</option>
            <option value="limited">Limited (allowlist)</option>
          </select>
        </div>
        {networking === "limited" && (
          <div>
            <label className="label block mb-1">Allowed hosts (comma-separated)</label>
            <input className="input font-mono text-xs" value={allowedHosts} onChange={(e) => setAllowedHosts(e.target.value)} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label block mb-1">pip packages</label>
            <input className="input font-mono text-xs" value={pip} onChange={(e) => setPip(e.target.value)} placeholder="pandas, numpy" />
          </div>
          <div>
            <label className="label block mb-1">npm packages</label>
            <input className="input font-mono text-xs" value={npm} onChange={(e) => setNpm(e.target.value)} placeholder="lodash" />
          </div>
        </div>
        {err && <div className="text-rose-600 text-sm">{err}</div>}
      </div>
    </Modal>
  );
}
