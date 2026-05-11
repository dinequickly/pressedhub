// /knowledge — Folder tree (left) + file grid (right). Drag-to-upload via
// the kb-upload-url + signed PUT. Search bar hits /kb/search.

import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  LuFolder, LuFolderPlus, LuFileText, LuSearch, LuUpload, LuTrash,
  LuFile, LuFileSpreadsheet, LuImage, LuFileCode, LuPresentation,
  LuFileArchive, LuFileAudio, LuFileVideo, LuFileType,
} from "react-icons/lu";
import type { IconType } from "react-icons";
import { api, type KbFile, type KbFolder } from "../lib/api";
import { refresh, useApi } from "../lib/swr";
import { EmptyState, Modal, Page, StatusPill } from "../components/Page";
import { KbFileModal } from "../components/KbFileModal";
import { openCsvInSheets } from "../lib/sheets";
import { humanizeBytes } from "../lib/format";
import { uploadKbFile } from "../lib/kb";

// CSVs open in the full-page /sheets editor; everything else opens in the
// inline modal.
function isSpreadsheet(f: KbFile): boolean {
  const ext = f.name.toLowerCase().split(".").pop() ?? "";
  return ext === "csv" || (f.mime ?? "").toLowerCase() === "text/csv";
}

export function KnowledgePage() {
  const nav = useNavigate();
  const [folderId, setFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<null | Array<{
    chunk_id: string; file_id: string; file_name: string;
    ord: number; similarity: number; text: string; tags: string[];
  }>>(null);
  const [searching, setSearching] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [openFile, setOpenFile] = useState<KbFile | null>(null);

  const { data: folders } = useApi<{ data: KbFolder[] }>("/kb/folders");
  const filesPath = folderId ? `/kb/files?folder_id=${folderId}` : "/kb/files";
  const { data: files, mutate: refetchFiles } = useApi<{ data: KbFile[] }>(filesPath);

  const folderTree = useMemo(() => buildTree(folders?.data ?? []), [folders]);
  const folderById = useMemo(
    () => new Map((folders?.data ?? []).map((f) => [f.id, f])),
    [folders],
  );
  const pathFor = (f: KbFile) =>
    f.folder_id ? folderById.get(f.folder_id)?.path ?? null : null;

  async function search() {
    if (!query.trim()) { setSearchResults(null); return; }
    setSearching(true);
    try {
      const res = await api.post<{ results: typeof searchResults }>("/kb/search", {
        query, limit: 8,
      });
      setSearchResults(res.results ?? []);
    } finally {
      setSearching(false);
    }
  }

  async function uploadFile(file: File) {
    await uploadKbFile(file, folderId);
    await refetchFiles();
  }

  return (
    <Page
      title="Knowledge"
      subtitle="Reference files, uploads, and source material your workspace can pull from."
      actions={
        <>
          <button className="btn-ghost" onClick={() => setCreatingFolder(true)}>
            <LuFolderPlus className="size-4" /> New folder
          </button>
          <UploadButton onPick={uploadFile} />
        </>
      }
    >
      <div className="h-full grid grid-cols-[260px_1fr]">
        <div className="border-r border-neutral-200 overflow-y-auto p-2">
          <FolderRow
            label="All files"
            active={folderId === null}
            onClick={() => setFolderId(null)}
            depth={0}
          />
          {folderTree.map((f) => (
            <FolderNode
              key={f.id}
              folder={f}
              activeId={folderId}
              onSelect={setFolderId}
              depth={0}
            />
          ))}
        </div>
        <div className="overflow-y-auto p-6">
          <div className="flex items-center gap-2 mb-4">
            <div className="relative flex-1 max-w-md">
              <LuSearch className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-ink-300" />
              <input
                className="input pl-9"
                placeholder="Search snippets…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") search(); }}
              />
            </div>
            <button className="btn-ghost" onClick={search} disabled={searching}>
              {searching ? "Searching…" : "Search"}
            </button>
            {searchResults && (
              <button className="btn-ghost" onClick={() => { setSearchResults(null); setQuery(""); }}>
                Clear
              </button>
            )}
          </div>

          {searchResults ? (
            <SearchResults results={searchResults} />
          ) : (
            <BrowseGrid
              folderId={folderId}
              folders={folders?.data ?? []}
              files={files?.data ?? []}
              pathFor={pathFor}
              onOpenFile={(f) => {
                if (isSpreadsheet(f)) {
                  void openCsvInSheets({ kind: "kb", fileId: f.id }, nav);
                } else {
                  setOpenFile(f);
                }
              }}
              onOpenFolder={setFolderId}
              onChanged={() => refetchFiles()}
            />
          )}
        </div>
      </div>

      <NewFolderModal
        open={creatingFolder}
        parentId={folderId}
        onClose={() => setCreatingFolder(false)}
        onCreated={() => refresh("/kb/folders")}
      />

      {openFile && (
        <KbFileModal
          file={openFile}
          folderPath={pathFor(openFile)}
          onClose={() => setOpenFile(null)}
          onSaved={() => { refetchFiles(); setOpenFile(null); }}
        />
      )}
    </Page>
  );
}

