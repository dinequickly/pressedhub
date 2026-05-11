// Custom drag-and-drop canvas for vibe boards. Stitch-inspired dark surface.
//
// Interactions:
//   - Drag an item's header to move it.
//   - Double-click empty canvas to drop a note at the click point.
//   - Drag image files from your desktop onto the canvas to upload them
//     into the media library and pin them to the board as image items.

import { useEffect, useRef, useState } from "react";
import {
  LuFile, LuImage, LuStickyNote, LuTrash2, LuMessageSquare, LuUpload,
  LuChevronLeft, LuChevronRight, LuSend, LuPencil,
} from "react-icons/lu";
import { FaGoogle } from "react-icons/fa";
import {
  api,
  type Generation,
  type PromptAttachment,
  type PromptModel,
  type Stroke,
  type VibeBoardItem,
  type VibeBoardPromptItem,
  type VibeBoardState,
} from "../../../lib/api";
import { FN_URL } from "../../../lib/supabase";
import { uploadFileToMedia } from "../lib/uploadMedia";
import { loadThumb } from "../lib/thumbCache";

// Custom drag MIME for moving an existing media asset from one canvas
// element (image card / generation thumbnail) onto a prompt card. Payload
// is a JSON blob: { media_asset_id, name?, mime? }. Distinct from a file
// drop so handlers can disambiguate.
const ASSET_DRAG_MIME = "application/x-vibe-asset";

// Module-level mirror of the active asset drag. The browser hides
// dataTransfer values during dragover (privacy), and `types.includes`
// behaves inconsistently across browsers. We mirror the payload through
// window.__vibeAssetDrag on `dragstart` so drop targets across modules
// (Canvas + Board sidebar) read the same source. Cleared on dragend.
type AssetDragInflight = { media_asset_id: string; name?: string; mime?: string };
function getInflightAssetDrag(): AssetDragInflight | null {
  // deno-lint-ignore no-explicit-any
  return ((window as any).__vibeAssetDrag as AssetDragInflight | null) ?? null;
}
function startAssetDrag(payload: AssetDragInflight, e: React.DragEvent) {
  // deno-lint-ignore no-explicit-any
  (window as any).__vibeAssetDrag = payload;
  e.dataTransfer.setData(ASSET_DRAG_MIME, JSON.stringify(payload));
  e.dataTransfer.setData("text/plain", `vibe-asset:${payload.media_asset_id}`);
  e.dataTransfer.effectAllowed = "copy";
}
function clearAssetDrag() {
  // deno-lint-ignore no-explicit-any
  (window as any).__vibeAssetDrag = null;
}

// Resolve a DragEvent's payload into a list of image File objects. Handles
// three sources:
//   1. `dataTransfer.files` — real desktop file drops, including macOS
//      screenshot floating thumbnails.
//   2. `text/uri-list` — image dragged from another browser tab. We fetch
//      the URL and synthesize a File.
//   3. `text/html` — same, but extracted from an embedded <img src=...>.
//
// Returns an empty list if nothing image-like was found.
async function collectDroppedFiles(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  for (const f of Array.from(dt.files)) {
    if (f.type.startsWith("image/")) out.push(f);
  }
  if (out.length > 0) return out;

  const uri = dt.getData("text/uri-list") || dt.getData("text/plain");
  let candidate: string | null = null;
  if (uri && /^https?:\/\//i.test(uri.trim())) candidate = uri.trim().split("\n")[0];
  if (!candidate) {
    const html = dt.getData("text/html");
    const m = html?.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) candidate = m[1];
  }
  if (candidate) {
    try {
      const res = await fetch(candidate, { mode: "cors" });
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const blob = await res.blob();
      if (blob.type.startsWith("image/")) {
        const name = candidate.split("/").pop()?.split("?")[0] || "image.png";
        out.push(new File([blob], name, { type: blob.type }));
      }
    } catch (err) {
      console.warn("[drop] failed to fetch remote image:", err);
    }
  }
  return out;
}
import { AnnotationOverlay, AnnotationsThumbnail } from "./AnnotationOverlay";

export const CANVAS_W = 3200;
export const CANVAS_H = 2000;
const ITEM_W = 240;


