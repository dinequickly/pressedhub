// /memory — Stores list + per-store docs/tables. Inline create/edit of docs.

import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { LuPlus, LuFile, LuTable } from "react-icons/lu";
import { api, type MemoryDocument, type MemoryStore, type MemoryTable } from "../lib/api";
import { refresh, useApi } from "../lib/swr";
import { EmptyState, Modal, Page, StatusPill } from "../components/Page";

export function MemoryPage() {
  const { storeId } = useParams<{ storeId?: string }>();
  const nav = useNavigate();
  const { data: stores } = useApi<{ data: MemoryStore[] }>("/memory/stores");
  const [creatingStore, setCreatingStore] = useState(false);

  const selectedId = storeId ?? stores?.data?.[0]?.id ?? null;
  const selected = stores?.data?.find((s) => s.id === selectedId) ?? null;

  return (
    <Page
      title="Memory"
      subtitle="Markdown documents and structured tables agents read and write"
      actions={
        <button className="btn-primary" onClick={() => setCreatingStore(true)}>
          <LuPlus className="size-4" /> New store
        </button>
      }
    >
      <div className="h-full grid grid-cols-[280px_1fr]">
        <div className="border-r border-neutral-200 overflow-y-auto p-2">
          {!stores?.data?.length && (
            <EmptyState title="No memory stores yet" />
          )}
          {(stores?.data ?? []).map((s) => (
            <button
              key={s.id}
              onClick={() => nav(`/memory/${s.id}`)}
              className={[
                "w-full text-left px-3 py-2 rounded-lg flex items-center gap-2 transition-colors",
                selectedId === s.id ? "bg-emerald-50" : "hover:bg-neutral-100",
              ].join(" ")}
            >
              <div className="size-7 rounded-lg bg-emerald-50 text-emerald-500 grid place-items-center text-sm font-medium">
                {s.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{s.name}</div>
                <div className="text-[11px] text-ink-500 truncate">{s.scope}</div>
              </div>
            </button>
          ))}
        </div>
        <div className="overflow-y-auto">
          {selected ? (
            <StoreDetail store={selected} />
          ) : (
            <EmptyState title="Pick a memory store" />
          )}
        </div>
      </div>

      <NewStoreModal
        open={creatingStore}
        onClose={() => setCreatingStore(false)}
        onCreated={(s) => { setCreatingStore(false); nav(`/memory/${s.id}`); }}
      />
    </Page>
  );
}

function StoreDetail({ store }: { store: MemoryStore }) {
  const { data: docs } = useApi<{ data: MemoryDocument[] }>(`/memory/stores/${store.id}/documents`);
  const { data: tables } = useApi<{ data: MemoryTable[] }>(`/memory/stores/${store.id}/tables`);
  const [editing, setEditing] = useState<{ path: string; content: string } | null>(null);
  const [creatingTable, setCreatingTable] = useState(false);

  return (
    <div className="p-6">
      <div className="flex items-baseline gap-3 mb-1">
        <h2 className="text-lg font-semibold">{store.name}</h2>
        <StatusPill status={store.scope} />
      </div>
      <p className="text-sm text-ink-500">{store.description || "—"}</p>
      <div className="text-[11px] text-ink-500 font-mono mt-1">
        {store.total_versions} versions · updated {new Date(store.updated_at).toLocaleString()}
      </div>

      <section className="mt-6">
        <div className="flex items-center justify-between mb-2">
          <div className="label">Documents</div>
          <button
            className="btn-ghost"
            onClick={() => setEditing({ path: "context/new.md", content: "" })}
          >
            <LuPlus className="size-3.5" /> New document
          </button>
        </div>
        {!docs?.data?.length ? (
          <EmptyState title="No documents yet" />
        ) : (
          <div className="space-y-2">
            {docs.data.map((d) => (
              <button
                key={d.id}
                onClick={() => setEditing({ path: d.path, content: d.content })}
                className="card w-full text-left p-3 hover:border-violet-300 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <LuFile className="size-4 text-emerald-500" />
                  <div className="text-sm font-mono">{d.path}</div>
                  <span className="pill ml-auto">v{d.version_count}</span>
                </div>
                <div className="text-xs text-ink-500 mt-1.5 line-clamp-2 font-mono whitespace-pre-wrap">
                  {d.content || "(empty)"}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <div className="flex items-center justify-between mb-2">
          <div className="label">Tables</div>
          <button className="btn-ghost" onClick={() => setCreatingTable(true)}>
            <LuPlus className="size-3.5" /> New table
          </button>
        </div>
        {!tables?.data?.length ? (
          <EmptyState title="No tables yet" />
        ) : (
          <div className="space-y-2">
            {tables.data.map((t) => (
              <div key={t.id} className="card p-3">
                <div className="flex items-center gap-2">
                  <LuTable className="size-4 text-violet-500" />
                  <div className="text-sm font-medium">{t.name}</div>
                  <span className="pill ml-auto">{t.schema?.columns?.length ?? 0} cols</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <DocEditModal
        open={!!editing}
        store={store}
        initial={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh(`/memory/stores/${store.id}/documents`);
          refresh("/memory/stores");
        }}
      />
      <NewTableModal
        open={creatingTable}
        store={store}
        onClose={() => setCreatingTable(false)}
        onCreated={() => {
          setCreatingTable(false);
          refresh(`/memory/stores/${store.id}/tables`);
        }}
      />
    </div>
  );
}

function NewStoreModal({
  open, onClose, onCreated,
}: { open: boolean; onClose: () => void; onCreated: (s: MemoryStore) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<"workflow" | "user" | "shared">("user");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open} onClose={onClose} title="New memory store"
      footer={
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary" disabled={!name || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const created = await api.post<MemoryStore>("/memory/stores", { name, description, scope });
                refresh("/memory/stores");
                onCreated(created);
              } finally { setBusy(false); }
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
          <label className="label block mb-1">Description</label>
          <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <label className="label block mb-1">Scope</label>
          <select className="input" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="user">user — visible only to you</option>
            <option value="shared">shared — visible to all members</option>
            <option value="workflow">workflow — pinned to a workflow</option>
          </select>
        </div>
      </div>
    </Modal>
  );
}

function DocEditModal({
  open, store, initial, onClose, onSaved,
}: {
  open: boolean;
  store: MemoryStore;
  initial: { path: string; content: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [path, setPath] = useState(initial?.path ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [busy, setBusy] = useState(false);
  // Reset state whenever the modal reopens with new initial values.
  if (open && initial && path === "" && content === "") {
    setPath(initial.path); setContent(initial.content);
  }
  return (
    <Modal
      open={open}
      onClose={() => { onClose(); setPath(""); setContent(""); }}
      title={
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold">Document</span>
          <span className="pill">{store.name}</span>
        </div>
      }
      footer={
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => { onClose(); setPath(""); setContent(""); }}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!path || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post("/memory/upsert/document", {
                  store_id: store.id, path, content,
                });
                setPath(""); setContent("");
                onSaved();
              } finally { setBusy(false); }
            }}
          >
            Save
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label block mb-1">Path</label>
          <input className="input font-mono" value={path} onChange={(e) => setPath(e.target.value)} />
        </div>
        <div>
          <label className="label block mb-1">Content (markdown)</label>
          <textarea className="input font-mono text-xs" rows={14} value={content} onChange={(e) => setContent(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

function NewTableModal({
  open, store, onClose, onCreated,
}: { open: boolean; store: MemoryStore; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [columnsText, setColumnsText] = useState("name:text\nemail:text");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open} onClose={onClose} title={`New table in ${store.name}`}
      footer={
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary" disabled={!name || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const columns = columnsText
                  .split("\n").map((l) => l.trim()).filter(Boolean)
                  .map((line) => {
                    const [n, t] = line.split(":");
                    return { name: n, type: (t ?? "text").trim() };
                  });
                await api.post("/memory/tables", { store_id: store.id, name, schema: { columns } });
                setName(""); setColumnsText("");
                onCreated();
              } finally { setBusy(false); }
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
          <input className="input font-mono" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label block mb-1">Columns</label>
          <textarea
            className="input font-mono text-xs" rows={6}
            value={columnsText} onChange={(e) => setColumnsText(e.target.value)}
            placeholder="name:text&#10;count:number"
          />
          <p className="text-[11px] text-ink-500 mt-1">One per line as <code>column:type</code>.</p>
        </div>
      </div>
    </Modal>
  );
}
