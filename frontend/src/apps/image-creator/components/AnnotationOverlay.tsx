// Full-viewport image annotator. Click any image card or generation thumb
// on the canvas to mount this; it portals into <body> so it sits above the
// app shell and the canvas. Drawing happens in image-space coordinates so
// strokes survive resize and re-render correctly at thumbnail scale.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LuEraser, LuRotateCcw, LuTrash2, LuX } from "react-icons/lu";
import type { Stroke } from "../../../lib/api";

const PEN_COLORS: Array<{ name: string; value: string }> = [
  { name: "white", value: "#ffffff" },
  { name: "fuchsia", value: "#e879f9" },
  { name: "sky", value: "#38bdf8" },
  { name: "amber", value: "#fbbf24" },
  { name: "rose", value: "#fb7185" },
];

const PEN_SIZES = [3, 6, 12, 24] as const;

export function AnnotationOverlay({
  src, title, initial, onSave, onClose,
}: {
  /** Object URL or remote URL of the image to annotate. */
  src: string;
  /** Title shown in the overlay's top bar. */
  title: string;
  /** Existing strokes to render and continue editing. */
  initial: Stroke[];
  /** Persist the new strokes; the caller routes into the right item. */
  onSave: (strokes: Stroke[]) => void;
  /** Dismiss without saving. */
  onClose: () => void;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Natural pixel dimensions of the source image — strokes are stored in
  // this coordinate system. Until we know it we render the loading state.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // Bounding rect of the rendered image inside the viewport. Refreshed on
  // load + resize so pointer→image conversion stays accurate.
  const [bounds, setBounds] = useState<DOMRect | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>(initial);
  const [active, setActive] = useState<Stroke | null>(null);
  const [color, setColor] = useState<string>(PEN_COLORS[0].value);
  const [width, setWidth] = useState<number>(PEN_SIZES[1]);
  const [erasing, setErasing] = useState(false);

  // Track viewport changes so the image bbox we use for pointer mapping
  // stays current. We also re-measure right after the <img> reports load.
  useEffect(() => {
    function refresh() {
      const el = imgRef.current;
      if (!el) return;
      setBounds(el.getBoundingClientRect());
    }
    refresh();
    window.addEventListener("resize", refresh);
    return () => window.removeEventListener("resize", refresh);
  }, [natural]);

  // Esc closes without saving.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Convert a pointer event in screen coords into image-space coords using
  // the rendered img element's bbox + the natural pixel dims. Clamps inside
  // [0,natural] so off-image drags don't leak.
  function toImageSpace(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!natural || !bounds || bounds.width === 0 || bounds.height === 0) return null;
    const x = ((clientX - bounds.left) / bounds.width) * natural.w;
    const y = ((clientY - bounds.top) / bounds.height) * natural.h;
    return {
      x: Math.max(0, Math.min(natural.w, x)),
      y: Math.max(0, Math.min(natural.h, y)),
    };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!natural) return;
    const p = toImageSpace(e.clientX, e.clientY);
    if (!p) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (erasing) {
      // Eraser deletes any stroke whose closest point is within ~ width/2
      // of the cursor (in image-space). One-shot per pointer-down.
      const radius = (width / 2) * (natural.w / (bounds?.width ?? natural.w));
      setStrokes((prev) => prev.filter((s) => !strokeNear(s, p, radius)));
      return;
    }
    setActive({ color, width, points: [p] });
  }
  function onPointerMove(e: React.PointerEvent) {
    if (erasing) {
      if ((e.buttons & 1) !== 1) return;
      const p = toImageSpace(e.clientX, e.clientY);
      if (!p || !natural) return;
      const radius = (width / 2) * (natural.w / (bounds?.width ?? natural.w));
      setStrokes((prev) => prev.filter((s) => !strokeNear(s, p, radius)));
      return;
    }
    if (!active) return;
    const p = toImageSpace(e.clientX, e.clientY);
    if (!p) return;
    const last = active.points[active.points.length - 1];
    // Drop near-duplicate points (image-space) to keep strokes lightweight.
    const dx = p.x - last.x, dy = p.y - last.y;
    if (dx * dx + dy * dy < 4) return;
    setActive({ ...active, points: [...active.points, p] });
  }
  function onPointerUp() {
    if (active && active.points.length >= 1) {
      setStrokes((prev) => [...prev, active]);
    }
    setActive(null);
  }

  function undo() {
    setStrokes((prev) => prev.slice(0, -1));
  }
  function clear() {
    setStrokes([]);
    setActive(null);
  }

  // viewBox keeps the SVG perfectly aligned with the rendered image — the
  // SVG is positioned over the bbox in screen coords, so we want its
  // internal coordinate system to match the image's natural pixel grid.
  const viewBox = useMemo(
    () => natural ? `0 0 ${natural.w} ${natural.h}` : "0 0 100 100",
    [natural],
  );

  const overlay = (
    <div
      className="fixed inset-0 z-[1000] bg-black/85 backdrop-blur flex flex-col select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Top bar: title + close. */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/80">
        <div className="text-xs font-medium tracking-wide text-zinc-200 truncate flex-1">
          {title}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="size-7 grid place-items-center text-zinc-400 hover:text-zinc-100 rounded-md hover:bg-zinc-800 transition-colors"
          title="Close (Esc)"
        >
          <LuX className="size-4" />
        </button>
      </div>

      {/* Stage: image centered, fits the available area while preserving
          aspect ratio. `min-h-0` is critical — without it the flex child
          can grow past its parent and clip the image's bottom half.
          `overflow-auto` lets the user scroll if the rendered size still
          exceeds the viewport for any reason. */}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 grid place-items-center overflow-auto p-6"
      >
        <img
          ref={imgRef}
          src={src}
          className="max-w-full max-h-full object-contain pointer-events-none"
          style={{ maxHeight: "calc(100vh - 9rem)" }}
          draggable={false}
          onLoad={(e) => {
            const el = e.currentTarget;
            setNatural({ w: el.naturalWidth || 1, h: el.naturalHeight || 1 });
            // Defer one frame so the layout settles before we read the bbox.
            requestAnimationFrame(() => setBounds(el.getBoundingClientRect()));
          }}
        />
        {natural && bounds && (
          <svg
            viewBox={viewBox}
            preserveAspectRatio="none"
            className="absolute"
            style={{
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
              cursor: erasing ? "cell" : "crosshair",
              touchAction: "none",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {strokes.map((s, i) => (
              <StrokePath key={i} stroke={s} />
            ))}
            {active && <StrokePath stroke={active} />}
          </svg>
        )}
      </div>

      {/* Bottom toolbar. */}
      <div className="px-4 py-2.5 border-t border-zinc-800 bg-zinc-900/90 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          {PEN_COLORS.map((c) => (
            <button
              key={c.name}
              type="button"
              title={c.name}
              onClick={() => { setColor(c.value); setErasing(false); }}
              className={[
                "size-6 rounded-full border-2 transition-transform",
                color === c.value && !erasing
                  ? "border-zinc-200 scale-110"
                  : "border-zinc-700 hover:border-zinc-500",
              ].join(" ")}
              style={{ background: c.value }}
            />
          ))}
        </div>
        <div className="h-5 w-px bg-zinc-800" />
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">Size</span>
          {PEN_SIZES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setWidth(s)}
              className={[
                "size-6 grid place-items-center rounded-md border transition-colors",
                width === s
                  ? "border-zinc-200 bg-zinc-800"
                  : "border-zinc-700 hover:border-zinc-500",
              ].join(" ")}
              title={`${s}px`}
            >
              <span
                className="rounded-full bg-zinc-200"
                style={{ width: Math.min(s, 14), height: Math.min(s, 14) }}
              />
            </button>
          ))}
        </div>
        <div className="h-5 w-px bg-zinc-800" />
        <button
          type="button"
          onClick={() => setErasing((v) => !v)}
          className={[
            "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border transition-colors",
            erasing
              ? "bg-rose-500/20 text-rose-200 border-rose-400/40"
              : "bg-zinc-900 text-zinc-300 border-zinc-700 hover:border-zinc-500",
          ].join(" ")}
          title="Eraser"
        >
          <LuEraser className="size-3.5" />
          Eraser
        </button>
        <button
          type="button"
          onClick={undo}
          disabled={strokes.length === 0}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs bg-zinc-900 text-zinc-300 border border-zinc-700 hover:border-zinc-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="Undo last stroke"
        >
          <LuRotateCcw className="size-3.5" />
          Undo
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={strokes.length === 0}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs bg-zinc-900 text-zinc-300 border border-zinc-700 hover:border-zinc-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="Clear all strokes"
        >
          <LuTrash2 className="size-3.5" />
          Clear
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs bg-zinc-900 text-zinc-300 border border-zinc-700 hover:border-zinc-500 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(strokes)}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-fuchsia-500/20 text-fuchsia-100 border border-fuchsia-400/40 hover:bg-fuchsia-500/30 transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