export function Canvas({
  boardId, state, onChange, sessionId,
}: {
  boardId: string;
  state: VibeBoardState;
  /** Functional or absolute update. Use the functional form when patching
   *  an item — two near-simultaneous patches (e.g. two prompt cards' Send
   *  buttons completing within the same tick) would otherwise stale-closure
   *  on this `state` prop and the second would overwrite the first.
   *  The parent must implement functional-style state merging. */
  onChange: (next: VibeBoardState | ((prev: VibeBoardState) => VibeBoardState)) => void;
  /** Local session id bound to this board. Needed to fetch image bytes via
   *  the session-scoped file proxy. */
  sessionId: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<{ count: number; done: number } | null>(null);
  const dragCounter = useRef(0);

  // Cmd-V / Ctrl-V of a screenshot or image. The clipboard exposes image
  // bytes as files. We treat each as an upload + new image item near the
  // canvas's current scroll center.
  useEffect(() => {
    async function onPaste(e: ClipboardEvent) {
      // Only handle paste when the focus is inside this canvas (so we
      // don't hijack textarea paste of normal text).
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length === 0) return;
      e.preventDefault();
      const scroller = scrollRef.current;
      const cx = (scroller?.scrollLeft ?? 0) + (scroller?.clientWidth ?? 800) / 2;
      const cy = (scroller?.scrollTop ?? 0) + (scroller?.clientHeight ?? 600) / 2;
      setUploading({ count: files.length, done: 0 });
      const created: VibeBoardItem[] = [];
      for (let i = 0; i < files.length; i++) {
        try {
          const asset = await uploadFileToMedia(files[i]);
          created.push({
            id: `it_${Math.random().toString(36).slice(2, 10)}`,
            type: "image",
            x: Math.max(0, cx - ITEM_W / 2 + (i % 3) * (ITEM_W + 16)),
            y: Math.max(0, cy - 30 + Math.floor(i / 3) * 280),
            media_asset_id: asset.id,
            name: files[i].name || `pasted-${Date.now()}.png`,
          });
        } catch (err) {
          console.warn("[canvas] paste upload failed:", err);
        } finally {
          setUploading((s) => (s ? { ...s, done: s.done + 1 } : null));
        }
      }
      if (created.length > 0) bulkAdd(created);
      setTimeout(() => setUploading(null), 600);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);


  function patchItem(id: string, patch: Partial<VibeBoardItem>) {
    onChange((prev) => ({
      ...prev,
      items: prev.items.map((it) =>
        it.id === id ? ({ ...it, ...patch } as VibeBoardItem) : it,
      ),
    }));
  }
  function removeItem(id: string) {
    onChange((prev) => ({ ...prev, items: prev.items.filter((it) => it.id !== id) }));
  }
  function addItem(item: VibeBoardItem) {
    onChange((prev) => ({ ...prev, items: [...prev.items, item] }));
  }
  function bulkAdd(items: VibeBoardItem[]) {
    onChange((prev) => ({ ...prev, items: [...prev.items, ...items] }));
  }

  // Translate a screen-space mouse event into canvas-space coordinates.
  function pointToCanvas(clientX: number, clientY: number): { x: number; y: number } {
    const surface = surfaceRef.current;
    const scroller = scrollRef.current;
    if (!surface || !scroller) return { x: 0, y: 0 };
    const rect = surface.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  function onDoubleClick(e: React.MouseEvent) {
    // Only fire when the click lands on the empty surface, not on an item.
    if (e.target !== surfaceRef.current) return;
    const { x, y } = pointToCanvas(e.clientX, e.clientY);
    addItem({
      id: `it_${Math.random().toString(36).slice(2, 10)}`,
      type: "note",
      x: Math.max(0, x - ITEM_W / 2),
      y: Math.max(0, y - 30),
      text: "",
    });
  }

  // Drag-and-drop on the canvas. We always preventDefault during dragover
  // so the canvas is a valid drop target — browsers default to "no drop"
  // otherwise, and the `types`-based gating that used to live here was
  // unreliable across browsers (DOMStringList vs Array, Safari hiding types
  // until drop). Disambiguation happens at drop time.
  function isLikelyFileDrag(e: React.DragEvent): boolean {
    const types = Array.from(e.dataTransfer.types as ArrayLike<string>);
    return types.includes("Files");
  }
  function isInternalAssetDrag(e: React.DragEvent): boolean {
    if (getInflightAssetDrag()) return true;
    const types = Array.from(e.dataTransfer.types as ArrayLike<string>);
    return types.includes(ASSET_DRAG_MIME);
  }
  function onDragEnter(e: React.DragEvent) {
    // Internal asset drags don't create new canvas items — only prompt
    // cards consume them. Suppress the file-drop overlay for those.
    if (isInternalAssetDrag(e) && !isLikelyFileDrag(e)) return;
    e.preventDefault();
    dragCounter.current += 1;
    setDragging(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (isInternalAssetDrag(e) && !isLikelyFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onDragLeave(e: React.DragEvent) {
    if (isInternalAssetDrag(e) && !isLikelyFileDrag(e)) return;
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDragging(false);
  }
  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    // Source resolution, in priority order:
    //   1. dataTransfer.files — real files from Finder / screenshot float / etc.
    //   2. text/uri-list or src in text/html — image dragged from another tab
    //      (ChatGPT, browsing). We fetch and turn into a File.
    const files = await collectDroppedFiles(e.dataTransfer);
    if (files.length === 0) return;
    const drop = pointToCanvas(e.clientX, e.clientY);
    setUploading({ count: files.length, done: 0 });
    const created: VibeBoardItem[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const asset = await uploadFileToMedia(file);
        created.push({
          id: `it_${Math.random().toString(36).slice(2, 10)}`,
          type: "image",
          x: Math.max(0, drop.x - ITEM_W / 2 + (i % 3) * (ITEM_W + 16)),
          y: Math.max(0, drop.y - 30 + Math.floor(i / 3) * 280),
          // Reload-safe: store the asset id, resolve to bytes at render time.
          media_asset_id: asset.id,
          name: file.name,
        });
      } catch (err) {
        console.warn(`[canvas] upload of ${file.name} failed:`, err);
      } finally {
        setUploading((s) => (s ? { ...s, done: s.done + 1 } : null));
      }
    }
    if (created.length > 0) bulkAdd(created);
    setTimeout(() => setUploading(null), 600);
  }

  return (
    <div
      ref={scrollRef}
      className="relative bg-zinc-950 overflow-auto h-full"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        ref={surfaceRef}
        className="relative cursor-default"
        onDoubleClick={onDoubleClick}
        style={{
          width: CANVAS_W,
          height: CANVAS_H,
          backgroundImage: darkDotGrid,
          backgroundSize: "32px 32px",
        }}
      >
        {state.items.length === 0 && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <div className="text-center text-zinc-500 select-none">
              <div className="text-sm font-medium tracking-wide">Empty canvas</div>
              <div className="text-xs mt-1.5 text-zinc-600">
                Double-click to drop a note · drag images here · or use the toolbar
              </div>
            </div>
          </div>
        )}
        {state.items.map((item) => (
          <CanvasItem
            key={item.id}
            boardId={boardId}
            item={item}
            sessionId={sessionId}
            onMove={(x, y) => patchItem(item.id, { x, y })}
            onUpdate={(patch) => patchItem(item.id, patch)}
            onDelete={() => removeItem(item.id)}
          />
        ))}
      </div>

      <DropOverlay visible={dragging} />
      <UploadProgress upload={uploading} />
    </div>
  );
}

function DropOverlay({ visible }: { visible: boolean }) {
  return (
    <div
      className={[
        "pointer-events-none fixed inset-0 z-20 transition-opacity duration-200",
        visible ? "opacity-100" : "opacity-0",
      ].join(" ")}
    >
      {/* Soft fuchsia glow at the edges */}
      <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-500/10 via-transparent to-violet-500/10" />
      {/* Animated dotted border */}
      <div className="absolute inset-4 rounded-2xl border-2 border-dashed border-fuchsia-400/60 animate-pulse" />
      {/* Centered prompt */}
      <div className="absolute inset-0 grid place-items-center">
        <div className="rounded-2xl bg-zinc-900/95 border border-fuchsia-400/40 px-6 py-4 shadow-2xl flex items-center gap-3">
          <LuUpload className="size-5 text-fuchsia-400" />
          <div>
            <div className="text-sm font-medium text-zinc-100">Drop to add to board</div>
            <div className="text-[11px] text-zinc-400">Images upload to your media library</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function UploadProgress({ upload }: { upload: { count: number; done: number } | null }) {
  if (!upload) return null;
  const isDone = upload.done >= upload.count;
  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-30">
      <div className="rounded-xl bg-zinc-900/95 border border-zinc-800 px-3 py-2 shadow-lg flex items-center gap-2">
        <LuUpload className={["size-3.5 text-fuchsia-400", isDone ? "" : "animate-bounce"].join(" ")} />
        <div className="text-xs text-zinc-300 font-medium">
          {isDone ? "Done" : `Uploading ${upload.done + 1}/${upload.count}…`}
        </div>
      </div>
    </div>
  );
}

function CanvasItem({
  boardId, item, sessionId, onMove, onUpdate, onDelete,
}: {
  boardId: string;
  item: VibeBoardItem;
  sessionId: string | null;
  onMove: (x: number, y: number) => void;
  onUpdate: (patch: Partial<VibeBoardItem>) => void;
  onDelete: () => void;
}) {
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (!dragOffset) return;
    const offset = dragOffset;
    function onMouseMove(e: MouseEvent) {
      // Find the surface scroll container so positions account for scroll.
      const surface = (e.target as HTMLElement)?.closest(".relative") as HTMLElement | null;
      const scrollEl = surface?.parentElement;
      const rect = surface?.getBoundingClientRect();
      if (!rect) return;
      const scrollLeft = scrollEl?.scrollLeft ?? 0;
      const scrollTop = scrollEl?.scrollTop ?? 0;
      const x = e.clientX - rect.left + scrollLeft - offset.dx;
      const y = e.clientY - rect.top + scrollTop - offset.dy;
      onMove(Math.max(0, Math.min(CANVAS_W - ITEM_W, x)), Math.max(0, y));
    }
    function onMouseUp() { setDragOffset(null); }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragOffset, onMove]);

  const Icon = iconFor(item.type);
  const tint = tintFor(item.type);

  return (
    <div
      className="absolute bg-zinc-900 rounded-xl border border-zinc-800 shadow-xl shadow-black/40 hover:border-zinc-700 transition-colors"
      style={{ left: item.x, top: item.y, width: ITEM_W }}
    >
      <div
        className={`flex items-center gap-2 px-3 py-2 border-b border-zinc-800 cursor-move select-none ${dragOffset ? "bg-zinc-800" : ""}`}
        onMouseDown={(e) => {
          const card = (e.currentTarget.parentElement as HTMLElement);
          const rect = card.getBoundingClientRect();
          setDragOffset({ dx: e.clientX - rect.left, dy: e.clientY - rect.top });
        }}
      >
        <div className={`size-5 rounded-md bg-${tint}-500/15 text-${tint}-300 grid place-items-center`}>
          <Icon className="size-3" />
        </div>
        <div className="text-[11px] font-medium tracking-wide text-zinc-300 flex-1 truncate">
          {headerLabel(item)}
        </div>
        <button
          onClick={onDelete}
          className="text-zinc-500 hover:text-rose-400 transition-colors"
          title="Delete"
        >
          <LuTrash2 className="size-3.5" />
        </button>
      </div>
      <ItemBody boardId={boardId} item={item} sessionId={sessionId} onUpdate={onUpdate} />
    </div>
  );
}

function ItemBody({
  boardId, item, sessionId, onUpdate,
}: {
  boardId: string;
  item: VibeBoardItem;
  sessionId: string | null;
  onUpdate: (patch: Partial<VibeBoardItem>) => void;
}) {
  if (item.type === "image" || item.type === "reference") {
    return (
      <div className="p-2 space-y-2">
        <ImageBody
          item={item}
          sessionId={sessionId}
          annotations={item.annotations ?? []}
          onSaveAnnotations={(strokes) => onUpdate({ annotations: strokes })}
        />
        <input
          className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-fuchsia-400/50"
          placeholder="Describe this image"
          value={item.caption ?? ""}
          onChange={(e) => onUpdate({ caption: e.target.value })}
          onMouseDown={(e) => e.stopPropagation()}
        />
      </div>
    );
  }
  if (item.type === "prompt") {
    return <PromptBody boardId={boardId} item={item} onUpdate={onUpdate} />;
  }
  // note — sticky-note vibe, warm fill
  return (
    <div className="p-2">
      <textarea
        className="w-full rounded-md px-2 py-1.5 text-xs min-h-[60px] resize-none bg-amber-200/10 border border-amber-300/20 text-amber-100 placeholder:text-amber-200/30 focus:outline-none focus:border-amber-300/50"
        placeholder="Note to self / agent…"
        value={item.text}
        onChange={(e) => onUpdate({ text: e.target.value })}
        autoFocus={item.text === ""}
      />
    </div>
  );
}

// Prompt card — three stacked sections: generation viewer (if any),
// model switcher + Send button row, and the prompt textarea.
function PromptBody({
  boardId, item, onUpdate,
}: {
  boardId: string;
  item: VibeBoardPromptItem;
  onUpdate: (patch: Partial<VibeBoardItem>) => void;
}) {
  // Normalize legacy persisted values: a bare "gemini" maps to gemini-fast.
  const persisted = item.model;
  const activeModel: PromptModel =
    persisted === "openai" ? "openai" :
    persisted === "gemini-quality" ? "gemini-quality" :
    "gemini-fast";
  const generations = item.generations ?? [];
  const idxRaw = item.current_generation_idx ?? generations.length - 1;
  const idx = Math.max(0, Math.min(generations.length - 1, idxRaw));
  const hasGens = generations.length > 0;
  const attachments = item.attachments ?? [];

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachDragging, setAttachDragging] = useState(false);
  const attachDragCounter = useRef(0);
  const errorTimer = useRef<number | null>(null);

  function flashError(msg: string) {
    setError(msg);
    if (errorTimer.current) window.clearTimeout(errorTimer.current);
    errorTimer.current = window.setTimeout(() => setError(null), 5000);
  }
  useEffect(() => () => {
    if (errorTimer.current) window.clearTimeout(errorTimer.current);
  }, []);

  async function onSend() {
    const text = item.text.trim();
    if (!text || loading) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await api.post<{ generations: Generation[] }>(
        `/vibe-boards/${boardId}/generate`,
        {
          prompt: text,
          model: activeModel,
          n: 1,
          attachments: attachments.map((a) => a.media_asset_id),
        },
      );
      const next = [...generations, ...(resp.generations ?? [])];
      onUpdate({ generations: next, current_generation_idx: next.length - 1 });
    } catch (err) {
      flashError((err as Error).message ?? "Generation failed");
    } finally {
      setLoading(false);
    }
  }

  // Drop handlers for attaching reference images to this prompt card.
  // Stop propagation so the canvas-level drop handler (which would create
  // a new image item on the board) doesn't also fire.
  // The prompt card accepts two kinds of drops:
  //   1. files from desktop → upload, then attach
  //   2. an existing media asset dragged from another canvas card →
  //      attach by media_asset_id, no upload needed
  //
  // Use the module-level inflight mirror for internal drags — browsers hide
  // `dataTransfer` values during dragover and `types` enumeration is flaky
  // across vendors. The mirror is set on dragstart, read synchronously.
  function isAcceptedDrag(e: React.DragEvent): boolean {
    if (getInflightAssetDrag()) return true;
    const types = Array.from(e.dataTransfer.types as ArrayLike<string>);
    return types.includes("Files");
  }
  // We always preventDefault on the prompt card's dragover so the browser
  // marks it as a valid drop target. Gating dragover by `isAcceptedDrag`
  // was unreliable — `dataTransfer.types` is hidden in some browsers
  // during the drag, which meant the drop never fired. We disambiguate at
  // drop time instead.
  function onAttachDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    attachDragCounter.current += 1;
    setAttachDragging(true);
  }
  function onAttachDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }
  function onAttachDragLeave(e: React.DragEvent) {
    e.stopPropagation();
    attachDragCounter.current = Math.max(0, attachDragCounter.current - 1);
    if (attachDragCounter.current === 0) setAttachDragging(false);
  }
  async function onAttachDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    attachDragCounter.current = 0;
    setAttachDragging(false);

    // Internal asset drag wins over a file drop if both are present.
    // Try dataTransfer first; fall back to the module-level mirror, which
    // is the only reliable source across Chromium + Firefox + Safari.
    let asset: { media_asset_id: string; name?: string; mime?: string } | null = null;
    const raw = e.dataTransfer.getData(ASSET_DRAG_MIME);
    if (raw) {
      try { asset = JSON.parse(raw); } catch { /* fall through */ }
    }
    if (!asset) asset = getInflightAssetDrag();
    if (asset?.media_asset_id) {
      clearAssetDrag();
      if (attachments.some((a) => a.media_asset_id === asset!.media_asset_id)) return;
      onUpdate({
        attachments: [...attachments, {
          id: `att_${Math.random().toString(36).slice(2, 10)}`,
          media_asset_id: asset.media_asset_id,
          name: asset.name ?? "attached",
          mime: asset.mime ?? "image/*",
        }],
      });
      return;
    }

    // Otherwise: file drop from desktop, or an image URL dragged from another
    // tab (resolved via collectDroppedFiles).
    const files = await collectDroppedFiles(e.dataTransfer);
    if (files.length === 0) return;
    const fresh: PromptAttachment[] = [];
    for (const file of files) {
      try {
        const asset = await uploadFileToMedia(file);
        fresh.push({
          id: `att_${Math.random().toString(36).slice(2, 10)}`,
          media_asset_id: asset.id,
          name: file.name,
          mime: file.type,
        });
      } catch (err) {
        flashError(`Couldn't attach ${file.name}: ${(err as Error).message}`);
      }
    }
    if (fresh.length > 0) {
      onUpdate({ attachments: [...attachments, ...fresh] });
    }
  }
  function removeAttachment(attId: string) {
    onUpdate({ attachments: attachments.filter((a) => a.id !== attId) });
  }

  function navPrev() {
    if (idx > 0) onUpdate({ current_generation_idx: idx - 1 });
  }
  function navNext() {
    if (idx < generations.length - 1) onUpdate({ current_generation_idx: idx + 1 });
  }

  // ⌘Z / ⌘⇧Z navigates the generation history. Only intercept when there's
  // somewhere to navigate to — otherwise let the browser deliver native undo
  // to the textarea.
  function onCardKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta || e.key.toLowerCase() !== "z") return;
    if (generations.length <= 1) return;
    if (e.shiftKey) {
      if (idx >= generations.length - 1) return;
      e.preventDefault();
      onUpdate({ current_generation_idx: idx + 1 });
    } else {
      if (idx <= 0) return;
      e.preventDefault();
      onUpdate({ current_generation_idx: idx - 1 });
    }
  }

  return (
    <div
      className={[
        "p-2 flex flex-col gap-1.5 relative rounded-md transition-colors",
        attachDragging ? "ring-1 ring-sky-400/60 bg-sky-500/5" : "",
      ].join(" ")}
      onKeyDown={onCardKeyDown}
      onDragEnter={onAttachDragEnter}
      onDragOver={onAttachDragOver}
      onDragLeave={onAttachDragLeave}
      onDrop={onAttachDrop}
    >
      {hasGens && (
        <GenerationViewer
          generation={generations[idx]}
          idx={idx}
          total={generations.length}
          promptText={item.text}
          onPrev={navPrev}
          onNext={navNext}
          onSaveAnnotations={(strokes) => {
            // Replace strokes on the active generation only.
            const next = generations.map((g, i) =>
              i === idx ? { ...g, annotations: strokes } : g);
            onUpdate({ generations: next });
          }}
        />
      )}
      {attachments.length > 0 && (
        <AttachmentsStrip
          attachments={attachments}
          onRemove={removeAttachment}
        />
      )}
      <div className="flex items-center gap-1.5">
        <ModelSelector active={activeModel} onChange={(m) => onUpdate({ model: m })} />
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onSend}
          disabled={loading || !item.text.trim()}
          className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-sky-500/15 text-sky-200 hover:bg-sky-500/25 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? (
            <>
              <span className="size-3 rounded-full border border-sky-200/40 border-t-sky-200 animate-spin" />
              Sending…
            </>
          ) : (
            <>
              <LuSend className="size-3" />
              Send
            </>
          )}
        </button>
      </div>
      {error && (
        <div className="text-[11px] text-rose-400 leading-tight">{error}</div>
      )}
      <textarea
        className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-sky-400/50 min-h-[80px] resize-none"
        placeholder={attachments.length > 0
          ? "Describe what to do with these images…"
          : "Prompt text · drop images to attach"}
        value={item.text}
        onChange={(e) => onUpdate({ text: e.target.value })}
        // Stop the textarea from absorbing internal asset/file drops as
        // text input. Browsers default-accept drops on textareas, which
        // would mean the prompt-card-level drop handler never fires.
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onAttachDrop(e);
        }}
      />
      {attachDragging && (
        // pointer-events-auto so the overlay swallows drops directly,
        // bypassing the textarea's native text-drop handling entirely.
        <div
          className="absolute inset-0 rounded-md border-2 border-dashed border-sky-300/70 bg-sky-500/10 grid place-items-center"
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDrop={(e) => {
            e.preventDefault();
            onAttachDrop(e);
          }}
        >
          <div className="text-[11px] font-medium text-sky-100 pointer-events-none">Drop to attach</div>
        </div>
      )}
    </div>
  );
}

