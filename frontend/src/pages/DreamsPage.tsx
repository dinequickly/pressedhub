// /dreams — Pending diff proposals over memory stores. The detail modal
// styles itself like image-3: header strip, Added/Changed/Removed sections
// with semantic tints, side-by-side before/after panels.

import { useState } from "react";
import { LuMoon, LuPlus, LuMinus, LuArrowRight, LuCheck, LuX } from "react-icons/lu";
import { api, type Dream, type MemoryStore } from "../lib/api";
import { refresh, useApi } from "../lib/swr";
import { EmptyState, Modal, Page, StatusPill } from "../components/Page";

export function DreamsPage() {
  const { data: dreams } = useApi<{ data: Dream[] }>("/dreams");
  const { data: stores } = useApi<{ data: MemoryStore[] }>("/memory/stores");
  const storeNameById = new Map((stores?.data ?? []).map((s) => [s.id, s.name]));
  const [open, setOpen] = useState<Dream | null>(null);

  const list = dreams?.data ?? [];
  return (
    <Page
      title="Dreams"
      subtitle="Diff proposals over memory stores. Approve to apply, reject to discard."
    >
      <div className="p-6 space-y-2">
        {list.length === 0 ? (
          <EmptyState
            title="No dreams yet"
            body="Dreams are proposed mass-edits to a memory store from agents or admins."
          />
        ) : list.map((d) => (
          <button
            key={d.id}
            onClick={() => setOpen(d)}
            className="card w-full text-left p-4 hover:border-violet-300 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="size-9 rounded-xl bg-fuchsia-50 text-fuchsia-500 grid place-items-center">
                <LuMoon className="size-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <div className="font-medium">{storeNameById.get(d.store_id) ?? d.store_id.slice(0, 8)}</div>
                  <StatusPill status={d.status} />
                </div>
                <div className="text-xs text-ink-500 truncate">
                  {d.instructions ?? "(no instructions)"}
                </div>
              </div>
              <div className="text-right text-[11px] text-ink-500 font-mono">
                +{d.diff?.added?.length ?? 0} ·{" "}
                ~{d.diff?.changed?.length ?? 0} ·{" "}
                −{d.diff?.removed?.length ?? 0}
                <div className="mt-0.5">{new Date(d.created_at).toLocaleString()}</div>
              </div>
            </div>
          </button>
        ))}
      </div>

      <DreamModal
        dream={open}
        storeName={open ? storeNameById.get(open.store_id) ?? "" : ""}
        onClose={() => setOpen(null)}
        onDecided={() => { setOpen(null); refresh("/dreams"); }}
      />
    </Page>
  );
}

function DreamModal({
  dream, storeName, onClose, onDecided,
}: {
  dream: Dream | null;
  storeName: string;
  onClose: () => void;
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!dream) return null;
  const diff = dream.diff ?? { added: [], changed: [], removed: [] };

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    try {
      await api.post(`/dreams/${dream!.id}/decide`, { decision });
      onDecided();
    } finally { setBusy(false); }
  }

  return (
    <Modal
      open={!!dream}
      onClose={onClose}
      title={
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-xl bg-fuchsia-50 text-fuchsia-500 grid place-items-center">
            <LuMoon className="size-4" />
          </div>
          <div>
            <div className="text-base font-semibold flex items-center gap-2">
              Dream review · {storeName}
              <StatusPill status={dream.status} />
            </div>
            <div className="text-xs text-ink-500 font-mono">
              {dream.session_count} sessions · {new Date(dream.created_at).toLocaleString()}
            </div>
          </div>
        </div>
      }
      footer={
        dream.status === "pending" ? (
          <div className="flex items-center justify-between">
            <div className="text-xs text-ink-500">
              Approving applies all changes atomically.
            </div>
            <div className="flex gap-2">
              <button className="btn-danger" disabled={busy} onClick={() => decide("reject")}>
                <LuX className="size-4" /> Reject
              </button>
              <button
                className="btn-primary bg-emerald-600 hover:bg-emerald-700"
                disabled={busy} onClick={() => decide("approve")}
              >
                <LuCheck className="size-4" /> Approve
              </button>
            </div>
          </div>
        ) : (
          <div className="text-xs text-ink-500">
            Decided {dream.ended_at ? new Date(dream.ended_at).toLocaleString() : ""}.
          </div>
        )
      }
    >
      {dream.instructions && (
        <div className="rounded-xl bg-neutral-50 border border-neutral-200 p-3 text-sm text-ink-700 mb-5">
          <span className="font-medium">Instructions:</span> {dream.instructions}
        </div>
      )}

      <DiffSection
        kind="added" tint="emerald"
        items={diff.added.map((a) => (
          <div key={a.path}>
            <div className="font-mono text-xs text-ink-500 mb-1.5">{a.path}</div>
            <div className="rounded-lg bg-emerald-50/60 border border-emerald-200 p-3 text-sm text-emerald-900 whitespace-pre-wrap font-mono">
              {a.content || "(empty)"}
            </div>
          </div>
        ))}
      />

      <DiffSection
        kind="changed" tint="amber"
        items={diff.changed.map((c) => (
          <div key={c.path}>
            <div className="font-mono text-xs text-ink-500 mb-1.5">{c.path}</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-rose-50/60 border border-rose-200 p-3 text-sm text-rose-900 whitespace-pre-wrap font-mono">
                <div className="text-[10px] uppercase tracking-wide font-medium text-rose-500 mb-1">Before</div>
                {c.before || "(empty)"}
              </div>
              <div className="rounded-lg bg-emerald-50/60 border border-emerald-200 p-3 text-sm text-emerald-900 whitespace-pre-wrap font-mono">
                <div className="text-[10px] uppercase tracking-wide font-medium text-emerald-600 mb-1">After</div>
                {c.after || "(empty)"}
              </div>
            </div>
          </div>
        ))}
      />

      <DiffSection
        kind="removed" tint="rose"
        items={diff.removed.map((r) => (
          <div key={r.path}>
            <div className="font-mono text-xs text-ink-500 mb-1.5">{r.path}</div>
            <div className="rounded-lg bg-rose-50/60 border border-rose-200 p-3 text-sm text-rose-900 whitespace-pre-wrap font-mono line-through">
              {r.content || "(empty)"}
            </div>
          </div>
        ))}
      />
    </Modal>
  );
}

function DiffSection({
  kind, tint, items,
}: {
  kind: "added" | "changed" | "removed";
  tint: "emerald" | "amber" | "rose";
  items: React.ReactNode[];
}) {
  if (items.length === 0) return null;
  const ICON = { added: LuPlus, changed: LuArrowRight, removed: LuMinus }[kind];
  return (
    <section className="mb-5">
      <div className="flex items-center gap-2 mb-3">
        <span
          className={[
            "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium",
            `bg-${tint}-50 text-${tint}-700`,
          ].join(" ")}
        >
          <ICON className="size-3.5" /> {kind[0].toUpperCase() + kind.slice(1)}
        </span>
        <span className="text-xs text-ink-500">{items.length}</span>
      </div>
      <div className="space-y-3">{items}</div>
    </section>
  );
}
