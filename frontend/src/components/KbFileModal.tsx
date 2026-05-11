// Full-screen viewer/editor for a knowledge-base file. Opens when a card on
// /knowledge is clicked. Text-based formats (md/txt/csv/json) get an inline
// editor that PUTs back through /kb/files/:id/content; everything else
// renders read-only via the existing classify/blob path or offers download.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  LuDownload, LuPencil, LuLoader, LuTriangleAlert, LuX, LuSave, LuFileText,
  LuSparkles, LuPlus, LuTrash,
} from "react-icons/lu";
import { SlideEditor } from "./SlideEditor";
import { api, type KbFile } from "../lib/api";
import { humanizeBytes } from "../lib/format";

// Imperative handle exposed via ref so external code (eg. the Sheets AI
// sidebar's tool-use dispatcher) can mutate the grid without owning its
// state. Each method returns a short string suitable for surfacing back to
// the LLM as a tool_result.
export type CsvEditorHandle = {
  setCells(changes: Array<{ row: number; col: number | string; value: string }>): string;
  addColumn(name: string, position?: number): string;
  deleteRows(rowIndices: number[]): string;
  fillColumn(args: {
    target_column: string;
    prompt: string;
    context_columns?: string[];
    row_range?: { start: number; end: number };
  }): Promise<string>;
  getCsv(): string;
  getHeaders(): string[];
};

type Kind = "markdown" | "text" | "csv" | "json" | "image" | "pdf" | "pptx" | "office" | "unknown";

function classify(name: string, mime: string): Kind {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const m = (mime || "").toLowerCase();
  if (ext === "md" || m === "text/markdown") return "markdown";
  if (ext === "csv" || m === "text/csv") return "csv";
  if (ext === "json" || m === "application/json") return "json";
  if (ext === "txt" || m.startsWith("text/")) return "text";
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "svg", "webp", "gif"].includes(ext)) return "image";
  if (ext === "pdf" || m === "application/pdf") return "pdf";
  if (ext === "pptx" || m === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  if (["xlsx", "docx"].includes(ext)) return "office";
  return "unknown";
}

const TEXT_KINDS: Kind[] = ["markdown", "text", "csv", "json"];

export function KbFileModal({
  file,
  folderPath,
  onClose,
  onSaved,
}: {
  file: KbFile;
  folderPath: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const kind = useMemo(() => classify(file.name, file.mime), [file.name, file.mime]);
  const proxyPath = `/kb/files/${file.id}/content`;

  // Close on Escape so the modal feels native — but not while editing
  // (Esc would lose unsaved changes).
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !editing) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, onClose]);

  const canEdit = TEXT_KINDS.includes(kind);

  return (
    <div className="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl h-[88vh] flex flex-col overflow-hidden">
        <header className="flex items-center gap-3 px-5 py-3 border-b border-neutral-200">
          <div className="size-9 rounded-lg bg-violet-50 text-violet-500 grid place-items-center shrink-0">
            <LuFileText className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{file.name}</div>
            <div className="text-[11px] text-ink-500 font-mono truncate">
              {folderPath ? `${folderPath} · ` : ""}
              {humanizeBytes(file.size_bytes)} · {file.mime}
            </div>
          </div>
          {canEdit && !editing && (
            <button className="btn-ghost" onClick={() => setEditing(true)}>
              <LuPencil className="size-4" /> Edit
            </button>
          )}
          <a
            className="btn-ghost"
            href={`${import.meta.env.VITE_FN_URL ?? "/functions/v1"}${proxyPath}?download=1`}
            // Note: we can't add an Authorization header from <a>; backend
            // accepts the same JWT via a fetch. Use api.getRaw → blob for a
            // proper authed download.
            onClick={async (e) => {
              e.preventDefault();
              const r = await api.getRaw(`${proxyPath}?download=1`);
              const blob = await r.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = file.name;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            <LuDownload className="size-4" /> Download
          </a>
          <button className="btn-ghost size-9 p-0 grid place-items-center" onClick={onClose}>
            <LuX className="size-4" />
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-auto bg-white">
          {editing && kind === "csv" ? (
            <CsvEditor
              proxyPath={proxyPath}
              fileId={file.id}
              mime={file.mime}
              onCancel={() => setEditing(false)}
              onSaved={() => { setEditing(false); onSaved(); }}
            />
          ) : editing && canEdit ? (
            <TextEditor
              proxyPath={proxyPath}
              fileId={file.id}
              mime={file.mime}
              onCancel={() => setEditing(false)}
              onSaved={() => { setEditing(false); onSaved(); }}
            />
          ) : kind === "image" ? (
            <ImagePreview proxyPath={proxyPath} />
          ) : kind === "pdf" ? (
            <PdfPreview proxyPath={proxyPath} />
          ) : TEXT_KINDS.includes(kind) ? (
            <TextPreview proxyPath={proxyPath} kind={kind} />
          ) : kind === "pptx" ? (
            <SlideEditor source={{ kind: "kb", fileId: file.id }} filename={file.name} />
          ) : kind === "office" ? (
            <OfficeStub />
          ) : (
            <UnknownStub />
          )}
        </div>
      </div>
    </div>
  );
}

function TextPreview({ proxyPath, kind }: { proxyPath: string; kind: Kind }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getRaw(proxyPath).then((r) => r.text()).then((t) => {
      if (!cancelled) setText(t);
    }).catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; };
  }, [proxyPath]);
  if (err) return <PreviewError msg={err} />;
  if (text == null) return <PreviewLoading />;
  if (kind === "json") {
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* leave */ }
    return <pre className="p-6 text-xs font-mono whitespace-pre-wrap">{pretty}</pre>;
  }
  if (kind === "csv") return <CsvTable text={text} />;
  return <pre className="p-6 text-sm font-mono whitespace-pre-wrap">{text}</pre>;
}

