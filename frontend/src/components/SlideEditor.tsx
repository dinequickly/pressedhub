// Google Slides-like PPTX editor. Parses .pptx files client-side using
// the pptx.ts library (fflate + DOMParser), renders slides as scaled HTML
// divs, and supports click-to-edit text with PUT-back to the KB backend.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  LuLoader, LuTriangleAlert, LuSave, LuX, LuChevronLeft, LuChevronRight,
  LuZoomIn, LuZoomOut, LuPanelLeft, LuMaximize2,
} from "react-icons/lu";
import { api } from "../lib/api";
import {
  parsePptxLazy, parseSlide, patchShapeText, serializePptx,
  type Para, type PptxDoc, type Run, type Shape, type SlideModel, type TextShape,
} from "../lib/pptx";

// ---- Props types --------------------------------------------------------

type Source =
  | { kind: "kb"; fileId: string }
  | { kind: "session"; sessionId: string; fileId: string };

export function SlideEditor({
  source,
  filename,
  onClose,
}: {
  source: Source;
  filename: string;
  onClose?: () => void;
}) {
  const [doc, setDoc] = useState<PptxDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [parsingIdx, setParsingIdx] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [thumbsVisible, setThumbsVisible] = useState(true);
  const canvasRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const bgCancelledRef = useRef(false);

  // KB files use a signed Storage URL so large files bypass the edge function
  // 150 s wall-clock limit. Session output files still go through the proxy.
  useEffect(() => {
    let cancelled = false;
    bgCancelledRef.current = true; // cancel any previous background loop
    setLoading(true);
    setCurrentIdx(0);
    setParsingIdx(null);

    async function load() {
      let fetchUrl: string | null = null;

      if (source.kind === "kb") {
        // Get a short-lived signed URL directly from Storage — no proxy timeout.
        const { url } = await api.get<{ url: string }>(
          `/kb/files/${source.fileId}/download-url`,
        );
        fetchUrl = url;
        // Signed URLs don't need an auth header.
      } else {
        // Session files must go through the authed proxy (no signed URL available).
        fetchUrl = null;
      }

      let buf: ArrayBuffer;
      if (fetchUrl) {
        const res = await fetch(fetchUrl);
        if (!res.ok) throw new Error(`Storage fetch failed: ${res.status}`);
        buf = await res.arrayBuffer();
      } else if (source.kind === "session") {
        const proxyPath = `/sessions/${source.sessionId}/files/${source.fileId}`;
        const res = await api.getRaw(proxyPath);
        buf = await res.arrayBuffer();
      } else {
        throw new Error("No fetch path available");
      }
      // parsePptxLazy unzips and parses slide 1 immediately.
      return parsePptxLazy(new Uint8Array(buf));
    }

    load()
      .then((d) => {
        if (!cancelled) {
          setDoc(d);
          setLoading(false);
          // Kick off background parsing for remaining slides.
          bgCancelledRef.current = false;
          scheduleBackground(d, 1, bgCancelledRef, setDoc);
        }
      })
      .catch((e) => { if (!cancelled) { setErr((e as Error).message); setLoading(false); } });
    return () => { cancelled = true; bgCancelledRef.current = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind === "kb" ? source.fileId : `${source.sessionId}/${source.fileId}`]);

  // Scale the slide canvas to fit the container.
  useLayoutEffect(() => {
    if (!containerRef.current || !doc) return;
    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      const avail = containerRef.current.clientWidth - 32;
      setScale(Math.min(1, avail / SLIDE_W));
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [doc]);

  const lazySlide = doc?.slides[currentIdx] ?? null;
  const slide: SlideModel | null = lazySlide?.parsed ?? null;

  // Navigate to a slide; parse on demand if not yet parsed.
  const navigateTo = useCallback((i: number) => {
    setCurrentIdx(i);
    setSelected(null);
    setEditing(null);
    // Check if this slide needs on-demand parsing (not yet reached by bg loop).
    setDoc((prev) => {
      if (!prev) return prev;
      const lazy = prev.slides[i];
      if (!lazy || lazy.parsed !== null) return prev;
      // Mark as parsing; schedule actual parse after current render.
      setParsingIdx(i);
      setTimeout(() => {
        setDoc((d) => {
          if (!d) return d;
          const updated = parseSlide(d, i);
          setParsingIdx(null);
          return updated;
        });
      }, 0);
      return prev;
    });
  }, []);

  async function save() {
    if (!doc || !dirty || source.kind !== "kb") return;
    setSaving(true);
    try {
      const bytes = serializePptx(doc);
      await api.putRaw(`/kb/files/${source.fileId}/content`, bytes as unknown as BodyInit, PPTX_MIME);
      setDirty(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function updateText(shapeId: string, paras: Para[]) {
    setDoc((prev) => {
      if (!prev) return prev;
      return patchShapeText(prev, currentIdx, shapeId, paras);
    });
    setDirty(true);
    setEditing(null);
    setSelected(shapeId);
  }

  if (loading) return <SlideLoading />;
  if (err) return <SlideError msg={err} />;
  if (!doc || !lazySlide) return <SlideError msg="No slides found." />;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-200 bg-neutral-50 shrink-0">
        <button
          className="btn-ghost p-1 shrink-0"
          onClick={() => setThumbsVisible((v) => !v)}
          title={thumbsVisible ? "Hide thumbnails" : "Show thumbnails"}
        >
          <LuPanelLeft className="size-3.5" />
        </button>
        <div className="text-sm font-medium text-ink-900 truncate min-w-0 flex-1">
          {filename}
        </div>
        <div className="flex items-center gap-1 text-xs text-ink-500 font-mono shrink-0">
          <button
            onClick={() => navigateTo(Math.max(0, currentIdx - 1))}
            disabled={currentIdx === 0}
            className="btn-ghost p-1"
          >
            <LuChevronLeft className="size-3.5" />
          </button>
          <span>{currentIdx + 1} / {doc.slides.length}</span>
          <button
            onClick={() => navigateTo(Math.min(doc.slides.length - 1, currentIdx + 1))}
            disabled={currentIdx === doc.slides.length - 1}
            className="btn-ghost p-1"
          >
            <LuChevronRight className="size-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button className="btn-ghost p-1" onClick={() => setScale((s) => Math.min(2, s + 0.1))} title="Zoom in">
            <LuZoomIn className="size-3.5" />
          </button>
          <span className="text-[10px] text-ink-500 font-mono w-10 text-center">{Math.round(scale * 100)}%</span>
          <button className="btn-ghost p-1" onClick={() => setScale((s) => Math.max(0.2, s - 0.1))} title="Zoom out">
            <LuZoomOut className="size-3.5" />
          </button>
          <button
            className="btn-ghost p-1"
            title="Fit to window"
            onClick={() => {
              if (!containerRef.current) return;
              setScale(Math.min(1, (containerRef.current.clientWidth - 32) / SLIDE_W));
            }}
          >
            <LuMaximize2 className="size-3.5" />
          </button>
        </div>
        {source.kind === "kb" && (
          <button
            className="btn-primary shrink-0"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving
              ? <><LuLoader className="size-3.5 animate-spin" /> Saving…</>
              : <><LuSave className="size-3.5" /> Save</>}
          </button>
        )}
        {onClose && (
          <button className="btn-ghost p-1 shrink-0" onClick={onClose}>
            <LuX className="size-4" />
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Thumbnail strip */}
        {thumbsVisible && (
          <div className="w-[140px] shrink-0 bg-neutral-100 border-r border-neutral-200 overflow-y-auto flex flex-col gap-2 p-2">
            {doc.slides.map((s, i) => (
              <button
                key={i}
                onClick={() => navigateTo(i)}
                className={[
                  "rounded border-2 overflow-hidden shrink-0 transition-all",
                  i === currentIdx
                    ? "border-violet-500 shadow-md"
                    : "border-transparent hover:border-neutral-300",
                ].join(" ")}
                style={{ aspectRatio: `${doc.width}/${doc.height}` }}
              >
                {s.parsed
                  ? <SlideThumbnail slide={s.parsed} width={doc.width} height={doc.height} />
                  : <div className="w-full h-full bg-neutral-200" style={{ aspectRatio: `${doc.width}/${doc.height}` }} />}
              </button>
            ))}
          </div>
        )}

        {/* Slide canvas area */}
        <div
          ref={containerRef}
          className="flex-1 overflow-auto bg-neutral-200 flex items-start justify-center p-4"
          onClick={(e) => {
            if (e.target === containerRef.current) { setSelected(null); setEditing(null); }
          }}
        >
          <div
            style={{
              transform: `scale(${scale})`,
              transformOrigin: "top center",
              width: SLIDE_W,
              height: SLIDE_W * (doc.height / doc.width),
              flexShrink: 0,
              position: "relative",
            }}
          >
            {slide
              ? (
                <SlideCanvas
                  ref={canvasRef}
                  slide={slide}
                  docW={doc.width}
                  docH={doc.height}
                  selected={selected}
                  editing={editing}
                  onSelect={setSelected}
                  onStartEdit={setEditing}
                  onSaveText={updateText}
                  onClickOutside={() => { setSelected(null); setEditing(null); }}
                />
              )
              : (
                <div
                  className="w-full h-full bg-white shadow-2xl flex items-center justify-center"
                  style={{ width: SLIDE_W, height: SLIDE_W * (doc.height / doc.width) }}
                >
                  <LuLoader className="size-6 animate-spin text-neutral-400" />
                </div>
              )}
          </div>
        </div>
      </div>

      {dirty && source.kind !== "kb" && (
        <div className="px-3 py-1.5 text-[11px] text-amber-700 bg-amber-50 border-t border-amber-200 shrink-0">
          Viewing output file — open from Knowledge Base to save edits.
        </div>
      )}
    </div>
  );
}

// ---- Background slide parser -------------------------------------------

// requestIdleCallback falls back to setTimeout on Safari.
const ric: (cb: () => void) => void =
  typeof window !== "undefined" && "requestIdleCallback" in window
    ? (cb) => (window as Window & { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(cb)
    : (cb) => setTimeout(cb, 0);

function scheduleBackground(
  initialDoc: PptxDoc,
  startIndex: number,
  cancelledRef: React.MutableRefObject<boolean>,
  setDoc: React.Dispatch<React.SetStateAction<PptxDoc | null>>,
): void {
  let i = startIndex;

  function parseNext() {
    if (cancelledRef.current) return;
    if (i >= initialDoc.slides.length) return;
    const idx = i++;
    setDoc((prev) => {
      if (!prev || cancelledRef.current) return prev;
      if (prev.slides[idx]?.parsed !== null) {
        // Already parsed (e.g. user navigated there); advance.
        return prev;
      }
      return parseSlide(prev, idx);
    });
    ric(parseNext);
  }

  ric(parseNext);
}

// ---- Slide canvas -------------------------------------------------------

const SLIDE_W = 960;  // base CSS px width; height is proportional
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

type CanvasProps = {
  slide: SlideModel;
  docW: number;
  docH: number;
  selected: string | null;
  editing: string | null;
  onSelect: (id: string | null) => void;
  onStartEdit: (id: string) => void;
  onSaveText: (id: string, paras: Para[]) => void;
  onClickOutside: () => void;
};

import React from "react";

const SlideCanvas = React.forwardRef<HTMLDivElement, CanvasProps>(function SlideCanvas({
  slide, docW, docH, selected, editing, onSelect, onStartEdit, onSaveText, onClickOutside,
}, ref) {
  const slideH = SLIDE_W * (docH / docW);
  const scaleX = SLIDE_W / docW;
  const scaleY = slideH / docH;

  return (
    <div
      ref={ref}
      className="relative overflow-hidden shadow-2xl select-none"
      style={{
        width: SLIDE_W,
        height: slideH,
        background: slide.bg ? `#${slide.bg}` : "#FFFFFF",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClickOutside();
      }}
    >
      {slide.shapes.map((shape) => (
        <ShapeRenderer
          key={shape.id}
          shape={shape}
          scaleX={scaleX}
          scaleY={scaleY}
          selected={selected === shape.id}
          editing={editing === shape.id}
          onSelect={() => onSelect(shape.id)}
          onStartEdit={() => shape.kind === "text" && onStartEdit(shape.id)}
          onSaveText={(paras) => onSaveText(shape.id, paras)}
        />
      ))}
    </div>
  );
});

// ---- Shape renderer -----------------------------------------------------

function ShapeRenderer({
  shape, scaleX, scaleY, selected, editing, onSelect, onStartEdit, onSaveText,
}: {
  shape: Shape;
  scaleX: number;
  scaleY: number;
  selected: boolean;
  editing: boolean;
  onSelect: () => void;
  onStartEdit: () => void;
  onSaveText: (paras: Para[]) => void;
}) {
  const style: React.CSSProperties = {
    position: "absolute",
    left: shape.x * scaleX,
    top: shape.y * scaleY,
    width: shape.w * scaleX,
    height: shape.h * scaleY,
    zIndex: shape.zIndex,
    transform: shape.rot ? `rotate(${shape.rot}deg)` : undefined,
    transformOrigin: "center center",
    boxSizing: "border-box",
  };

  if (shape.fill) {
    style.background = `#${shape.fill}`;
  }

  if (selected) {
    style.outline = "2px solid #7C3AED";
    style.outlineOffset = "1px";
  }

  if (shape.kind === "image") {
    return (
      <div style={style} onClick={(e) => { e.stopPropagation(); onSelect(); }}>
        {shape.src
          ? <img src={shape.src} className="w-full h-full object-contain" draggable={false} />
          : <div className="w-full h-full bg-neutral-200 grid place-items-center text-xs text-neutral-400">[image]</div>}
      </div>
    );
  }

  if (shape.kind === "text") {
    return (
      <TextShapeRenderer
        shape={shape}
        style={style}
        scaleX={scaleX}
        scaleY={scaleY}
        selected={selected}
        editing={editing}
        onSelect={onSelect}
        onStartEdit={onStartEdit}
        onSaveText={onSaveText}
      />
    );
  }

  return <div style={style} onClick={(e) => { e.stopPropagation(); onSelect(); }} />;
}

// ---- Text shape ---------------------------------------------------------

function TextShapeRenderer({
  shape, style, scaleX, scaleY, selected, editing, onSelect, onStartEdit, onSaveText,
}: {
  shape: TextShape;
  style: React.CSSProperties;
  scaleX: number;
  scaleY: number;
  selected: boolean;
  editing: boolean;
  onSelect: () => void;
  onStartEdit: () => void;
  onSaveText: (paras: Para[]) => void;
}) {
  const editRef = useRef<HTMLDivElement>(null);

  // When editing starts, focus the textarea.
  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      // Move caret to end.
      const range = document.createRange();
      range.selectNodeContents(editRef.current);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [editing]);

  function commitEdit() {
    if (!editRef.current) return;
    const text = editRef.current.innerText;
    // Rebuild paragraphs from the edited text. Split on \n and preserve
    // the first run's formatting for all new runs.
    const baseRun: Run = shape.paras[0]?.runs[0] ?? {
      text: "", bold: false, italic: false, underline: false,
      fontSize: 18, color: "", fontFamily: "",
    };
    const lines = text.split(/\n/);
    const paras: Para[] = lines.map((line) => ({
      align: shape.paras[0]?.align ?? "l",
      runs: line ? [{ ...baseRun, text: line }] : [],
    }));
    onSaveText(paras.length ? paras : [{ align: "l", runs: [] }]);
  }

  const textStyle: React.CSSProperties = {
    ...style,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    justifyContent: shape.anchor === "ctr" ? "center" : shape.anchor === "b" ? "flex-end" : "flex-start",
    cursor: "text",
    padding: "4px 8px",
  };

  if (editing) {
    // Editable overlay — contentEditable div with plain text.
    const plainText = shape.paras
      .map((p) => p.runs.map((r) => r.text).join(""))
      .join("\n");
    const firstRun = shape.paras[0]?.runs[0];
    return (
      <div
        style={{
          ...textStyle,
          outline: "2px solid #7C3AED",
          background: style.background ?? "transparent",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          ref={editRef}
          contentEditable
          suppressContentEditableWarning
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              editRef.current?.blur();
            }
          }}
          style={{
            outline: "none",
            width: "100%",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: firstRun ? firstRun.fontSize * scaleX * (96 / 72) : 16,
            fontWeight: firstRun?.bold ? "bold" : "normal",
            fontStyle: firstRun?.italic ? "italic" : "normal",
            color: firstRun?.color ? `#${firstRun.color}` : "#000000",
            fontFamily: firstRun?.fontFamily || "inherit",
            textAlign: shape.paras[0]?.align === "ctr" ? "center"
              : shape.paras[0]?.align === "r" ? "right"
              : "left",
          }}
        >
          {plainText}
        </div>
      </div>
    );
  }

  return (
    <div
      style={textStyle}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      onDoubleClick={(e) => { e.stopPropagation(); onStartEdit(); }}
      title="Double-click to edit"
    >
      {shape.paras.map((para, pi) => (
        <ParagraphView key={pi} para={para} scaleX={scaleX} />
      ))}
    </div>
  );
}

function ParagraphView({ para, scaleX }: { para: Para; scaleX: number }) {
  const textAlign = para.align === "ctr" ? "center"
    : para.align === "r" ? "right"
    : para.align === "just" ? "justify"
    : "left";

  if (para.runs.length === 0) {
    return <div style={{ minHeight: "1em", textAlign }} />;
  }

  return (
    <div style={{ textAlign, lineHeight: 1.2 }}>
      {para.runs.map((run, ri) => (
        <RunView key={ri} run={run} scaleX={scaleX} />
      ))}
    </div>
  );
}

function RunView({ run, scaleX }: { run: Run; scaleX: number }) {
  if (!run.text && run.text !== "\n") return null;
  if (run.text === "\n") return <br />;
  // Convert points to px: 1pt = 1/72 inch; at 96dpi, 1pt ≈ 1.333px
  // Then scale by scaleX (slide pixels per EMU * SLIDE_W).
  const fontSizePx = run.fontSize * (96 / 72) * scaleX;
  return (
    <span
      style={{
        fontWeight: run.bold ? "bold" : "normal",
        fontStyle: run.italic ? "italic" : "normal",
        textDecoration: run.underline ? "underline" : "none",
        fontSize: Math.max(6, fontSizePx),
        color: run.color ? `#${run.color}` : "inherit",
        fontFamily: run.fontFamily || "inherit",
        letterSpacing: 0,
      }}
    >
      {run.text}
    </span>
  );
}

// ---- Thumbnail ---------------------------------------------------------

function SlideThumbnail({ slide, width, height }: { slide: SlideModel; width: number; height: number }) {
  const W = 120;
  const H = W * (height / width);
  const sx = W / width;
  const sy = H / height;

  return (
    <div
      className="relative overflow-hidden w-full"
      style={{ background: slide.bg ? `#${slide.bg}` : "#FFFFFF", aspectRatio: `${width}/${height}` }}
    >
      {slide.shapes.slice(0, 20).map((shape) => (
        <ThumbnailShape key={shape.id} shape={shape} sx={sx} sy={sy} />
      ))}
    </div>
  );
}

function ThumbnailShape({ shape, sx, sy }: { shape: Shape; sx: number; sy: number }) {
  const style: React.CSSProperties = {
    position: "absolute",
    left: `${(shape.x / 12192000) * 100}%`,
    top: `${(shape.y / 6858000) * 100}%`,
    width: `${(shape.w / 12192000) * 100}%`,
    height: `${(shape.h / 6858000) * 100}%`,
    overflow: "hidden",
    background: shape.fill ? `#${shape.fill}` : "transparent",
  };

  if (shape.kind === "image" && shape.src) {
    return <div style={style}><img src={shape.src} className="w-full h-full object-contain" /></div>;
  }

  if (shape.kind === "text" && shape.paras.length > 0) {
    const firstRun = shape.paras.flatMap((p) => p.runs)[0];
    return (
      <div style={{ ...style, display: "flex", alignItems: shape.anchor === "ctr" ? "center" : "flex-start", padding: "1px 2px" }}>
        <span style={{
          fontSize: Math.max(3, (firstRun?.fontSize ?? 12) * sx * (96 / 72)),
          fontWeight: firstRun?.bold ? "bold" : "normal",
          color: firstRun?.color ? `#${firstRun.color}` : "#000000",
          overflow: "hidden",
          lineHeight: 1.1,
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          textOverflow: "ellipsis",
          whiteSpace: "normal",
        }}>
          {shape.paras.map((p) => p.runs.map((r) => r.text).join("")).join(" ")}
        </span>
      </div>
    );
  }

  return <div style={style} />;
}

// ---- Loading / error ---------------------------------------------------

function SlideLoading() {
  return (
    <div className="h-full flex items-center justify-center gap-2 text-sm text-ink-500">
      <LuLoader className="size-4 animate-spin" /> Loading presentation…
    </div>
  );
}

function SlideError({ msg }: { msg: string }) {
  return (
    <div className="h-full flex items-center justify-center gap-2 text-sm text-rose-600 p-6">
      <LuTriangleAlert className="size-4 shrink-0" /> {msg}
    </div>
  );
}
