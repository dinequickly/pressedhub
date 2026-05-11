// Custom drag-and-drop canvas for vibe boards. Clean light surface.
//
// Interactions:
//   - Drag an item's header to move it.
//   - Drag empty board space to pan around.
//   - Scroll on the board to zoom in/out around the cursor.
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
  type VibeBoardNoteItem,
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

  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && file.type.startsWith("image/")) out.push(file);
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

const ITEM_W = 240;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;


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
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<{ count: number; done: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panDrag, setPanDrag] = useState<{
    clientX: number;
    clientY: number;
    startPanX: number;
    startPanY: number;
  } | null>(null);
  const dragCounter = useRef(0);
  const uploadErrorTimer = useRef<number | null>(null);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  useEffect(() => () => {
    if (uploadErrorTimer.current) window.clearTimeout(uploadErrorTimer.current);
  }, []);

  // Center the viewport on existing items the first time they show up, so a
  // reopened board doesn't start staring into an empty patch of canvas.
  const didInitialCenter = useRef(false);
  useEffect(() => {
    if (didInitialCenter.current) return;
    if (state.items.length === 0) return;
    const viewport = scrollRef.current;
    if (!viewport) return;
    didInitialCenter.current = true;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of state.items) {
      minX = Math.min(minX, it.x);
      minY = Math.min(minY, it.y);
      maxX = Math.max(maxX, it.x + ITEM_W);
      maxY = Math.max(maxY, it.y + ITEM_W);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setPan({
      x: viewport.clientWidth / 2 - cx,
      y: viewport.clientHeight / 2 - cy,
    });
  }, [state.items]);

  function flashUploadError(message: string) {
    setUploadError(message);
    if (uploadErrorTimer.current) window.clearTimeout(uploadErrorTimer.current);
    uploadErrorTimer.current = window.setTimeout(() => setUploadError(null), 5000);
  }

  useEffect(() => {
    if (!panDrag) return;
    const drag = panDrag;
    function onMouseMove(e: MouseEvent) {
      const dx = e.clientX - drag.clientX;
      const dy = e.clientY - drag.clientY;
      setPan({ x: drag.startPanX + dx, y: drag.startPanY + dy });
    }
    function onMouseUp() {
      setPanDrag(null);
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [panDrag]);

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
      const viewport = scrollRef.current;
      const currentZoom = zoomRef.current;
      const cur = panRef.current;
      const w = viewport?.clientWidth ?? 800;
      const h = viewport?.clientHeight ?? 600;
      const cx = (w / 2 - cur.x) / currentZoom;
      const cy = (h / 2 - cur.y) / currentZoom;
      setUploading({ count: files.length, done: 0 });
      const created: VibeBoardItem[] = [];
      for (let i = 0; i < files.length; i++) {
        try {
          const asset = await uploadFileToMedia(files[i], {
            source_kind: "board_upload",
            collection_key: "board-uploads",
            board_id: boardId,
          });
          created.push({
            id: `it_${Math.random().toString(36).slice(2, 10)}`,
            type: "image",
            x: cx - ITEM_W / 2 + (i % 3) * (ITEM_W + 16),
            y: cy - 30 + Math.floor(i / 3) * 280,
            media_asset_id: asset.id,
            name: files[i].name || `pasted-${Date.now()}.png`,
          });
        } catch (err) {
          console.warn("[canvas] paste upload failed:", err);
          flashUploadError(`Couldn't upload ${files[i].name || "pasted image"}. ${(err as Error).message}`);
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
    const currentZoom = zoomRef.current;
    if (!surface) return { x: 0, y: 0 };
    const rect = surface.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / currentZoom,
      y: (clientY - rect.top) / currentZoom,
    };
  }

  function onViewportMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    if (e.target !== scrollRef.current) return;
    setPanDrag({
      clientX: e.clientX,
      clientY: e.clientY,
      startPanX: panRef.current.x,
      startPanY: panRef.current.y,
    });
  }

  function onWheelZoom(e: React.WheelEvent) {
    const target = e.target as HTMLElement | null;
    if (target?.closest("textarea, input, button")) return;
    const viewport = scrollRef.current;
    if (!viewport) return;
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const pointerX = e.clientX - rect.left;
    const pointerY = e.clientY - rect.top;
    const oldZoom = zoomRef.current;
    const nextZoom = Math.max(
      MIN_ZOOM,
      Math.min(MAX_ZOOM, oldZoom * Math.exp(-e.deltaY * 0.0015)),
    );
    if (Math.abs(nextZoom - oldZoom) < 0.001) return;
    const cur = panRef.current;
    const contentX = (pointerX - cur.x) / oldZoom;
    const contentY = (pointerY - cur.y) / oldZoom;
    setZoom(nextZoom);
    setPan({
      x: pointerX - contentX * nextZoom,
      y: pointerY - contentY * nextZoom,
    });
  }

  function onDoubleClick(e: React.MouseEvent) {
    if (e.target !== scrollRef.current) return;
    const { x, y } = pointToCanvas(e.clientX, e.clientY);
    addItem({
      id: `it_${Math.random().toString(36).slice(2, 10)}`,
      type: "note",
      x: x - ITEM_W / 2,
      y: y - 30,
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
        const asset = await uploadFileToMedia(file, {
          source_kind: "board_upload",
          collection_key: "board-uploads",
          board_id: boardId,
        });
        created.push({
          id: `it_${Math.random().toString(36).slice(2, 10)}`,
          type: "image",
          x: drop.x - ITEM_W / 2 + (i % 3) * (ITEM_W + 16),
          y: drop.y - 30 + Math.floor(i / 3) * 280,
          // Reload-safe: store the asset id, resolve to bytes at render time.
          media_asset_id: asset.id,
          name: file.name,
        });
      } catch (err) {
        console.warn(`[canvas] upload of ${file.name} failed:`, err);
        flashUploadError(`Couldn't upload ${file.name || "dropped image"}. ${(err as Error).message}`);
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
      className={[
        "relative bg-zinc-100 overflow-hidden h-full",
        panDrag ? "cursor-grabbing select-none" : "cursor-grab",
      ].join(" ")}
      style={{
        backgroundImage: lightDotGrid,
        backgroundSize: `${32 * zoom}px ${32 * zoom}px`,
        backgroundPosition: `${pan.x}px ${pan.y}px`,
      }}
      onMouseDown={onViewportMouseDown}
      onDoubleClick={onDoubleClick}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onWheel={onWheelZoom}
    >
      <div
        ref={surfaceRef}
        className="absolute top-0 left-0 origin-top-left"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        {state.items.map((item) => (
          <CanvasItem
            key={item.id}
            boardId={boardId}
            item={item}
            sessionId={sessionId}
            zoom={zoom}
            surfaceRef={surfaceRef}
            onMove={(x, y) => patchItem(item.id, { x, y })}
            onUpdate={(patch) => patchItem(item.id, patch)}
            onDelete={() => removeItem(item.id)}
          />
        ))}
      </div>

      {state.items.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-center text-gray-400 select-none">
            <div className="text-sm font-medium tracking-wide">Empty canvas</div>
            <div className="text-xs mt-1.5 text-gray-400">
              Drag to pan · scroll to zoom · double-click to drop a note
            </div>
          </div>
        </div>
      )}

      <DropOverlay visible={dragging} />
      <UploadProgress upload={uploading} />
      <UploadErrorBanner error={uploadError} />
      <Minimap
        items={state.items}
        pan={pan}
        zoom={zoom}
        viewportRef={scrollRef}
        onNavigate={setPan}
      />
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
      <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-100/60 via-transparent to-violet-100/60" />
      {/* Animated dotted border */}
      <div className="absolute inset-4 rounded-2xl border-2 border-dashed border-fuchsia-400/60 animate-pulse" />
      {/* Centered prompt */}
      <div className="absolute inset-0 grid place-items-center">
        <div className="rounded-2xl bg-white/90 border border-fuchsia-300/60 px-6 py-4 shadow-2xl shadow-gray-200 flex items-center gap-3">
          <LuUpload className="size-5 text-fuchsia-500" />
          <div>
            <div className="text-sm font-medium text-gray-900">Drop to add to board</div>
            <div className="text-[11px] text-gray-500">Images upload to your media library</div>
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
      <div className="rounded-xl bg-white/95 border border-gray-200 px-3 py-2 shadow-lg shadow-gray-200 flex items-center gap-2">
        <LuUpload className={["size-3.5 text-fuchsia-500", isDone ? "" : "animate-bounce"].join(" ")} />
        <div className="text-xs text-gray-700 font-medium">
          {isDone ? "Done" : `Uploading ${upload.done + 1}/${upload.count}…`}
        </div>
      </div>
    </div>
  );
}

function UploadErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="pointer-events-none absolute top-4 right-4 z-30 max-w-sm">
      <div className="rounded-xl border border-rose-300/50 bg-white/95 px-3 py-2 shadow-lg shadow-gray-200">
        <div className="text-xs font-medium text-rose-600">Upload failed</div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-rose-500/90">{error}</div>
      </div>
    </div>
  );
}