function UploadButton({ onPick }: { onPick: (file: File) => Promise<void> }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        className="btn-primary"
        onClick={() => ref.current?.click()}
        disabled={busy}
      >
        <LuUpload className="size-4" />
        {busy ? "Uploading…" : "Upload"}
      </button>
      <input
        ref={ref}
        type="file"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setBusy(true);
          try { await onPick(f); }
          catch (err) { alert((err as Error).message); }
          finally { setBusy(false); if (ref.current) ref.current.value = ""; }
        }}
      />
    </>
  );
}

function buildTree(rows: KbFolder[]) {
  type Node = KbFolder & { children: Node[] };
  const byId = new Map<string, Node>();
  rows.forEach((r) => byId.set(r.id, { ...r, children: [] }));
  const roots: Node[] = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function FolderNode({
  folder, activeId, onSelect, depth,
}: {
  folder: KbFolder & { children: (KbFolder & { children: unknown[] })[] };
  activeId: string | null;
  onSelect: (id: string) => void;
  depth: number;
}) {
  return (
    <div>
      <FolderRow
        label={folder.name}
        active={activeId === folder.id}
        onClick={() => onSelect(folder.id)}
        depth={depth}
      />
      {folder.children.map((c) => (
        <FolderNode
          key={c.id}
          folder={c as KbFolder & { children: never[] }}
          activeId={activeId}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

function FolderRow({
  label, active, onClick, depth,
}: { label: string; active: boolean; onClick: () => void; depth: number }) {
  return (
    <button
      onClick={onClick}
      className={[
        "w-full text-left px-2 py-1.5 rounded-lg flex items-center gap-2 text-sm transition-colors",
        active ? "bg-violet-50 text-violet-700" : "text-ink-700 hover:bg-neutral-100",
      ].join(" ")}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <LuFolder className={`size-4 ${active ? "text-violet-500" : "text-ink-300"}`} />
      <span className="truncate">{label}</span>
    </button>
  );
}

// File-type icon + tint based on mime first, extension second. The tint
// matches the mime "family" so the grid feels Finder-ish at a glance.
function iconForFile(f: { name: string; mime: string }): { Icon: IconType; tint: string; bg: string } {
  const mime = (f.mime ?? "").toLowerCase();
  const ext = (f.name.split(".").pop() ?? "").toLowerCase();
  if (mime.startsWith("image/")) return { Icon: LuImage, tint: "text-rose-500", bg: "bg-rose-50" };
  if (mime.startsWith("audio/")) return { Icon: LuFileAudio, tint: "text-pink-500", bg: "bg-pink-50" };
  if (mime.startsWith("video/")) return { Icon: LuFileVideo, tint: "text-fuchsia-500", bg: "bg-fuchsia-50" };
  if (mime.includes("presentation") || ext === "ppt" || ext === "pptx" || ext === "key") {
    return { Icon: LuPresentation, tint: "text-orange-500", bg: "bg-orange-50" };
  }
  if (mime.includes("spreadsheet") || mime === "text/csv" || ext === "xls" || ext === "xlsx" || ext === "csv" || ext === "tsv") {
    return { Icon: LuFileSpreadsheet, tint: "text-emerald-500", bg: "bg-emerald-50" };
  }
  if (mime === "application/pdf" || ext === "pdf") {
    return { Icon: LuFileType, tint: "text-red-500", bg: "bg-red-50" };
  }
  if (
    mime.includes("zip") || mime.includes("compressed") || mime.includes("tar") ||
    ext === "zip" || ext === "tar" || ext === "gz" || ext === "rar" || ext === "7z"
  ) {
    return { Icon: LuFileArchive, tint: "text-amber-500", bg: "bg-amber-50" };
  }
  // Code-ish: by extension since mime is often application/octet-stream.
  const codeExts = new Set([
    "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "swift",
    "c", "cc", "cpp", "h", "hpp", "cs", "php", "sh", "bash", "zsh", "sql",
    "json", "yml", "yaml", "toml", "xml", "html", "css", "scss",
  ]);
  if (mime.startsWith("application/json") || mime.includes("javascript") || mime.includes("python") || codeExts.has(ext)) {
    return { Icon: LuFileCode, tint: "text-sky-500", bg: "bg-sky-50" };
  }
  if (mime.startsWith("text/") || ext === "md" || ext === "txt" || ext === "rtf") {
    return { Icon: LuFileText, tint: "text-violet-500", bg: "bg-violet-50" };
  }
  return { Icon: LuFile, tint: "text-ink-500", bg: "bg-neutral-100" };
}

function BrowseGrid({
  folderId, folders, files, pathFor, onOpenFile, onOpenFolder, onChanged,
}: {
  folderId: string | null;
  folders: KbFolder[];
  files: KbFile[];
  pathFor: (f: KbFile) => string | null;
  onOpenFile: (f: KbFile) => void;
  onOpenFolder: (id: string) => void;
  onChanged: () => void;
}) {
  // Two layouts:
  //   - At root (folderId === null): show all root-level folders as cards
  //     PLUS files that have no folder. Files inside folders are reached
  //     by clicking into the folder.
  //   - Inside a folder: show subfolders of that folder + all files in it
  //     (the /kb/files?folder_id= response already filters files for us).
  const visibleFolders = folders.filter((f) =>
    folderId === null ? f.parent_id === null : f.parent_id === folderId
  );
  const visibleFiles = folderId === null
    ? files.filter((f) => f.folder_id === null)
    : files;

  if (visibleFolders.length === 0 && visibleFiles.length === 0) {
    return (
      <EmptyState
        title="Nothing here yet"
        body="Upload a file or create a folder to get started."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {visibleFolders.map((folder) => {
        const fileCount = files.filter((f) => f.folder_id === folder.id).length;
        return (
          <div
            key={folder.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpenFolder(folder.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenFolder(folder.id); } }}
            className="card p-4 cursor-pointer hover:border-violet-300 transition-colors text-left"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="size-8 rounded-lg bg-amber-50 text-amber-500 grid place-items-center shrink-0">
                <LuFolder className="size-4" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{folder.name}</div>
                <div className="text-[11px] text-ink-500 font-mono mt-0.5">
                  {fileCount === 0 ? "empty" : `${fileCount} file${fileCount === 1 ? "" : "s"}`}
                </div>
              </div>
            </div>
          </div>
        );
      })}
      {visibleFiles.map((f) => {
        const folderPath = pathFor(f);
        const { Icon, tint, bg } = iconForFile(f);
        return (
          <div
            key={f.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpenFile(f)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenFile(f); } }}
            className="card p-4 cursor-pointer hover:border-violet-300 transition-colors text-left"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className={`size-8 rounded-lg ${bg} ${tint} grid place-items-center shrink-0`}>
                  <Icon className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{f.name}</div>
                  <div className="text-[11px] text-ink-500 font-mono mt-0.5 flex items-center gap-1.5">
                    {folderPath && (
                      <span className="inline-flex items-center gap-1 truncate">
                        <LuFolder className="size-3 text-ink-300 shrink-0" />
                        <span className="truncate">{folderPath}</span>
                      </span>
                    )}
                    {folderPath && <span>·</span>}
                    <span className="shrink-0">{humanizeBytes(f.size_bytes)}</span>
                  </div>
                </div>
              </div>
              <StatusPill status={f.status} />
            </div>
            {f.snippet && (
              <p className="text-xs text-ink-500 mt-3 line-clamp-3 font-mono whitespace-pre-wrap">
                {f.snippet}
              </p>
            )}
            {f.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-3">
                {f.tags.map((t) => (
                  <span key={t} className="pill">{t}</span>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-neutral-100">
              <span className="pill">{f.id.slice(0, 6)}</span>
              <button
                className="ml-auto btn-ghost text-rose-600 hover:bg-rose-50"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!confirm(`Delete ${f.name}?`)) return;
                  await api.del(`/kb/files/${f.id}`);
                  onChanged();
                }}
              >
                <LuTrash className="size-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SearchResults({
  results,
}: { results: NonNullable<Awaited<ReturnType<typeof api.post>>> | null }) {
  const list = (results as Array<{
    chunk_id: string; file_id: string; file_name: string;
    ord: number; similarity: number; text: string; tags: string[];
  }>) ?? [];
  if (list.length === 0) {
    return <EmptyState title="No matches" />;
  }
  return (
    <div className="space-y-2">
      <div className="label">Search results</div>
      {list.map((r) => (
        <div key={r.chunk_id} className="card p-4">
          <div className="flex items-center gap-2 mb-2">
            <LuFileText className="size-4 text-violet-500" />
            <div className="text-sm font-medium">{r.file_name}</div>
            <span className="pill">chunk {r.ord}</span>
            <span className="pill ml-auto">{(r.similarity * 100).toFixed(0)}% match</span>
          </div>
          <pre className="text-xs text-ink-700 font-mono whitespace-pre-wrap">{r.text}</pre>
        </div>
      ))}
    </div>
  );
}

function NewFolderModal({
  open, parentId, onClose, onCreated,
}: {
  open: boolean;
  parentId: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open} onClose={onClose} title="New folder"
      footer={
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary" disabled={!name || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post("/kb/folders", { name, parent_id: parentId ?? undefined, path: name });
                onCreated(); onClose(); setName("");
              } finally { setBusy(false); }
            }}
          >
            Create
          </button>
        </div>
      }
    >
      <label className="label block mb-1">Name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
    </Modal>
  );
}
