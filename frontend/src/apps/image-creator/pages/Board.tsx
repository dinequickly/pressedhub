// Image Creator — single-board view.
//
// Layout (stage 1):
//   ┌──────────────────────────────────────────┐
//   │  Header (← back, name, status)           │
//   ├──────────┬───────────────────┬───────────┤
//   │ Toolbar  │   Canvas          │ Chat stub │
//   │  + img   │   (drag/drop)     │ (stage 2) │
//   │  + ref   │                   │           │
//   │  + prmt  │                   │           │
//   │  + note  │                   │           │
//   └──────────┴───────────────────┴───────────┘
//
// State + persistence:
//   - Local state holds the live board; debounced PATCH to /vibe-boards/:id
//     on every change (500ms).
//   - On mount, fetch /vibe-boards/:id and seed local state.
//   - The chat panel is a placeholder until stage 2 wires the Director agent.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  LuArrowLeft, LuImage, LuLibrary, LuMessageSquare, LuPenLine,
  LuPlus, LuStickyNote, LuLoader, LuCheck, LuUpload, LuX,
} from "react-icons/lu";
import { Modal } from "../../../components/Page";
import { useApi, refresh } from "../../../lib/swr";
import {
  api,
  type VibeBoard,
  type VibeBoardItem,
  type VibeBoardState,
} from "../../../lib/api";
import { FN_URL } from "../../../lib/supabase";
import { Canvas } from "../components/Canvas";
import { DirectorChat } from "../components/Chat";
import { Timeline } from "../components/Timeline";
import { uploadFileToMedia } from "../lib/uploadMedia";
import { loadThumb } from "../lib/thumbCache";