// ---- CSV editor: sheets-style grid w/ drag-select + AI fill on selection ----
//
// Selection is stored as an unordered (anchor, focus) pair of grid coords;
// `normRect` projects it to {r0,r1,c0,c1}. The grid is plain DOM (no virtual
// scrolling — fine for our <100k-cell files) so cells get `data-r` / `data-c`
// attrs and we read those off the event target in mouse handlers.
//
// Editing model:
//   - Single click on a cell: moves selection there.
//   - Double-click, Enter, or typing a printable char while a cell is selected:
//     enters edit mode (input swaps in, focused).
//   - Enter commits + moves down; Tab commits + moves right; Esc reverts.
//   - Delete clears every selected cell.
//
// AI fill:
//   - Whenever a selection exists, the floating action bar shows "Fill N cells".
//   - Backend gets row_indices = selected data rows, repeated per selected col.

type Coord = { r: number; c: number };
type Selection = { anchor: Coord; focus: Coord };

// Resolve a column reference (header name OR A1 letter, case-insensitive) to
// a 0-based index. Returns -1 if not found.
function resolveColumnIndex(ref: number | string, header: string[]): number {
  if (typeof ref === "number") {
    return ref >= 0 && ref < header.length ? ref : -1;
  }
  const r = ref.trim();
  // Exact header match (case-sensitive first, then case-insensitive).
  const exact = header.indexOf(r);
  if (exact >= 0) return exact;
  const ci = header.findIndex((h) => h.toLowerCase() === r.toLowerCase());
  if (ci >= 0) return ci;
  // A1 letter ("D" → 3, "AA" → 26). Only accept pure letter strings.
  if (/^[A-Za-z]+$/.test(r)) {
    let n = 0;
    for (const ch of r.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    const idx = n - 1;
    return idx < header.length ? idx : -1;
  }
  return -1;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// Excel-style column letters: 0 → A, 25 → Z, 26 → AA, ...
export function colLetter(i: number): string {
  let s = "";
  let n = i;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function normRect(sel: Selection): { r0: number; r1: number; c0: number; c1: number } {
  const r0 = Math.min(sel.anchor.r, sel.focus.r);
  const r1 = Math.max(sel.anchor.r, sel.focus.r);
  const c0 = Math.min(sel.anchor.c, sel.focus.c);
  const c1 = Math.max(sel.anchor.c, sel.focus.c);
  return { r0, r1, c0, c1 };
}

function inRect(sel: Selection | null, r: number, c: number): boolean {
  if (!sel) return false;
  const { r0, r1, c0, c1 } = normRect(sel);
  return r >= r0 && r <= r1 && c >= c0 && c <= c1;
}

export const CsvEditor = forwardRef<CsvEditorHandle, {
  proxyPath: string;
  fileId: string;
  mime: string;
  onCancel: () => void;
  onSaved: () => void;
  showColLetters?: boolean;
  onStateChange?: (state: { csv: string; cellRef: string; cellValue: string }) => void;
}>(function CsvEditor({
  proxyPath, fileId, mime, onCancel, onSaved,
  showColLetters = false,
  onStateChange,
}, externalRef) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [showNewCol, setShowNewCol] = useState(false);
  const [newColName, setNewColName] = useState("");

  // Grid state. r=0 is the header row; data rows are r>=1.
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<Coord | null>(null);
  const [editValue, setEditValue] = useState("");
  const dragging = useRef(false);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getRaw(proxyPath).then((r) => r.text()).then((t) => {
      if (!cancelled) setRows(parseCsv(t));
    }).catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; };
  }, [proxyPath]);

  // Global mouseup ends drag-select even if released outside the grid.
  useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  // Mirror rows + active cell to the parent so SheetsPage can power its
  // formula bar and pass the live CSV to the AI sidebar.
  useEffect(() => {
    if (!onStateChange || !rows) return;
    const focus = selection?.focus ?? null;
    const cellRef = focus
      ? `${colLetter(focus.c)}${focus.r + 1}`
      : "";
    const cellValue = focus ? (rows[focus.r]?.[focus.c] ?? "") : "";
    onStateChange({ csv: serializeCsv(rows), cellRef, cellValue });
  }, [rows, selection, onStateChange]);

  // Keep a ref to the latest rows so imperative handle methods don't capture
  // stale state through their closures.
  const rowsRef = useRef<string[][] | null>(rows);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  // Imperative handle for the AI sidebar's tool-use dispatcher. All methods
  // return short strings the dispatcher feeds back as tool_result content.
  useImperativeHandle(externalRef, () => ({
    setCells(changes) {
      const cur = rowsRef.current;
      if (!cur) return "Sheet not loaded yet.";
      const header = cur[0] ?? [];
      const next = cur.map((r) => r.slice());
      let applied = 0;
      const labels: string[] = [];
      for (const change of changes) {
        const colIdx = resolveColumnIndex(change.col, header);
        if (colIdx < 0) {
          labels.push(`(skip: unknown column "${change.col}")`);
          continue;
        }
        // change.row is 1-based data-row index. Allow 0 to address the header.
        const gridR = change.row === 0 ? 0 : change.row;
        while (next.length <= gridR) next.push(new Array(header.length).fill(""));
        while (next[gridR].length <= colIdx) next[gridR].push("");
        next[gridR][colIdx] = change.value;
        labels.push(`${colLetter(colIdx)}${gridR}=${truncate(change.value, 40)}`);
        applied++;
      }
      setRows(next);
      return `Set ${applied} cell${applied === 1 ? "" : "s"}: ${labels.slice(0, 6).join(", ")}${labels.length > 6 ? `, +${labels.length - 6} more` : ""}.`;
    },
    addColumn(name, position) {
      const cur = rowsRef.current;
      if (!cur) return "Sheet not loaded yet.";
      const header = cur[0] ?? [];
      const pos = typeof position === "number"
        ? Math.max(0, Math.min(header.length, position))
        : header.length;
      const next = cur.map((row, i) => {
        const r = row.slice();
        r.splice(pos, 0, i === 0 ? name : "");
        return r;
      });
      setRows(next);
      return `Added column "${name}" at position ${pos + 1} (${colLetter(pos)}).`;
    },
    deleteRows(rowIndices) {
      const cur = rowsRef.current;
      if (!cur) return "Sheet not loaded yet.";
      // rowIndices are 1-based data rows. Drop the header from the set.
      const drop = new Set(
        rowIndices.filter((n) => Number.isInteger(n) && n >= 1 && n < cur.length),
      );
      if (drop.size === 0) return "No valid rows to delete.";
      const next = cur.filter((_, i) => !drop.has(i));
      setRows(next);
      return `Deleted ${drop.size} row${drop.size === 1 ? "" : "s"}: ${Array.from(drop).slice(0, 10).join(", ")}${drop.size > 10 ? `, +${drop.size - 10} more` : ""}.`;
    },
    async fillColumn({ target_column, prompt, row_range }) {
      const cur = rowsRef.current;
      if (!cur) return "Sheet not loaded yet.";
      const header = cur[0] ?? [];
      const colIdx = resolveColumnIndex(target_column, header);
      const dataRowCount = cur.length - 1;
      let rowIndices: number[];
      if (row_range) {
        const start = Math.max(0, Math.min(dataRowCount - 1, row_range.start - 1));
        const end = Math.max(start, Math.min(dataRowCount - 1, row_range.end - 1));
        rowIndices = [];
        for (let i = start; i <= end; i++) rowIndices.push(i);
      } else {
        rowIndices = Array.from({ length: dataRowCount }, (_, i) => i);
      }
      if (rowIndices.length === 0) return "No data rows to fill.";
      try {
        const res = await api.post<{
          values: string[];
          column_index: number;
          row_indices: number[];
        }>(`/kb/files/${fileId}/ai-fill`, {
          column: colIdx >= 0 ? header[colIdx] : target_column,
          prompt,
          row_indices: rowIndices,
        });
        const cur2 = rowsRef.current;
        if (!cur2) return "Sheet went away.";
        const next = cur2.map((r) => r.slice());
        // If column didn't exist, ai-fill appended it — sync header length.
        for (let i = 0; i < res.values.length; i++) {
          const gridR = res.row_indices[i] + 1;
          while (next[gridR].length <= res.column_index) next[gridR].push("");
          next[gridR][res.column_index] = res.values[i];
        }
        // Make sure header has the new column name if it was appended.
        while (next[0].length <= res.column_index) next[0].push("");
        if (!next[0][res.column_index]) next[0][res.column_index] = target_column;
        setRows(next);
        return `Filled ${res.values.length} row${res.values.length === 1 ? "" : "s"} in column "${target_column}".`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
    getCsv() {
      const cur = rowsRef.current;
      return cur ? serializeCsv(cur) : "";
    },
    getHeaders() {
      return (rowsRef.current?.[0] ?? []).slice();
    },
  }), [externalRef, fileId]);

  function setCell(r: number, c: number, v: string) {
    setRows((prev) => {
      if (!prev) return prev;
      const next = prev.map((row) => row.slice());
      while (next[r].length <= c) next[r].push("");
      next[r][c] = v;
      return next;
    });
  }

  function commitEdit(next?: "down" | "right" | "none") {
    if (!editing) return;
    setCell(editing.r, editing.c, editValue);
    if (next === "down") {
      setSelection({ anchor: { r: editing.r + 1, c: editing.c }, focus: { r: editing.r + 1, c: editing.c } });
    } else if (next === "right") {
      setSelection({ anchor: { r: editing.r, c: editing.c + 1 }, focus: { r: editing.r, c: editing.c + 1 } });
    }
    setEditing(null);
    setEditValue("");
    gridRef.current?.focus();
  }

  function cancelEdit() {
    setEditing(null);
    setEditValue("");
    gridRef.current?.focus();
  }

  function startEdit(r: number, c: number) {
    if (!rows) return;
    setEditing({ r, c });
    setEditValue(rows[r]?.[c] ?? "");
  }

  function addRow() {
    setRows((prev) => {
      if (!prev) return prev;
      const cols = prev[0]?.length ?? 1;
      return [...prev, new Array(cols).fill("")];
    });
  }

  function addColumn(name: string) {
    if (!name) return;
    setRows((prev) => prev?.map((r, i) => i === 0 ? [...r, name] : [...r, ""]) ?? prev);
  }

  function deleteSelectedRows() {
    if (!rows || !selection) return;
    const { r0, r1 } = normRect(selection);
    if (r0 === 0) return; // never delete the header row
    setRows(rows.filter((_, i) => i < r0 || i > r1));
    setSelection(null);
  }

  function deleteSelectedColumns() {
    if (!rows || !selection) return;
    const { c0, c1 } = normRect(selection);
    setRows(rows.map((r) => r.filter((_, i) => i < c0 || i > c1)));
    setSelection(null);
  }

  function clearSelection() {
    if (!rows || !selection) return;
    const { r0, r1, c0, c1 } = normRect(selection);
    setRows(rows.map((r, ri) => {
      if (ri < r0 || ri > r1) return r;
      return r.map((cell, ci) => (ci >= c0 && ci <= c1 ? "" : cell));
    }));
  }

  // Mouse handlers — driven by data-r / data-c attrs on each cell so we don't
  // have to capture row/col indexes in closures.
  function readCoord(target: EventTarget | null): Coord | null {
    let el = target as HTMLElement | null;
    while (el) {
      const r = el.getAttribute?.("data-r");
      const c = el.getAttribute?.("data-c");
      if (r != null && c != null) return { r: Number(r), c: Number(c) };
      el = el.parentElement;
    }
    return null;
  }

  function onCellMouseDown(e: React.MouseEvent) {
    const coord = readCoord(e.target);
    if (!coord) return;
    if (editing) commitEdit("none");
    // Header click: select the whole column (data rows only).
    if (coord.r === -1) {
      const lastRow = (rows?.length ?? 1) - 1;
      const sel = { anchor: { r: 1, c: coord.c }, focus: { r: lastRow, c: coord.c } };
      setSelection(sel);
      dragging.current = true;
      return;
    }
    // Row-number click: select the whole row.
    if (coord.c === -1) {
      const lastCol = (rows?.[0]?.length ?? 1) - 1;
      setSelection({ anchor: { r: coord.r, c: 0 }, focus: { r: coord.r, c: lastCol } });
      dragging.current = true;
      return;
    }
    setSelection({ anchor: coord, focus: coord });
    dragging.current = true;
  }

  function onCellMouseEnter(e: React.MouseEvent) {
    if (!dragging.current || !selection) return;
    const coord = readCoord(e.target);
    if (!coord || coord.r < 0 || coord.c < 0) return;
    setSelection({ anchor: selection.anchor, focus: coord });
  }

  function onCellDoubleClick(e: React.MouseEvent) {
    const coord = readCoord(e.target);
    if (!coord || coord.r < 0 || coord.c < 0) return;
    startEdit(coord.r, coord.c);
  }

  function onGridKeyDown(e: React.KeyboardEvent) {
    if (editing) return; // input handles its own keys
    if (!selection || !rows) return;
    const focus = selection.focus;
    const lastR = rows.length - 1;
    const lastC = (rows[0]?.length ?? 1) - 1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? { r: 1, c: 0 }
                  : e.key === "ArrowUp"   ? { r: -1, c: 0 }
                  : e.key === "ArrowLeft" ? { r: 0, c: -1 }
                  :                          { r: 0, c: 1 };
      const next = {
        r: Math.max(0, Math.min(lastR, focus.r + delta.r)),
        c: Math.max(0, Math.min(lastC, focus.c + delta.c)),
      };
      if (e.shiftKey) setSelection({ anchor: selection.anchor, focus: next });
      else setSelection({ anchor: next, focus: next });
    } else if (e.key === "Enter") {
      e.preventDefault();
      startEdit(focus.r, focus.c);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      clearSelection();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Start editing with the typed char as the initial value.
      e.preventDefault();
      setEditing(focus);
      setEditValue(e.key);
    } else if (e.key === "Tab") {
      e.preventDefault();
      const dc = e.shiftKey ? -1 : 1;
      const next = { r: focus.r, c: Math.max(0, Math.min(lastC, focus.c + dc)) };
      setSelection({ anchor: next, focus: next });
    }
  }

  async function runAiFill() {
    if (!rows || !selection || !aiPrompt.trim()) return;
    const { r0, r1, c0, c1 } = normRect(selection);
    // Data-row indices are r0..r1 mapped to row_indices via -1 (header offset).
    const dataR0 = Math.max(0, r0 - 1);
    const dataR1 = Math.max(0, r1 - 1);
    const rowIndices: number[] = [];
    for (let i = dataR0; i <= dataR1; i++) rowIndices.push(i);
    if (rowIndices.length === 0) {
      setErr("Select at least one data row (not just the header).");
      return;
    }
    setAiBusy(true); setErr(null);
    try {
      let next = rows.map((r) => r.slice());
      for (let c = c0; c <= c1; c++) {
        const column = next[0][c] ?? `Column ${c + 1}`;
        // eslint-disable-next-line no-await-in-loop
        const res = await api.post<{
          values: string[];
          column_index: number;
          row_indices: number[];
        }>(`/kb/files/${fileId}/ai-fill`, {
          column,
          prompt: aiPrompt,
          row_indices: rowIndices,
        });
        for (let i = 0; i < res.values.length; i++) {
          const rowIdx = res.row_indices[i] + 1; // back to grid coord
          while (next[rowIdx].length <= res.column_index) next[rowIdx].push("");
          next[rowIdx][res.column_index] = res.values[i];
        }
      }
      setRows(next);
      setAiPanelOpen(false);
      setAiPrompt("");
    } catch (e) { setErr((e as Error).message); }
    finally { setAiBusy(false); }
  }

  async function save() {
    if (!rows) return;
    setSaving(true); setErr(null);
    try {
      const csv = serializeCsv(rows);
      await api.putRaw(`/kb/files/${fileId}/content`, csv, mime || "text/csv");
      onSaved();
    } catch (e) { setErr((e as Error).message); }
    finally { setSaving(false); }
  }

  if (err && rows === null) return <PreviewError msg={err} />;
  if (rows === null) return <PreviewLoading />;
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const rect = selection ? normRect(selection) : null;
  const selectedRowCount = rect ? Math.max(0, Math.min(rect.r1, rows.length - 1) - Math.max(rect.r0, 1) + 1) : 0;
  const selectedColCount = rect ? rect.c1 - rect.c0 + 1 : 0;
  const selectedCells = selectedRowCount * selectedColCount;

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-neutral-200 flex items-center gap-2 flex-wrap">
        <button className="btn-primary" disabled={saving} onClick={save}>
          {saving ? <><LuLoader className="size-4 animate-spin" /> Saving</> : <><LuSave className="size-4" /> Save</>}
        </button>
        <button className="btn-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
        <div className="w-px h-5 bg-neutral-200 mx-1" />
        <button className="btn-ghost" onClick={addRow}>
          <LuPlus className="size-3.5" /> Row
        </button>
        <button className="btn-ghost" onClick={() => setShowNewCol(true)}>
          <LuPlus className="size-3.5" /> Column
        </button>
        {selection && (
          <>
            <button className="btn-ghost" onClick={deleteSelectedRows} title="Delete selected rows">
              <LuTrash className="size-3.5" /> Row{selectedRowCount === 1 ? "" : "s"}
            </button>
            <button className="btn-ghost" onClick={deleteSelectedColumns} title="Delete selected columns">
              <LuTrash className="size-3.5" /> Col{selectedColCount === 1 ? "" : "s"}
            </button>
          </>
        )}
        <div className="text-[11px] text-ink-500 ml-auto font-mono">
          {selection
            ? `${selectedCells} cell${selectedCells === 1 ? "" : "s"} selected · ${selectedRowCount}r × ${selectedColCount}c`
            : `${body.length} row${body.length === 1 ? "" : "s"} · ${header.length} col${header.length === 1 ? "" : "s"}`}
        </div>
      </div>
      {err && (
        <div className="px-4 py-2 text-xs text-rose-600 bg-rose-50 border-b border-rose-100 flex items-start gap-2">
          <LuTriangleAlert className="size-3.5 mt-0.5 shrink-0" /> {err}
        </div>
      )}
      {showNewCol && (
        <div className="px-4 py-2 border-b border-neutral-200 flex items-center gap-2 bg-violet-50/50">
          <input
            autoFocus
            className="input text-sm max-w-xs"
            placeholder="New column name"
            value={newColName}
            onChange={(e) => setNewColName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newColName.trim()) {
                addColumn(newColName.trim());
                setNewColName(""); setShowNewCol(false);
              } else if (e.key === "Escape") {
                setNewColName(""); setShowNewCol(false);
              }
            }}
          />
          <button
            className="btn-primary"
            disabled={!newColName.trim()}
            onClick={() => { addColumn(newColName.trim()); setNewColName(""); setShowNewCol(false); }}
          >
            Add
          </button>
          <button className="btn-ghost" onClick={() => { setNewColName(""); setShowNewCol(false); }}>Cancel</button>
        </div>
      )}

      <div className="relative flex-1 min-h-0 overflow-auto">
        <div
          ref={gridRef}
          tabIndex={0}
          onKeyDown={onGridKeyDown}
          onMouseDown={onCellMouseDown}
          onMouseOver={onCellMouseEnter}
          onDoubleClick={onCellDoubleClick}
          className="outline-none"
        >
          <table className="text-xs font-mono border-collapse w-max min-w-full select-none">
            <thead className="sticky top-0 bg-neutral-50 z-10">
              {showColLetters && (
                <tr>
                  <th
                    data-r={-1}
                    data-c={-1}
                    className="px-2 py-1 text-center text-[10px] text-ink-400 bg-neutral-100 border-b border-r border-neutral-200 select-none w-12"
                  >
                    &nbsp;
                  </th>
                  {header.map((_, ci) => {
                    const colSelected = rect && ci >= rect.c0 && ci <= rect.c1;
                    return (
                      <th
                        key={ci}
                        data-r={-1}
                        data-c={ci}
                        className={[
                          "px-2 py-1 text-center text-[11px] font-medium border-b border-r border-neutral-200 cursor-pointer min-w-[140px]",
                          colSelected ? "bg-violet-200 text-violet-900" : "bg-neutral-100 text-ink-500",
                        ].join(" ")}
                      >
                        {colLetter(ci)}
                      </th>
                    );
                  })}
                </tr>
              )}
              <tr>
                <th
                  data-r={-1}
                  data-c={-1}
                  className="px-2 py-1.5 text-right text-ink-300 border-b border-r border-neutral-200 select-none w-12"
                >
                  &nbsp;
                </th>
                {header.map((h, ci) => {
                  const colSelected = rect && ci >= rect.c0 && ci <= rect.c1;
                  return (
                    <th
                      key={ci}
                      data-r={-1}
                      data-c={ci}
                      className={[
                        "px-2 py-1.5 text-left font-semibold border-b border-neutral-200 text-ink-700 whitespace-nowrap min-w-[140px] cursor-pointer",
                        colSelected ? "bg-violet-100 text-violet-900" : "",
                      ].join(" ")}
                    >
                      {h || <span className="text-ink-300">(unnamed)</span>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {/* Header row is r=0; render it as an editable row so users can rename columns inline. */}
              <tr>
                <td
                  data-r={0}
                  data-c={-1}
                  className={[
                    "px-2 py-0.5 text-right text-ink-300 border-b border-r border-neutral-100 select-none align-middle cursor-pointer",
                    rect && rect.r0 === 0 ? "bg-violet-100 text-violet-700" : "",
                  ].join(" ")}
                >
                  H
                </td>
                {header.map((_, ci) => (
                  <CellTd
                    key={ci}
                    r={0}
                    c={ci}
                    value={rows[0][ci] ?? ""}
                    selection={selection}
                    editing={editing}
                    editValue={editValue}
                    setEditValue={setEditValue}
                    onCommit={commitEdit}
                    onCancelEdit={cancelEdit}
                    bold
                  />
                ))}
              </tr>
              {body.map((r, ri) => {
                const gridR = ri + 1;
                const rowSelected = rect && gridR >= rect.r0 && gridR <= rect.r1;
                return (
                  <tr key={ri}>
                    <td
                      data-r={gridR}
                      data-c={-1}
                      className={[
                        "px-2 py-0.5 text-right text-ink-300 border-b border-r border-neutral-100 select-none align-middle cursor-pointer min-w-[44px]",
                        rowSelected ? "bg-violet-100 text-violet-700" : "",
                      ].join(" ")}
                    >
                      {gridR}
                    </td>
                    {header.map((_, ci) => (
                      <CellTd
                        key={ci}
                        r={gridR}
                        c={ci}
                        value={r[ci] ?? ""}
                        selection={selection}
                        editing={editing}
                        editValue={editValue}
                        setEditValue={setEditValue}
                        onCommit={commitEdit}
                        onCancelEdit={cancelEdit}
                      />
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Floating AI-fill bar — bottom-center when there's a selection. */}
        {selection && selectedCells > 0 && !aiPanelOpen && (
          <div className="sticky bottom-4 mx-auto w-max">
            <button
              className="shadow-2xl bg-white border border-violet-200 rounded-full px-4 py-2 flex items-center gap-2 text-sm hover:border-violet-400 hover:bg-violet-50 transition-colors"
              onClick={() => setAiPanelOpen(true)}
            >
              <LuSparkles className="size-4 text-violet-500" />
              Fill {selectedCells} cell{selectedCells === 1 ? "" : "s"} with AI
              <span className="text-[10px] font-mono text-ink-500">
                {selectedColCount === 1
                  ? `· col "${header[rect!.c0] || "?"}"`
                  : `· ${selectedColCount} cols`}
              </span>
            </button>
          </div>
        )}

        {aiPanelOpen && selection && (
          <div className="sticky bottom-4 mx-auto w-full max-w-xl">
            <div className="bg-white border border-violet-200 rounded-xl shadow-2xl p-3 mx-4">
              <div className="flex items-center gap-2 mb-2 text-sm">
                <LuSparkles className="size-4 text-violet-500" />
                <div className="font-medium">Fill with AI</div>
                <div className="text-[11px] text-ink-500 font-mono">
                  {selectedRowCount}r × {selectedColCount}c · {selectedCells} cell{selectedCells === 1 ? "" : "s"}
                </div>
                <button
                  className="btn-ghost ml-auto"
                  onClick={() => { setAiPanelOpen(false); setAiPrompt(""); }}
                  disabled={aiBusy}
                >
                  <LuX className="size-3.5" />
                </button>
              </div>
              <textarea
                autoFocus
                className="input text-sm w-full resize-none"
                rows={2}
                placeholder={
                  selectedColCount === 1
                    ? `Describe what column "${header[rect!.c0] || "?"}" should contain. Each row's other cells are passed as context.`
                    : "Describe the data. Each column is filled independently using the other cells as context."
                }
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                disabled={aiBusy}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void runAiFill();
                  }
                }}
              />
              <div className="flex items-center gap-2 mt-2">
                <button
                  className="btn-primary"
                  disabled={!aiPrompt.trim() || aiBusy}
                  onClick={runAiFill}
                >
                  {aiBusy
                    ? <><LuLoader className="size-4 animate-spin" /> Filling {selectedCells} cells…</>
                    : <><LuSparkles className="size-4" /> Fill {selectedCells} cell{selectedCells === 1 ? "" : "s"}</>}
                </button>
                <div className="text-[11px] text-ink-500 font-mono">
                  groq · gpt-oss-20b · ⌘+Enter to run
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

// One cell. Pulled out so the row/column mapping stays in one place.
function CellTd({
  r, c, value, selection, editing, editValue, setEditValue, onCommit, onCancelEdit, bold,
}: {
  r: number;
  c: number;
  value: string;
  selection: Selection | null;
  editing: Coord | null;
  editValue: string;
  setEditValue: (v: string) => void;
  onCommit: (next?: "down" | "right" | "none") => void;
  onCancelEdit: () => void;
  bold?: boolean;
}) {
  const selected = inRect(selection, r, c);
  const isAnchor = selection && selection.anchor.r === r && selection.anchor.c === c;
  const isEditing = editing && editing.r === r && editing.c === c;
  return (
    <td
      data-r={r}
      data-c={c}
      className={[
        "border-b border-neutral-100 align-middle p-0 relative",
        selected ? "bg-violet-50/60" : "bg-white",
        isAnchor ? "ring-2 ring-violet-500 ring-inset z-[1]" : "",
        bold ? "font-semibold text-ink-800" : "",
      ].join(" ")}
    >
      {isEditing ? (
        <input
          autoFocus
          className="w-full px-2 py-1 bg-white outline-none border border-violet-400 -m-px"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={() => onCommit("none")}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); onCommit("down"); }
            else if (e.key === "Tab") { e.preventDefault(); onCommit("right"); }
            else if (e.key === "Escape") { e.preventDefault(); onCancelEdit(); }
          }}
        />
      ) : (
        <div className="px-2 py-1 cursor-cell whitespace-nowrap overflow-hidden text-ellipsis max-w-[480px]">
          {value || <span className="invisible">·</span>}
        </div>
      )}
    </td>
  );
}

// Serialize a 2-D array back to RFC-4180 CSV. Quotes any cell that contains
// a comma, quote, or newline.
function serializeCsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => {
    const v = cell ?? "";
    if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  }).join(",")).join("\n");
}

// Minimal RFC-4180-ish CSV parser. Handles double-quoted fields, escaped
// quotes ("" → "), commas inside quotes, and CRLF/LF line endings. Doesn't
// try to detect the delimiter — assumes comma. Sufficient for the kb-preview
// use case.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
      i++; continue;
    }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function CsvTable({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text), [text]);
  if (rows.length === 0) {
    return <div className="p-6 text-sm text-ink-500">Empty CSV.</div>;
  }
  const [header, ...body] = rows;
  // Pad short rows so the table doesn't go ragged.
  const cols = header.length;
  return (
    <div className="overflow-auto h-full">
      <table className="text-xs font-mono border-collapse w-max min-w-full">
        <thead className="sticky top-0 bg-neutral-50">
          <tr>
            <th className="px-2 py-1.5 text-right text-ink-300 border-b border-r border-neutral-200 select-none">#</th>
            {header.map((h, i) => (
              <th
                key={i}
                className="px-3 py-1.5 text-left font-semibold border-b border-neutral-200 text-ink-700 whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri} className="hover:bg-violet-50/40">
              <td className="px-2 py-1 text-right text-ink-300 border-b border-r border-neutral-100 select-none">
                {ri + 1}
              </td>
              {Array.from({ length: cols }).map((_, ci) => (
                <td
                  key={ci}
                  className="px-3 py-1 border-b border-neutral-100 align-top whitespace-pre-wrap break-words max-w-[480px]"
                >
                  {r[ci] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ImagePreview({ proxyPath }: { proxyPath: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    api.getRaw(proxyPath).then((r) => r.blob()).then((b) => {
      if (cancelled) return;
      made = URL.createObjectURL(b);
      setUrl(made);
    }).catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; if (made) URL.revokeObjectURL(made); };
  }, [proxyPath]);
  if (err) return <PreviewError msg={err} />;
  if (!url) return <PreviewLoading />;
  return (
    <div className="p-6 grid place-items-center">
      <img src={url} className="max-w-full max-h-[78vh] object-contain rounded-md border border-neutral-200" />
    </div>
  );
}

function PdfPreview({ proxyPath }: { proxyPath: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    api.getRaw(proxyPath).then((r) => r.blob()).then((b) => {
      if (cancelled) return;
      made = URL.createObjectURL(b);
      setUrl(made);
    }).catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; if (made) URL.revokeObjectURL(made); };
  }, [proxyPath]);
  if (err) return <PreviewError msg={err} />;
  if (!url) return <PreviewLoading />;
  return <iframe src={url} className="w-full h-full bg-white" />;
}

function TextEditor({
  proxyPath, fileId, mime, onCancel, onSaved,
}: {
  proxyPath: string;
  fileId: string;
  mime: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getRaw(proxyPath).then((r) => r.text()).then((t) => {
      if (!cancelled) setText(t);
    }).catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; };
  }, [proxyPath]);

  async function save() {
    if (text == null) return;
    setSaving(true); setErr(null);
    try {
      await api.putRaw(`/kb/files/${fileId}/content`, text, mime || "text/plain");
      onSaved();
    } catch (e) { setErr((e as Error).message); }
    finally { setSaving(false); }
  }

  if (err) return <PreviewError msg={err} />;
  if (text == null) return <PreviewLoading />;
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-neutral-200 flex items-center gap-2">
        <button className="btn-primary" disabled={saving} onClick={save}>
          {saving ? <><LuLoader className="size-4 animate-spin" /> Saving</> : <><LuSave className="size-4" /> Save</>}
        </button>
        <button className="btn-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
        <div className="text-[11px] text-ink-500 ml-auto">
          Saving re-runs extract → chunk → embed.
        </div>
      </div>
      <textarea
        ref={ref}
        autoFocus
        className="flex-1 w-full p-6 font-mono text-xs bg-white outline-none resize-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  );
}

// Inline preview is gated by size — the edge function proxies the bytes
// through Storage, and the 150s wall-clock can't stream gigabyte-class files
// without a 546 (worker did not respond in time). Shown when a file is over
// the inline-preview threshold so the user gets a real explanation instead
// of a generic timeout.
function OversizedStub({
  sizeBytes, limitMb, kind,
}: { sizeBytes: number; limitMb: number; kind: string }) {
  return (
    <div className="p-8 text-sm text-ink-500 max-w-lg">
      <div className="flex items-start gap-2">
        <LuTriangleAlert className="size-4 mt-0.5 text-amber-500" />
        <div className="space-y-1.5">
          <div>
            This {kind} file is {humanizeBytes(sizeBytes)}, over the {limitMb} MB inline-preview limit.
            Rendering it in the browser would time out (the edge proxy has a
            150 s ceiling).
          </div>
          <div className="text-xs text-ink-400">
            Use <span className="font-mono">Download</span> to open locally, or
            split the file into smaller decks. Bigger files will work once a
            server-side text extractor is wired up.
          </div>
        </div>
      </div>
    </div>
  );
}

function OfficeStub() {
  return (
    <div className="p-8 text-sm text-ink-500 max-w-md">
      <div className="flex items-start gap-2">
        <LuTriangleAlert className="size-4 mt-0.5 text-amber-500" />
        <div>
          Office files (xlsx / docx / pptx) don&apos;t render inline yet.
          Use Download to open in your local app.
        </div>
      </div>
    </div>
  );
}

function UnknownStub() {
  return (
    <div className="p-8 text-sm text-ink-500">
      No inline preview for this file type. Use Download.
    </div>
  );
}

function PreviewLoading() {
  return (
    <div className="p-8 flex items-center gap-2 text-sm text-ink-500">
      <LuLoader className="size-4 animate-spin" /> Loading…
    </div>
  );
}

function PreviewError({ msg }: { msg: string }) {
  return (
    <div className="p-8 text-sm text-rose-600 flex items-start gap-2">
      <LuTriangleAlert className="size-4 mt-0.5" /> {msg}
    </div>
  );
}