function CanvasItem({
  boardId, item, sessionId, zoom, surfaceRef, onMove, onUpdate, onDelete,
}: {
  boardId: string;
  item: VibeBoardItem;
  sessionId: string | null;
  zoom: number;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
  onMove: (x: number, y: number) => void;
  onUpdate: (patch: Partial<VibeBoardItem>) => void;
  onDelete: () => void;
}) {
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (!dragOffset) return;
    const offset = dragOffset;
    function onMouseMove(e: MouseEvent) {
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = (e.clientX - rect.left) / zoom - offset.dx;
      const y = (e.clientY - rect.top) / zoom - offset.dy;
      onMove(x, y);
    }
    function onMouseUp() { setDragOffset(null); }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragOffset, onMove, surfaceRef, zoom]);

  const Icon = iconFor(item.type);
  const tint = tintFor(item.type);
  const hoverChrome = usesHoverChrome(item.type);
  const cardClassName = hoverChrome
    ? [
      "absolute group rounded-xl overflow-hidden border transition-[background-color,border-color,box-shadow]",
      dragOffset
        ? "bg-white border-gray-300 shadow-xl shadow-gray-200/60"
        : "bg-transparent border-transparent shadow-none hover:border-gray-300 hover:shadow-xl hover:shadow-gray-200/60 focus-within:border-gray-300 focus-within:shadow-xl focus-within:shadow-gray-200/60",
    ].join(" ")
    : "absolute group bg-white rounded-xl border border-gray-200 shadow-xl shadow-gray-200/60 hover:border-gray-300 transition-colors";
  const headerClassName = [
    hoverChrome
      ? "absolute inset-x-0 top-0 z-10 flex items-center gap-2 px-3 py-2 cursor-move select-none transition-all"
      : "flex items-center gap-2 px-3 py-2 cursor-move select-none transition-colors",
    hoverChrome
      ? dragOffset
        ? "border-b border-gray-200 bg-white/92 backdrop-blur-sm opacity-100"
        : "border-b border-transparent bg-white/88 backdrop-blur-sm opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-hover:border-gray-200 group-focus-within:opacity-100 group-focus-within:pointer-events-auto group-focus-within:border-gray-200"
      : dragOffset
        ? "border-b border-gray-200 bg-gray-100"
        : "border-b border-gray-200",
  ].join(" ");

  return (
    <div
      className={cardClassName}
      style={{ left: item.x, top: item.y, width: ITEM_W }}
    >
      <div
        className={headerClassName}
        onMouseDown={(e) => {
          const target = e.target as HTMLElement | null;
          if (target?.closest("button, input, textarea")) return;
          const card = (e.currentTarget.parentElement as HTMLElement);
          const rect = card.getBoundingClientRect();
          setDragOffset({
            dx: (e.clientX - rect.left) / zoom,
            dy: (e.clientY - rect.top) / zoom,
          });
        }}
      >
        <div className={`size-5 rounded-md bg-${tint}-50 text-${tint}-600 grid place-items-center`}>
          <Icon className="size-3" />
        </div>
        <div className="text-[11px] font-medium tracking-wide text-gray-500 flex-1 truncate">
          {headerLabel(item)}
        </div>
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="text-gray-400 hover:text-rose-500 transition-colors"
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
      <div className="relative">
        <ImageBody
          item={item}
          sessionId={sessionId}
          annotations={item.annotations ?? []}
          onSaveAnnotations={(strokes) => onUpdate({ annotations: strokes })}
        />
        <div className="pointer-events-none absolute inset-x-2 bottom-2 opacity-0 transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
          <input
            className="w-full rounded-md border border-black/10 bg-white/80 px-2 py-1 text-[11px] text-gray-900 placeholder:text-gray-400 backdrop-blur-sm focus:outline-none focus:border-fuchsia-400/50"
            placeholder="Describe this image"
            value={item.caption ?? ""}
            onChange={(e) => onUpdate({ caption: e.target.value })}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </div>
      </div>
    );
  }
  if (item.type === "prompt") {
    return <PromptBody boardId={boardId} item={item} onUpdate={onUpdate} />;
  }
  // note — sticky-note vibe, warm fill. Height auto-fits the text length.
  return <NoteBody item={item} onUpdate={onUpdate} />;
}