export function BoardPage() {
  const { boardId } = useParams<{ boardId: string }>();
  // Poll the board so items added by the agent (via update_board) eventually
  // surface even without the chat panel triggering an immediate refresh.
  const { data: board, isLoading, mutate: mutateBoard } = useApi<VibeBoard>(
    boardId ? `/vibe-boards/${boardId}` : null,
    { refreshInterval: 10000 },
  );

  const [state, setState] = useState<VibeBoardState | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [addingImage, setAddingImage] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "dirty" | "saving" | "saved">("idle");
  const [mode, setMode] = useState<"whiteboard" | "timeline">("whiteboard");
  const saveTimer = useRef<number | null>(null);
  // Tombstones for items the user deleted locally. The merge effect skips
  // these so a stale server poll doesn't resurrect a just-deleted item before
  // our debounced save lands. Cleared opportunistically when the server
  // confirms the item is gone.
  const deletedIds = useRef<Set<string>>(new Set());
  // Seed local state from the server snapshot once.
  useEffect(() => {
    if (board && state == null) {
      setState(board.state);
      setName(board.name);
    }
  }, [board, state]);

  // When the server has items the local state doesn't (agent appended via
  // update_board), merge them in *and* persist the union — otherwise the
  // user's next debounced save would overwrite the server state and drop the
  // agent items. The merge is idempotent: re-running after a save terminates
  // because all server item ids are now in local state. We also filter out
  // anything in `deletedIds` so deletions don't reappear from a stale poll.
  useEffect(() => {
    if (!board || !state) return;
    const localIds = new Set(state.items.map((it) => it.id));
    const newItems = board.state.items.filter(
      (it) => !localIds.has(it.id) && !deletedIds.current.has(it.id),
    );
    // Once the server agrees the item is gone, drop the tombstone.
    const serverIds = new Set(board.state.items.map((it) => it.id));
    for (const id of Array.from(deletedIds.current)) {
      if (!serverIds.has(id)) deletedIds.current.delete(id);
    }
    if (newItems.length > 0) {
      const merged = { ...state, items: [...state.items, ...newItems] };
      setState(merged);
      scheduleSave({ state: merged });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, state]);

  // Wraps state changes coming from the canvas. Accepts either an absolute
  // state value or a functional updater — functional form is essential when
  // two patchItem calls fire within the same tick (e.g. two prompt cards'
  // Send completing concurrently), otherwise the second would stale-closure
  // on the prop value and lose the first's update.
  function onCanvasChange(
    nextOrUpdater: VibeBoardState | ((prev: VibeBoardState) => VibeBoardState),
  ) {
    setState((prev) => {
      if (!prev) return prev;
      const next = typeof nextOrUpdater === "function"
        ? nextOrUpdater(prev)
        : nextOrUpdater;
      const nextIds = new Set(next.items.map((it) => it.id));
      for (const it of prev.items) {
        if (!nextIds.has(it.id)) deletedIds.current.add(it.id);
      }
      scheduleSave({ state: next });
      return next;
    });
  }

  // Debounced auto-save on state/name changes.
  const flush = useCallback(async (next: { state?: VibeBoardState; name?: string }) => {
    if (!boardId) return;
    setSaveStatus("saving");
    try {
      await api.patch(`/vibe-boards/${boardId}`, next);
      setSaveStatus("saved");
      // Refresh the boards list so the thumbnail/updated_at on /apps/image-creator
      // is fresh next time.
      refresh("/vibe-boards");
    } catch {
      setSaveStatus("dirty");
    }
  }, [boardId]);

  function scheduleSave(next: { state?: VibeBoardState; name?: string }) {
    setSaveStatus("dirty");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => flush(next), 500);
  }

  function updateState(next: VibeBoardState) {
    setState(next);
    scheduleSave({ state: next });
  }

  function addItem(type: VibeBoardItem["type"]) {
    if (!state) return;
    // "image" bypasses this path — clicking the toolbar button opens the
    // upload-or-library chooser, which calls addImageItems on completion.
    if (type === "image") {
      setAddingImage(true);
      return;
    }
    const id = `it_${Math.random().toString(36).slice(2, 10)}`;
    // Drop new items near the visible center of the canvas.
    const base = { id, x: 200 + (state.items.length % 5) * 40, y: 200 + (state.items.length % 5) * 30 };
    const item: VibeBoardItem =
      type === "reference" ? { ...base, type } :
      type === "prompt" ? { ...base, type, text: "" } :
      { ...base, type: "note", text: "" };
    updateState({ ...state, items: [...state.items, item] });
  }

  // Append already-uploaded image items (created by the AddImage modal)
  // to the board. Tiled relative to the existing item count.
  function addImageItems(items: VibeBoardItem[]) {
    if (!state || items.length === 0) return;
    updateState({ ...state, items: [...state.items, ...items] });
  }

  if (isLoading || !board || !state) {
    return <div className="p-6 text-sm text-ink-500">Loading…</div>;
  }

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      <BoardHeader
        name={name ?? board.name}
        saveStatus={saveStatus}
        onRename={() => setRenaming(true)}
        mode={mode}
        onMode={setMode}
      />
      {mode === "timeline" ? (
        <div className="flex-1 min-h-0">
          <Timeline fullScreen />
        </div>
      ) : (
        <div className="flex-1 grid grid-cols-[200px_1fr_320px] min-h-0">
          <Toolbar onAdd={addItem} items={state.items} />
          <Canvas
            boardId={board.id}
            state={state}
            onChange={onCanvasChange}
            sessionId={board.session_id}
          />
          <DirectorChat
            board={board}
            onAgentDidUpdateBoard={() => mutateBoard()}
          />
        </div>
      )}
      <RenameModal
        open={renaming}
        initialName={name ?? board.name}
        onSave={(next) => {
          setName(next);
          scheduleSave({ name: next });
          setRenaming(false);
        }}
        onClose={() => setRenaming(false)}
      />
      <AddImageModal
        open={addingImage}
        onClose={() => setAddingImage(false)}
        existingCount={state.items.length}
        onAdd={(items) => {
          addImageItems(items);
          setAddingImage(false);
        }}
      />
    </div>
  );
}

function BoardHeader({
  name, saveStatus, onRename, mode, onMode,
}: {
  name: string;
  saveStatus: "idle" | "dirty" | "saving" | "saved";
  onRename: () => void;
  mode: "whiteboard" | "timeline";
  onMode: (m: "whiteboard" | "timeline") => void;
}) {
  return (
    <div className="px-6 py-3 border-b border-zinc-800 bg-zinc-950 flex items-center gap-3">
      <Link to="/apps/image-creator" className="text-zinc-500 hover:text-zinc-200 transition-colors ml-12">
        <LuArrowLeft className="size-4" />
      </Link>
      <button
        onClick={onRename}
        className="text-base font-semibold tracking-tight text-zinc-100 hover:text-fuchsia-300 transition-colors"
      >
        {name}
      </button>
      <button onClick={onRename} className="text-zinc-500 hover:text-zinc-300 transition-colors">
        <LuPenLine className="size-3.5" />
      </button>
      <ModeSwitch mode={mode} onMode={onMode} />
      <SaveIndicator status={saveStatus} />
    </div>
  );
}