// Three-way model picker on prompt cards: Fast / Quality (both Gemini, with
// Google glyph) and the implicit OpenAI fallback the agent can still pick.
// We expose only Fast / Quality on the prompt card UI per spec; OpenAI is
// reachable through chat with the Director.
function ModelSelector({
  active, onChange,
}: { active: PromptModel; onChange: (m: PromptModel) => void }) {
  const options: Array<{ key: PromptModel; label: string }> = [
    { key: "gemini-fast", label: "Fast" },
    { key: "gemini-quality", label: "Quality" },
  ];
  return (
    <div className="flex">
      {options.map((opt) => {
        const isActive = active === opt.key || (opt.key === "gemini-fast" && active === "openai");
        // The "Fast" tile is highlighted when active === "openai" only because
        // we want a visible default selection; tapping a tile commits the value.
        return (
          <button
            key={opt.key}
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => onChange(opt.key)}
            className={[
              "inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium tracking-wide border border-zinc-800 first:rounded-l-md last:rounded-r-md -ml-px first:ml-0 transition-colors",
              active === opt.key
                ? "bg-zinc-100 text-black border-zinc-100 z-10"
                : "bg-transparent text-zinc-400 hover:text-zinc-100 hover:border-zinc-700",
            ].join(" ")}
          >
            <FaGoogle className="size-2.5" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// Horizontal scrolling strip of attached reference images. Each chip is a
// small thumbnail with a remove (×) button on hover.
function AttachmentsStrip({
  attachments, onRemove,
}: { attachments: PromptAttachment[]; onRemove: (id: string) => void }) {
  return (
    <div
      className="flex gap-1.5 overflow-x-auto pb-1"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {attachments.map((a) => (
        <AttachmentChip key={a.id} attachment={a} onRemove={() => onRemove(a.id)} />
      ))}
    </div>
  );
}

function AttachmentChip({
  attachment, onRemove,
}: { attachment: PromptAttachment; onRemove: () => void }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadThumb(attachment.media_asset_id).then((u) => { if (!cancelled) setBlobUrl(u); }).catch(() => {});
    return () => { cancelled = true; };
  }, [attachment.media_asset_id]);
  return (
    <div className="relative shrink-0 size-12 rounded-md overflow-hidden border border-zinc-800 bg-zinc-950 group">
      {blobUrl ? (
        <img src={blobUrl} className="size-full object-cover" />
      ) : (
        <div className="size-full grid place-items-center text-[9px] text-zinc-600">…</div>
      )}
      <button
        type="button"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={onRemove}
        className="absolute top-0 right-0 size-4 grid place-items-center bg-black/70 text-zinc-300 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity rounded-bl-md"
        title={`Remove ${attachment.name}`}
      >
        ×
      </button>
    </div>
  );
}

// Square viewer for a single Generation. Loads the image bytes via the
// auth-protected /media/:id/content endpoint and turns them into a blob URL,
// re-fetching when the active generation changes. Bottom-right: tiny prev /
// counter / next pill.
function GenerationViewer({
  generation, idx, total, promptText, onPrev, onNext, onSaveAnnotations,
}: {
  generation: Generation;
  idx: number;
  total: number;
  /** Prompt text for the parent prompt card; used as the annotator title. */
  promptText: string;
  onPrev: () => void;
  onNext: () => void;
  onSaveAnnotations: (strokes: Stroke[]) => void;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const annotations = generation.annotations ?? [];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setBlobUrl(null);
    loadThumb(generation.media_asset_id)
      .then((u) => { if (!cancelled) setBlobUrl(u); })
      .catch(() => { if (!cancelled) setBlobUrl(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [generation.media_asset_id]);

  const overlayTitle = promptText.trim()
    ? `${promptText.trim()} · gen ${idx + 1}`
    : `gen ${idx + 1}`;

  return (
    <div className="relative">
      {blobUrl ? (
        <div
          className="relative w-full rounded-md overflow-hidden bg-zinc-950 group"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <img
            src={blobUrl}
            className="w-full object-cover aspect-square block cursor-grab active:cursor-grabbing"
            draggable
            onDragStart={(e) => {
              e.stopPropagation();
              startAssetDrag({
                media_asset_id: generation.media_asset_id,
                name: `gen ${idx + 1}`,
                mime: "image/png",
              }, e);
            }}
            onDragEnd={() => clearAssetDrag()}
            onLoad={(e) => {
              const el = e.currentTarget;
              setNatural({ w: el.naturalWidth || 1, h: el.naturalHeight || 1 });
            }}
          />
          {annotations.length > 0 && (
            <AnnotationsThumbnail
              strokes={annotations}
              naturalWidth={natural?.w}
              naturalHeight={natural?.h}
            />
          )}
          <EditPenButton onClick={() => setOverlayOpen(true)} />
        </div>
      ) : (
        <div className="aspect-square bg-zinc-950 rounded-md grid place-items-center text-[11px] text-zinc-500">
          {loading ? "loading…" : "(image unavailable)"}
        </div>
      )}
      {overlayOpen && blobUrl && (
        <AnnotationOverlay
          src={blobUrl}
          title={overlayTitle}
          initial={annotations}
          onSave={(strokes) => { onSaveAnnotations(strokes); setOverlayOpen(false); }}
          onClose={() => setOverlayOpen(false)}
        />
      )}
      <div
        className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 rounded-md bg-black/70 backdrop-blur-sm border border-white/10 px-1 py-0.5 text-[10px] text-zinc-200"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onPrev}
          disabled={idx <= 0}
          className="px-1 py-0.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
          title="Previous (⌘Z)"
        >
          <LuChevronLeft className="size-3" />
        </button>
        <span className="px-1 tabular-nums select-none">{idx + 1} / {total}</span>
        <button
          type="button"
          onClick={onNext}
          disabled={idx >= total - 1}
          className="px-1 py-0.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
          title="Next (⌘⇧Z)"
        >
          <LuChevronRight className="size-3" />
        </button>
      </div>
    </div>
  );
}

// Renders an image card. We have three source flavors:
//   1. `url` pointing at our own /media/:id/content endpoint — needs auth, so
//      we fetch via api.getRaw and turn into a blob URL just like (3).
//   2. `url` pointing at any other origin (signed CDN, public URL) — used
//      directly as <img src>.
//   3. `anthropic_file_id` — resolved via the session-scoped file proxy and
//      cached as a blob URL.
function ImageBody({
  item, sessionId, annotations, onSaveAnnotations,
}: {
  item: VibeBoardItem;
  sessionId: string | null;
  annotations: Stroke[];
  onSaveAnnotations: (strokes: Stroke[]) => void;
}) {
  const fileId = "anthropic_file_id" in item ? item.anthropic_file_id : undefined;
  const mediaId = "media_asset_id" in item ? item.media_asset_id : undefined;
  const directUrl = "url" in item ? item.url : undefined;
  // Legacy: an item that stores a full FN_URL/media/... string. We strip the
  // prefix and route through the auth path so older boards keep rendering.
  const isLegacyMediaUrl = !!directUrl && directUrl.startsWith(`${FN_URL}/media/`);
  const passthroughUrl = isLegacyMediaUrl ? undefined : directUrl;
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  // Natural pixel size of the underlying image, captured on first render.
  // Used as the viewBox basis for the thumbnail annotation overlay so the
  // strokes line up exactly with the pixels they were drawn against.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    if (passthroughUrl) return;
    // Source priority: media_asset_id (cached + throttled) → legacy url
    // → anthropic file via session (one-off, less common).
    let cancelled = false;
    let madeUrl: string | null = null;
    setLoading(true);
    const finish = (u: string | null) => {
      if (cancelled) return;
      setBlobUrl(u);
      setLoading(false);
    };
    if (mediaId) {
      loadThumb(mediaId)
        .then(finish)
        .catch(() => finish(null));
    } else {
      const path = (isLegacyMediaUrl && directUrl)
        ? directUrl.slice(FN_URL.length)
        : (fileId && sessionId) ? `/sessions/${sessionId}/files/${fileId}` : null;
      if (!path) { setLoading(false); return; }
      api.getRaw(path)
        .then((r) => r.blob())
        .then((b) => {
          if (cancelled) return;
          madeUrl = URL.createObjectURL(b);
          finish(madeUrl);
        })
        .catch(() => finish(null));
    }
    return () => {
      cancelled = true;
      if (madeUrl) URL.revokeObjectURL(madeUrl);
    };
  }, [mediaId, fileId, sessionId, passthroughUrl, isLegacyMediaUrl, directUrl]);

  const src = passthroughUrl ?? blobUrl;
  // Asset drag — if this image has a media_asset_id, the user can drag it
  // onto a prompt card to attach it as a reference. We only enable when we
  // know the id; agent-only Anthropic-file images aren't draggable yet.
  const draggable = !!mediaId;
  const dragName = ("name" in item && item.name) ? item.name :
    ("caption" in item && item.caption) ? item.caption : undefined;
  // Title shown in the annotator's top bar when this image is opened.
  const overlayTitle =
    ("name" in item && item.name) ? item.name :
    ("caption" in item && item.caption) ? item.caption :
    ("prompt" in item && item.prompt) ? item.prompt :
    item.type === "reference" ? "REFERENCE" : "IMAGE";

  if (src) {
    return (
      <>
        <div
          className="relative w-full rounded-md overflow-hidden bg-zinc-950 group"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <img
            src={src}
            className={[
              "w-full object-cover aspect-square block",
              draggable ? "cursor-grab active:cursor-grabbing" : "",
            ].join(" ")}
            draggable={draggable}
            onDragStart={draggable
              ? (e) => {
                e.stopPropagation();
                startAssetDrag(
                  { media_asset_id: mediaId!, name: dragName, mime: "image/*" },
                  e,
                );
              }
              : undefined}
            onDragEnd={() => clearAssetDrag()}
            onLoad={(e) => {
              const el = e.currentTarget;
              setNatural({ w: el.naturalWidth || 1, h: el.naturalHeight || 1 });
            }}
          />
          {annotations.length > 0 && (
            <AnnotationsThumbnail
              strokes={annotations}
              naturalWidth={natural?.w}
              naturalHeight={natural?.h}
            />
          )}
          <EditPenButton onClick={() => setOverlayOpen(true)} />
        </div>
        {overlayOpen && (
          <AnnotationOverlay
            src={src}
            title={overlayTitle}
            initial={annotations}
            onSave={(strokes) => { onSaveAnnotations(strokes); setOverlayOpen(false); }}
            onClose={() => setOverlayOpen(false)}
          />
        )}
      </>
    );
  }
  if (loading) {
    return (
      <div className="aspect-square bg-zinc-950 rounded-md grid place-items-center text-[11px] text-zinc-500">
        loading…
      </div>
    );
  }
  if (fileId && !sessionId) {
    return (
      <div className="aspect-square bg-zinc-950 rounded-md grid place-items-center text-[11px] text-zinc-500 px-2 text-center">
        Start a Director chat to view generated images.
      </div>
    );
  }
  return (
    <div className="aspect-square bg-zinc-950 rounded-md grid place-items-center text-[11px] text-zinc-500">
      (no image yet)
    </div>
  );
}

// Small "edit/annotate" button overlaid on image thumbnails. Opens the
// full-screen pen-annotation overlay. Lives in the top-right corner; only
// appears on hover so it doesn't clutter the image when not needed.
// Click-only (no mouse-down side effects) so the underlying image stays
// freely draggable.
function EditPenButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="absolute top-1.5 right-1.5 size-6 grid place-items-center rounded-md bg-black/70 backdrop-blur-sm border border-white/10 text-zinc-200 opacity-0 group-hover:opacity-100 hover:bg-black/85 hover:text-white transition-opacity"
      title="Annotate"
    >
      <LuPencil className="size-3" />
    </button>
  );
}

function iconFor(type: VibeBoardItem["type"]) {
  if (type === "image") return LuImage;
  if (type === "reference") return LuFile;
  if (type === "prompt") return LuMessageSquare;
  return LuStickyNote;
}
// Header label for a card. Image cards prefer their stored filename; falls
// back to the type name in uppercase for everything else.
function headerLabel(item: VibeBoardItem): string {
  if (item.type === "image" || item.type === "reference") {
    const name = ("name" in item && item.name) ? item.name : null;
    if (name) return name;
    return item.type === "reference" ? "REFERENCE" : "IMAGE";
  }
  return item.type.toUpperCase();
}
function tintFor(type: VibeBoardItem["type"]) {
  if (type === "image") return "fuchsia";
  if (type === "reference") return "violet";
  if (type === "prompt") return "sky";
  return "amber";
}

const darkDotGrid =
  "radial-gradient(circle, rgba(244,114,182,0.05) 1px, transparent 1px), radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)";