function NoteBody({
  item, onUpdate,
}: {
  item: VibeBoardNoteItem;
  onUpdate: (patch: Partial<VibeBoardItem>) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [item.text]);
  return (
    <div className="p-2">
      <textarea
        ref={ref}
        rows={1}
        className="w-full rounded-md px-2 py-1.5 text-xs resize-none overflow-hidden bg-amber-50 border border-amber-200 text-amber-900 placeholder:text-amber-400 focus:outline-none focus:border-amber-300"
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
        const asset = await uploadFileToMedia(file, {
          source_kind: "board_upload",
          collection_key: "board-uploads",
          board_id: boardId,
        });
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
      className={["relative rounded-md transition-colors", attachDragging ? "ring-1 ring-sky-500/60 bg-sky-50/50" : ""].join(" ")}
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
            const next = generations.map((g, i) =>
              i === idx ? { ...g, annotations: strokes } : g);
            onUpdate({ generations: next });
          }}
        />
      )}

      {/* Controls: always below image (or standalone when no image) */}
      <div className="p-2 flex flex-col gap-2">
        {attachments.length > 0 && (
          <AttachmentsStrip attachments={attachments} onRemove={removeAttachment} />
        )}
        <textarea
          className="w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-sky-400/50 min-h-[56px] resize-none"
          placeholder={attachments.length > 0
            ? "Describe what to do with these images…"
            : "Prompt · drop images to attach"}
          value={item.text}
          onChange={(e) => onUpdate({ text: e.target.value })}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onAttachDrop(e); }}
        />
        <div className="flex items-center gap-1.5">
          <ModelSelector active={activeModel} onChange={(m) => onUpdate({ model: m })} />
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onSend}
            disabled={loading || !item.text.trim()}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-sky-500/10 text-sky-600 hover:bg-sky-500/20 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <span className="size-3 rounded-full border border-sky-400/40 border-t-sky-500 animate-spin" />
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
        {error && <div className="text-[11px] text-rose-500 leading-tight">{error}</div>}
      </div>

      {attachDragging && (
        <div
          className="absolute inset-0 rounded-md border-2 border-dashed border-sky-400/70 bg-sky-50/80 grid place-items-center"
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDrop={(e) => { e.preventDefault(); onAttachDrop(e); }}
        >
          <div className="text-[11px] font-medium text-sky-600 pointer-events-none">Drop to attach</div>
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
              "inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium tracking-wide border border-gray-200 first:rounded-l-md last:rounded-r-md -ml-px first:ml-0 transition-colors",
              active === opt.key
                ? "bg-gray-900 text-white border-gray-900 z-10"
                : "bg-white text-gray-500 hover:text-gray-900 hover:border-gray-300",
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
    <div className="relative shrink-0 size-12 rounded-md overflow-hidden border border-gray-200 bg-gray-50 group">
      {blobUrl ? (
        <img src={blobUrl} className="size-full object-cover" />
      ) : (
        <div className="size-full grid place-items-center text-[9px] text-gray-400">…</div>
      )}
      <button
        type="button"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={onRemove}
        className="absolute top-0 right-0 size-4 grid place-items-center bg-white/80 text-gray-500 hover:text-gray-900 opacity-0 group-hover:opacity-100 transition-opacity rounded-bl-md"
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
          className="relative w-full rounded-md overflow-hidden bg-gray-50 group"
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
        <div className="aspect-square bg-gray-50 rounded-md grid place-items-center text-[11px] text-gray-400">
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
        className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 rounded-md bg-white/80 backdrop-blur-sm border border-gray-200 px-1 py-0.5 text-[10px] text-gray-700"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onPrev}
          disabled={idx <= 0}
          className="px-1 py-0.5 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
          title="Previous (⌘Z)"
        >
          <LuChevronLeft className="size-3" />
        </button>
        <span className="px-1 tabular-nums select-none">{idx + 1} / {total}</span>
        <button
          type="button"
          onClick={onNext}
          disabled={idx >= total - 1}
          className="px-1 py-0.5 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
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
          className="relative w-full rounded-md overflow-hidden bg-gray-50 group"
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
      <div className="aspect-square bg-gray-50 rounded-md grid place-items-center text-[11px] text-gray-400">
        loading…
      </div>
    );
  }
  if (fileId && !sessionId) {
    return (
      <div className="aspect-square bg-gray-50 rounded-md grid place-items-center text-[11px] text-gray-400 px-2 text-center">
        Start a Director chat to view generated images.
      </div>
    );
  }
  return (
    <div className="aspect-square bg-gray-50 rounded-md grid place-items-center text-[11px] text-gray-400">
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
      className="absolute top-1.5 right-1.5 size-6 grid place-items-center rounded-md bg-white/80 backdrop-blur-sm border border-gray-200 text-gray-600 opacity-0 group-hover:opacity-100 hover:bg-white hover:text-gray-900 transition-opacity"
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

function usesHoverChrome(type: VibeBoardItem["type"]) {
  return type === "image" || type === "reference";
}

const lightDotGrid =
  "radial-gradient(circle, rgba(0,0,0,0.18) 1px, transparent 1px)";

const MINI_W = 180;
const MINI_H = 110;

function Minimap({
  items, pan, zoom, viewportRef, onNavigate,
}: {
  items: VibeBoardItem[];
  pan: { x: number; y: number };
  zoom: number;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  onNavigate: (pan: { x: number; y: number }) => void;
}) {
  const [vpSize, setVpSize] = useState({ w: 800, h: 600 });
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    setVpSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(() => setVpSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewportRef]);

  if (items.length === 0) return null;

  // Bounding box of items in canvas coords
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x);
    minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + ITEM_W);
    maxY = Math.max(maxY, it.y + ITEM_W);
  }

  const pad = 60;
  const extMinX = minX - pad;
  const extMinY = minY - pad;
  const extMaxX = maxX + pad;
  const extMaxY = maxY + pad;
  const contentW = Math.max(1, extMaxX - extMinX);
  const contentH = Math.max(1, extMaxY - extMinY);

  const scale = Math.min(MINI_W / contentW, MINI_H / contentH);
  const offsetX = (MINI_W - contentW * scale) / 2;
  const offsetY = (MINI_H - contentH * scale) / 2;

  function toMini(cx: number, cy: number) {
    return { mx: (cx - extMinX) * scale + offsetX, my: (cy - extMinY) * scale + offsetY };
  }

  // Viewport rect in canvas coords
  const vpLeft = -pan.x / zoom;
  const vpTop = -pan.y / zoom;
  const vMW = Math.max(6, (vpSize.w / zoom) * scale);
  const vMH = Math.max(6, (vpSize.h / zoom) * scale);
  const { mx: vMx, my: vMy } = toMini(vpLeft, vpTop);

  const colorFor = (type: VibeBoardItem["type"]) => {
    if (type === "image" || type === "reference") return "#e879f9";
    if (type === "prompt") return "#38bdf8";
    return "#fbbf24";
  };

  function onMinimapClick(e: React.MouseEvent) {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const canvasX = (mx - offsetX) / scale + extMinX;
    const canvasY = (my - offsetY) / scale + extMinY;
    const vp = viewportRef.current;
    if (!vp) return;
    onNavigate({
      x: vp.clientWidth / 2 - canvasX * zoom,
      y: vp.clientHeight / 2 - canvasY * zoom,
    });
  }

  return (
    <div
      className="absolute bottom-4 right-4 z-20 rounded-lg border border-gray-200 bg-white/90 backdrop-blur-sm overflow-hidden cursor-crosshair select-none"
      style={{ width: MINI_W, height: MINI_H }}
      onClick={onMinimapClick}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {items.map((it) => {
        const { mx, my } = toMini(it.x, it.y);
        const ms = Math.max(4, ITEM_W * scale);
        return (
          <div
            key={it.id}
            className="absolute rounded-sm opacity-75"
            style={{ left: mx, top: my, width: ms, height: ms, backgroundColor: colorFor(it.type) }}
          />
        );
      })}
      <div
        className="absolute border border-gray-400/50 bg-gray-200/30 pointer-events-none rounded-sm"
        style={{ left: vMx, top: vMy, width: vMW, height: vMH }}
      />
    </div>
  );
}