function ModeSwitch({
  mode, onMode,
}: { mode: "whiteboard" | "timeline"; onMode: (m: "whiteboard" | "timeline") => void }) {
  return (
    <div className="ml-4 flex">
      {(["whiteboard", "timeline"] as const).map((m) => (
        <button
          key={m}
          onClick={() => onMode(m)}
          className={[
            "px-4 py-1.5 text-xs font-medium tracking-wide border border-zinc-800 first:rounded-l-md last:rounded-r-md -ml-px first:ml-0 transition-colors",
            m === mode
              ? "bg-zinc-100 text-black border-zinc-100 z-10"
              : "bg-transparent text-zinc-400 hover:text-zinc-100 hover:border-zinc-700",
          ].join(" ")}
        >
          {m === "whiteboard" ? "Whiteboard" : "Timeline"}
        </button>
      ))}
    </div>
  );
}

function SaveIndicator({ status }: { status: "idle" | "dirty" | "saving" | "saved" }) {
  if (status === "idle") return null;
  if (status === "saving") {
    return (
      <span className="ml-auto text-[11px] text-zinc-400 font-mono flex items-center gap-1">
        <LuLoader className="size-3 animate-spin" /> saving…
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className="ml-auto text-[11px] text-emerald-400 font-mono flex items-center gap-1">
        <LuCheck className="size-3" /> saved
      </span>
    );
  }
  return <span className="ml-auto text-[11px] text-amber-400 font-mono">unsaved</span>;
}

function Toolbar({
  onAdd, items: boardItems,
}: {
  onAdd: (type: VibeBoardItem["type"]) => void;
  items: VibeBoardItem[];
}) {
  const adders: { type: VibeBoardItem["type"]; label: string; Icon: typeof LuImage; tint: string }[] = [
    { type: "note", label: "Note", Icon: LuStickyNote, tint: "amber" },
    { type: "image", label: "Image", Icon: LuImage, tint: "fuchsia" },
    { type: "prompt", label: "Prompt", Icon: LuMessageSquare, tint: "sky" },
  ];
  // Show all visual outputs in the sidebar: image/reference items on the
  // board, plus generations attached to prompt cards (these may not have
  // landed as standalone image items yet).
  const sidebarEntries: SidebarEntry[] = [];
  for (const it of boardItems) {
    if (it.type === "image" || it.type === "reference") {
      const mediaId = "media_asset_id" in it ? it.media_asset_id : undefined;
      sidebarEntries.push({
        key: it.id,
        media_asset_id: mediaId,
        name: ("name" in it && it.name) ? it.name :
              ("caption" in it && it.caption) ? it.caption :
              ("prompt" in it && it.prompt) ? it.prompt :
              it.id,
      });
    } else if (it.type === "prompt" && it.generations) {
      for (let i = 0; i < it.generations.length; i++) {
        const g = it.generations[i];
        sidebarEntries.push({
          key: g.id,
          media_asset_id: g.media_asset_id,
          name: it.text.trim()
            ? `${it.text.trim().slice(0, 40)}${it.text.length > 40 ? "…" : ""} · gen ${i + 1}`
            : `gen ${i + 1}`,
        });
      }
    }
  }
  return (
    <aside className="border-r border-zinc-800 bg-zinc-950 flex flex-col min-h-0">
      <div className="p-3 space-y-1 border-b border-zinc-900">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 px-2 mb-2">
          Add
        </div>
        {adders.map((it) => (
          <button
            key={it.type}
            onClick={() => onAdd(it.type)}
            className="w-full text-left px-2.5 py-2 rounded-lg flex items-center gap-2 hover:bg-zinc-900 transition-colors"
          >
            <div className={`size-7 rounded-lg bg-${it.tint}-500/15 text-${it.tint}-300 grid place-items-center`}>
              <it.Icon className="size-3.5" />
            </div>
            <div className="text-sm text-zinc-200">{it.label}</div>
            <LuPlus className="size-3.5 ml-auto text-zinc-600" />
          </button>
        ))}
      </div>
      <ImagesList entries={sidebarEntries} />
    </aside>
  );
}

type SidebarEntry = {
  key: string;
  media_asset_id?: string;
  name: string;
};

// Layers-panel style list of every visual output on the board. Small
// thumb + name, scrollable. Each entry is draggable onto a prompt card to
// attach as a reference.
function ImagesList({ entries }: { entries: SidebarEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="p-3 text-[11px] text-zinc-600 italic">
        Images you add or generate appear here.
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 px-2 mb-1.5">
        Images
      </div>
      <div className="space-y-1">
        {entries.map((e) => (
          <SidebarEntryRow key={e.key} entry={e} />
        ))}
      </div>
    </div>
  );
}