// Render a single stroke as a smoothed polyline in image-space.
function StrokePath({ stroke }: { stroke: Stroke }) {
  if (stroke.points.length === 0) return null;
  if (stroke.points.length === 1) {
    const p = stroke.points[0];
    return (
      <circle cx={p.x} cy={p.y} r={stroke.width / 2} fill={stroke.color} />
    );
  }
  const d = stroke.points
    .map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`))
    .join(" ");
  return (
    <path
      d={d}
      stroke={stroke.color}
      strokeWidth={stroke.width}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  );
}

// Lightweight hit-test for the eraser. Returns true if any vertex of the
// stroke is within `radius` of `p`. Cheap-and-cheerful — strokes are
// densely sampled enough that segment-based testing isn't worth it here.
function strokeNear(s: Stroke, p: { x: number; y: number }, radius: number): boolean {
  const r2 = (radius + s.width / 2) ** 2;
  for (const q of s.points) {
    const dx = q.x - p.x, dy = q.y - p.y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

// Read-only annotation layer for thumbnails. Renders strokes on top of the
// image at thumbnail scale via SVG with a viewBox in image-space.
export function AnnotationsThumbnail({
  strokes, naturalWidth, naturalHeight,
}: {
  strokes: Stroke[];
  /** Natural pixel size of the underlying image. If unknown, fall back to
   *  bounds derived from the strokes themselves so positioning stays sane. */
  naturalWidth?: number;
  naturalHeight?: number;
}) {
  if (!strokes || strokes.length === 0) return null;
  let w = naturalWidth ?? 0;
  let h = naturalHeight ?? 0;
  if (!w || !h) {
    for (const s of strokes) for (const p of s.points) {
      if (p.x > w) w = p.x;
      if (p.y > h) h = p.y;
    }
    w = Math.max(w, 100);
    h = Math.max(h, 100);
  }
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="absolute inset-0 w-full h-full pointer-events-none"
    >
      {strokes.map((s, i) => (
        <StrokePath key={i} stroke={s} />
      ))}
    </svg>
  );
}