function SidebarEntryRow({ entry }: { entry: SidebarEntry }) {
  const draggable = !!entry.media_asset_id;
  return (
    <div
      className={[
        "flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-zinc-900 transition-colors",
        draggable ? "cursor-grab active:cursor-grabbing" : "",
      ].join(" ")}
      draggable={draggable}
      onDragStart={draggable ? (e) => {
        // Set both the custom MIME and the module-level inflight mirror
        // (same pattern image cards on the canvas use). Prompt cards read
        // the mirror synchronously during dragover, which is the only
        // reliable cross-browser path for internal drags.
        startSidebarDrag({
          media_asset_id: entry.media_asset_id!,
          name: entry.name,
          mime: "image/*",
        }, e);
      } : undefined}
      onDragEnd={() => clearSidebarDrag()}
    >
      <SidebarThumb mediaId={entry.media_asset_id} />
      <div className="text-[11px] text-zinc-300 truncate flex-1">{entry.name}</div>
    </div>
  );
}

function SidebarThumb({ mediaId }: { mediaId?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!mediaId) return;
    let cancelled = false;
    loadThumb(mediaId).then((u) => { if (!cancelled) setUrl(u); }).catch(() => {});
    return () => { cancelled = true; };
  }, [mediaId]);
  return (
    <div className="size-8 shrink-0 rounded-md bg-zinc-900 border border-zinc-800 overflow-hidden">
      {url ? <img src={url} className="size-full object-cover" draggable={false} /> : <div className="size-full" />}
    </div>
  );
}

// Mirror of the inflight asset drag used by the canvas. We can't import
// the canvas's internal helpers (they're not exported), so we define a
// parallel pair here and bridge through the window object so prompt
// cards on the canvas see sidebar-originated drags.
function startSidebarDrag(
  payload: { media_asset_id: string; name?: string; mime?: string },
  e: React.DragEvent,
) {
  // deno-lint-ignore no-explicit-any
  (window as any).__vibeAssetDrag = payload;
  e.dataTransfer.setData("application/x-vibe-asset", JSON.stringify(payload));
  e.dataTransfer.setData("text/plain", `vibe-asset:${payload.media_asset_id}`);
  e.dataTransfer.effectAllowed = "copy";
}
function clearSidebarDrag() {
  // deno-lint-ignore no-explicit-any
  (window as any).__vibeAssetDrag = null;
}

// Two-step "add image" chooser. Step one: pick "upload from computer" or
// "from library". Step two for upload kicks the OS file picker. Step two for
// library is currently a placeholder. The Modal shell is light-themed by
// default; we wrap our content in a dark surface that visually replaces it.
function AddImageModal({
  open, onClose, existingCount, onAdd,
}: {
  open: boolean;
  onClose: () => void;
  existingCount: number;
  onAdd: (items: VibeBoardItem[]) => void;
}) {
  const [step, setStep] = useState<"choose" | "library">("choose");
  const [uploading, setUploading] = useState<{ count: number; done: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset to step one whenever the modal is re-opened.
  useEffect(() => { if (open) { setStep("choose"); setUploading(null); } }, [open]);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    setUploading({ count: files.length, done: 0 });
    const created: VibeBoardItem[] = [];
    const ITEM_W = 240;
    // Tile new items in a 3-up grid offset from the existing count, so they
    // don't stack and don't overlap the typical "drop near center" spot.
    const baseX = 240;
    const baseY = 220 + (existingCount % 4) * 30;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const asset = await uploadFileToMedia(file);
        created.push({
          id: `it_${Math.random().toString(36).slice(2, 10)}`,
          type: "image",
          x: baseX + (i % 3) * (ITEM_W + 16),
          y: baseY + Math.floor(i / 3) * 280,
          // New shape: store the asset id so the sidebar can render a thumb
          // and the canvas image card can be dragged as a reference. The
          // older `url`-based shape didn't carry the id and broke both.
          media_asset_id: asset.id,
          name: file.name,
        });
      } catch (err) {
        console.warn(`[add-image] upload of ${file.name} failed:`, err);
      } finally {
        setUploading((s) => (s ? { ...s, done: s.done + 1 } : null));
      }
    }
    if (created.length > 0) onAdd(created);
  }

  return (
    <Modal open={open} onClose={onClose}>
      <div className="-m-5">
        <div className="bg-zinc-950 rounded-2xl border border-zinc-800 overflow-hidden">
          <div className="flex items-center px-5 py-4 border-b border-zinc-800">
            {step === "library" && (
              <button
                onClick={() => setStep("choose")}
                className="mr-2 text-zinc-500 hover:text-zinc-200 transition-colors"
                title="Back"
              >
                <LuArrowLeft className="size-4" />
              </button>
            )}
            <h2 className="text-base font-semibold text-zinc-100 tracking-tight">
              {step === "choose" ? "Add an image" : "From library"}
            </h2>
            <button
              onClick={onClose}
              className="ml-auto text-zinc-500 hover:text-zinc-200 transition-colors"
              title="Close"
            >
              <LuX className="size-4" />
            </button>
          </div>
          <div className="p-5">
            {step === "choose" ? (
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!!uploading}
                  className="group flex flex-col items-start gap-3 rounded-xl border border-fuchsia-400/30 bg-gradient-to-br from-fuchsia-500/10 via-zinc-900 to-violet-500/10 p-5 text-left transition-all hover:border-fuchsia-400/60 hover:shadow-lg hover:shadow-fuchsia-500/10 disabled:opacity-60 disabled:cursor-wait"
                >
                  <div className="size-10 rounded-lg bg-fuchsia-500/20 text-fuchsia-300 grid place-items-center group-hover:bg-fuchsia-500/30 transition-colors">
                    <LuUpload className="size-5" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-zinc-100">Upload from computer</div>
                    <div className="text-[11px] text-zinc-400 mt-1 leading-snug">
                      {uploading
                        ? `Uploading ${Math.min(uploading.done + 1, uploading.count)} of ${uploading.count}…`
                        : "Pick one or more images. They land on the board and your media library."}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setStep("library")}
                  className="group flex flex-col items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-5 text-left transition-all hover:border-zinc-700 hover:bg-zinc-900/80"
                >
                  <div className="size-10 rounded-lg bg-zinc-800 text-zinc-300 grid place-items-center group-hover:bg-zinc-700 transition-colors">
                    <LuLibrary className="size-5" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-zinc-100">From library</div>
                    <div className="text-[11px] text-zinc-400 mt-1 leading-snug">
                      Pick from images you've previously uploaded or generated.
                    </div>
                  </div>
                </button>
              </div>
            ) : (
              <LibraryPicker
                existingCount={existingCount}
                onPick={(items) => { onAdd(items); onClose(); }}
              />
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              void handleFiles(e.target.files);
              // Reset so re-selecting the same file re-fires onChange.
              if (e.target) e.target.value = "";
            }}
          />
        </div>
      </div>
    </Modal>
  );
}

// Library picker — grid of media_assets the user has uploaded (or synced via
// the bulk script). Click a tile to toggle selection; the footer adds all
// picked tiles onto the board.
function LibraryPicker({
  existingCount, onPick,
}: {
  existingCount: number;
  onPick: (items: VibeBoardItem[]) => void;
}) {
  // Fetch ALL assets once. Filtering + search happen client-side against
  // the full list — that keeps the chip row stable, lets search match
  // tags as well as filenames, and avoids burning a fetch per keystroke
  // when the user is exploring.
  const [allAssets, setAllAssets] = useState<MediaAsset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [tag, setTag] = useState<string>("");
  const [query, setQuery] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    api.get<{ data: MediaAsset[] }>(`/media`)
      .then((r) => { if (!cancelled) setAllAssets(r.data); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, []);

  // Tags pulled from the FULL list — stays stable across filter changes.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const a of allAssets ?? []) for (const t of a.tags ?? []) set.add(t);
    return Array.from(set).sort();
  }, [allAssets]);

  // Apply tag + search filters client-side. Search matches case-insensitively
  // against filename AND any tag — so "blue" hits assets in a Blue folder
  // even when "blue" isn't in the filename.
  const assets = useMemo(() => {
    const src = allAssets ?? [];
    const q = query.trim().toLowerCase();
    return src.filter((a) => {
      if (tag && !(a.tags ?? []).includes(tag)) return false;
      if (q) {
        const inName = a.name.toLowerCase().includes(q);
        const inTags = (a.tags ?? []).some((t) => t.toLowerCase().includes(q));
        if (!inName && !inTags) return false;
      }
      return true;
    });
  }, [allAssets, tag, query]);

  function toggle(id: string) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  }
  function add() {
    if (!assets) return;
    const ITEM_W = 240;
    const baseX = 240;
    const baseY = 220 + (existingCount % 4) * 30;
    const items: VibeBoardItem[] = [];
    let i = 0;
    for (const a of assets) {
      if (!picked.has(a.id)) continue;
      items.push({
        id: `it_${Math.random().toString(36).slice(2, 10)}`,
        type: "image",
        x: baseX + (i % 3) * (ITEM_W + 16),
        y: baseY + Math.floor(i / 3) * 280,
        media_asset_id: a.id,
        name: a.name,
      });
      i++;
    }
    if (items.length > 0) onPick(items);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          className="flex-1 bg-zinc-900 border border-zinc-800 rounded-md px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-700"
          placeholder="Search by filename…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {allTags.length > 0 && (
          <div className="flex gap-1 overflow-x-auto max-w-[60%]">
            <button
              type="button"
              onClick={() => setTag("")}
              className={[
                "shrink-0 px-2 py-1 text-[11px] rounded-md border transition-colors",
                tag === "" ? "border-zinc-300 text-zinc-100" : "border-zinc-800 text-zinc-500 hover:text-zinc-200",
              ].join(" ")}
            >
              all
            </button>
            {allTags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTag(t)}
                className={[
                  "shrink-0 px-2 py-1 text-[11px] rounded-md border transition-colors",
                  tag === t ? "border-zinc-300 text-zinc-100" : "border-zinc-800 text-zinc-500 hover:text-zinc-200",
                ].join(" ")}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      {error ? (
        <div className="text-xs text-rose-400">Couldn't load library: {error}</div>
      ) : !assets ? (
        <div className="text-xs text-zinc-500">Loading…</div>
      ) : assets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/50 p-10 text-center text-xs text-zinc-500">
          No assets {tag ? `tagged "${tag}"` : "yet"}. Run <code className="text-zinc-300">npm run upload-assets</code> to seed the library.
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2 max-h-[55vh] overflow-y-auto pr-1">
          {assets.map((a) => (
            <LibraryTile
              key={a.id}
              asset={a}
              picked={picked.has(a.id)}
              onToggle={() => toggle(a.id)}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
        <div className="text-[11px] text-zinc-500">
          {picked.size} selected{assets ? ` · ${assets.length} in library` : ""}
        </div>
        <button
          type="button"
          onClick={add}
          disabled={picked.size === 0}
          className="px-3 py-1.5 rounded-md bg-fuchsia-500 text-white text-xs font-medium hover:bg-fuchsia-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Add {picked.size > 0 ? `(${picked.size})` : ""}
        </button>
      </div>
    </div>
  );
}

type MediaAsset = {
  id: string;
  name: string;
  mime: string;
  size_bytes: number;
  tags: string[];
};

function LibraryTile({
  asset, picked, onToggle,
}: { asset: MediaAsset; picked: boolean; onToggle: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadThumb(asset.id).then((u) => { if (!cancelled) setUrl(u); }).catch(() => {});
    return () => { cancelled = true; };
  }, [asset.id]);
  return (
    <button
      type="button"
      onClick={onToggle}
      className={[
        "relative aspect-square rounded-md overflow-hidden bg-zinc-900 border transition-colors text-left",
        picked ? "border-fuchsia-400 ring-2 ring-fuchsia-400/40" : "border-zinc-800 hover:border-zinc-700",
      ].join(" ")}
      title={asset.name}
    >
      {url ? (
        <img src={url} className="size-full object-cover" />
      ) : (
        <div className="size-full" />
      )}
      <div className="absolute bottom-0 inset-x-0 px-1.5 py-1 bg-gradient-to-t from-black/80 to-transparent">
        <div className="text-[10px] text-zinc-200 truncate">{asset.name}</div>
      </div>
      {picked && (
        <div className="absolute top-1 right-1 size-5 rounded-full bg-fuchsia-500 text-white text-[10px] grid place-items-center font-semibold">
          ✓
        </div>
      )}
    </button>
  );
}

function RenameModal({
  open, initialName, onSave, onClose,
}: {
  open: boolean;
  initialName: string;
  onSave: (next: string) => void;
  onClose: () => void;
}) {
  const [val, setVal] = useState(initialName);
  useEffect(() => { if (open) setVal(initialName); }, [open, initialName]);
  return (
    <Modal
      open={open} onClose={onClose} title="Rename board"
      footer={
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!val.trim()}
            onClick={() => onSave(val.trim())}
          >
            Save
          </button>
        </div>
      }
    >
      <input className="input" autoFocus value={val} onChange={(e) => setVal(e.target.value)} />
    </Modal>
  );
}

