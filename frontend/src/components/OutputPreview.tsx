// In-browser preview for files produced by an Anthropic Managed Agent.
// Picks a renderer by mime + filename extension. Native renderers (text,
// images, pdf) are zero-bundle. xlsx / docx lazy-load their parser only
// when the user hits "Show preview". pptx is download-only.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { LuDownload, LuFileText, LuLoader, LuTriangleAlert } from "react-icons/lu";
import { api } from "../lib/api";
import type { ChartSpec, RunOutput } from "../lib/api";

const LazyChartView = lazy(() =>
  import("./ChartView").then((m) => ({ default: m.ChartView }))
);
import { FN_URL, supabase } from "../lib/supabase";
import { SlideEditor } from "./SlideEditor";
import { humanizeBytes } from "../lib/format";

type Kind =
  | "markdown"
  | "text"
  | "csv"
  | "json"
  | "chart"
  | "image"
  | "pdf"
  | "xlsx"
  | "docx"
  | "pptx"
  | "unknown";

function classify(name: string | null, mime: string | null): Kind {
  const lower = (name ?? "").toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const m = (mime ?? "").toLowerCase();
  if (lower.endsWith(".chart.json")) return "chart";
  if (m === "application/vnd.pressed.chart+json") return "chart";
  if (ext === "md" || m === "text/markdown") return "markdown";
  if (ext === "csv" || m === "text/csv") return "csv";
  if (ext === "json" || m === "application/json") return "json";
  if (ext === "txt" || m.startsWith("text/plain")) return "text";
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "svg", "webp", "gif"].includes(ext)) return "image";
  if (ext === "pdf" || m === "application/pdf") return "pdf";
  if (ext === "xlsx" || m.includes("spreadsheetml")) return "xlsx";
  if (ext === "docx" || m.includes("wordprocessingml")) return "docx";
  if (ext === "pptx" || m.includes("presentationml")) return "pptx";
  return "unknown";
}

export function OutputPreview({
  sessionId, output,
}: { sessionId: string; output: RunOutput }) {
  const kind = useMemo(() => classify(output.name, output.mime), [output.name, output.mime]);
  const proxyPath = `/sessions/${sessionId}/files/${output.file_id}`;

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-neutral-200">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{output.name ?? output.file_id}</div>
          <div className="text-[11px] text-ink-500 font-mono truncate">
            {output.mime ?? "unknown"} {output.size != null ? `· ${humanizeBytes(output.size)}` : ""}
          </div>
        </div>
        <DownloadButton sessionId={sessionId} output={output} />
      </div>
      <div className="flex-1 overflow-auto">
        <Renderer kind={kind} sessionId={sessionId} output={output} proxyPath={proxyPath} />
      </div>
    </div>
  );
}

function Renderer({
  kind, sessionId, output, proxyPath,
}: {
  kind: Kind; sessionId: string; output: RunOutput; proxyPath: string;
}) {
  switch (kind) {
    case "markdown":
    case "text":
    case "csv":
    case "json":
      return <TextLikePreview kind={kind} proxyPath={proxyPath} />;
    case "chart":
      return <ChartFilePreview proxyPath={proxyPath} />;
    case "image":
    case "pdf":
      return <BlobPreview kind={kind} proxyPath={proxyPath} />;
    case "xlsx":
      return <LazyXlsxPreview proxyPath={proxyPath} />;
    case "docx":
      return <LazyDocxPreview proxyPath={proxyPath} />;
    case "pptx":
      return (
        <SlideEditor
          source={{ kind: "session", sessionId, fileId: output.file_id }}
          filename={output.name ?? output.file_id}
        />
      );
    default:
      return (
        <div className="p-6 text-sm text-ink-500 flex items-start gap-2">
          <LuFileText className="size-4 mt-0.5" />
          No inline preview for this file type. Use Download.
        </div>
      );
  }
}

function TextLikePreview({ kind, proxyPath }: { kind: Kind; proxyPath: string }) {
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
  if (kind === "csv") return <CsvTable text={text} />;
  if (kind === "markdown") return <MarkdownView text={text} />;
  if (kind === "json") {
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* leave as-is */ }
    return <pre className="p-4 text-xs font-mono whitespace-pre-wrap">{pretty}</pre>;
  }
  return <pre className="p-4 text-sm font-mono whitespace-pre-wrap">{text}</pre>;
}

function BlobPreview({ kind, proxyPath }: { kind: Kind; proxyPath: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    api.getRaw(proxyPath)
      .then((r) => r.blob())
      .then((b) => { if (cancelled) return; made = URL.createObjectURL(b); setUrl(made); })
      .catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; if (made) URL.revokeObjectURL(made); };
  }, [proxyPath]);
  if (err) return <PreviewError msg={err} />;
  if (!url) return <PreviewLoading />;
  if (kind === "image") {
    return (
      <div className="p-4 grid place-items-center">
        <img src={url} className="max-w-full max-h-[80vh] object-contain rounded-md border border-neutral-200" />
      </div>
    );
  }
  return <iframe src={url} className="w-full h-full min-h-[80vh] bg-white" />;
}

function ChartFilePreview({ proxyPath }: { proxyPath: string }) {
  const [spec, setSpec] = useState<ChartSpec | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getRaw(proxyPath)
      .then((r) => r.text())
      .then((text) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(text) as ChartSpec;
          if (!parsed.series || !parsed.data) throw new Error("Missing series or data");
          setSpec(parsed);
        } catch (e) {
          setErr((e as Error).message);
        }
      })
      .catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; };
  }, [proxyPath]);

  if (err) return <PreviewError msg={err} />;
  if (!spec) return <PreviewLoading />;
  return (
    <div className="p-5">
      <Suspense fallback={<PreviewLoading />}>
        <LazyChartView spec={spec} />
      </Suspense>
    </div>
  );
}

function LazyXlsxPreview({ proxyPath }: { proxyPath: string }) {
  const [show, setShow] = useState(false);
  const [sheets, setSheets] = useState<Array<{ name: string; aoa: unknown[][] }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const triggered = useRef(false);

  async function load() {
    if (triggered.current) return;
    triggered.current = true;
    setShow(true);
    try {
      const [{ default: XLSX }, res] = await Promise.all([
        import("xlsx"),
        api.getRaw(proxyPath),
      ]);
      const buf = await res.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const out = wb.SheetNames.map((name) => ({
        name,
        aoa: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 }) as unknown[][],
      }));
      setSheets(out);
    } catch (e) { setErr((e as Error).message); }
  }

  if (!show) {
    return (
      <PreviewActionStub
        label="Show spreadsheet preview"
        hint="Loads the SheetJS parser (~700 KB) on demand."
        onClick={load}
      />
    );
  }
  if (err) return <PreviewError msg={err} />;
  if (!sheets) return <PreviewLoading />;
  const sheet = sheets[active];
  return (
    <div className="flex flex-col h-full">
      {sheets.length > 1 && (
        <div className="flex gap-1 px-3 pt-3 border-b border-neutral-200 overflow-x-auto">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              onClick={() => setActive(i)}
              className={[
                "px-2.5 py-1 rounded-t-md text-xs font-medium border-b-2",
                i === active ? "border-amber-400 text-ink-900" : "border-transparent text-ink-500 hover:text-ink-700",
              ].join(" ")}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="overflow-auto p-3">
        <table className="text-xs border-collapse">
          <tbody>
            {sheet.aoa.slice(0, 500).map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci} className="border border-neutral-200 px-2 py-1 align-top whitespace-pre">
                    {String(cell ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.aoa.length > 500 && (
          <div className="text-[11px] text-ink-500 mt-2">
            Showing first 500 rows of {sheet.aoa.length}.
          </div>
        )}
      </div>
    </div>
  );
}

function LazyDocxPreview({ proxyPath }: { proxyPath: string }) {
  const [show, setShow] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const triggered = useRef(false);

  async function load() {
    if (triggered.current) return;
    triggered.current = true;
    setShow(true);
    try {
      const [mammoth, res] = await Promise.all([
        import("mammoth/mammoth.browser"),
        api.getRaw(proxyPath),
      ]);
      const buf = await res.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer: buf });
      setHtml(result.value);
    } catch (e) { setErr((e as Error).message); }
  }

  if (!show) {
    return (
      <PreviewActionStub
        label="Show document preview"
        hint="Loads the mammoth.js parser (~150 KB) on demand. Some formatting may not survive the conversion."
        onClick={load}
      />
    );
  }
  if (err) return <PreviewError msg={err} />;
  if (html == null) return <PreviewLoading />;
  return (
    <div
      className="prose prose-sm max-w-none p-6"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}


function PreviewActionStub({
  label, hint, onClick,
}: { label: string; hint: string; onClick: () => void }) {
  return (
    <div className="p-6">
      <button onClick={onClick} className="btn-primary">{label}</button>
      <div className="text-[11px] text-ink-500 mt-2">{hint}</div>
    </div>
  );
}

function PreviewLoading() {
  return (
    <div className="p-6 flex items-center gap-2 text-sm text-ink-500">
      <LuLoader className="size-4 animate-spin" /> Loading preview…
    </div>
  );
}

function PreviewError({ msg }: { msg: string }) {
  return (
    <div className="p-6 text-sm text-rose-600 flex items-start gap-2">
      <LuTriangleAlert className="size-4 mt-0.5" /> {msg}
    </div>
  );
}

// Tiny CSV → table parser. Handles quoted fields with embedded commas /
// newlines and "" → " escaping. Good enough for previewing agent outputs;
// not a full RFC4180 implementation.
function CsvTable({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text).slice(0, 500), [text]);
  if (rows.length === 0) return <div className="p-4 text-sm text-ink-500">Empty CSV.</div>;
  const [head, ...body] = rows;
  return (
    <div className="overflow-auto p-3">
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            {head.map((c, i) => (
              <th key={i} className="border border-neutral-200 bg-neutral-50 px-2 py-1 text-left font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} className="border border-neutral-200 px-2 py-1 align-top whitespace-pre">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") { cell += "\""; i++; } else { inQuotes = false; }
      } else { cell += ch; }
      continue;
    }
    if (ch === "\"") { inQuotes = true; continue; }
    if (ch === ",") { row.push(cell); cell = ""; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      out.push(row); row = [];
      continue;
    }
    cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); out.push(row); }
  return out;
}

// Minimal markdown renderer. Headings, bold/italic/inline code, fenced code
// blocks, lists, links, paragraphs. Avoids pulling in a full library for the
// common case.
function MarkdownView({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="prose prose-sm max-w-none p-6"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function renderMarkdown(src: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) => {
    let out = escape(s);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    out = out.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return out;
  };

  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${escape(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("```") && !/^(#{1,6})\s+/.test(lines[i]) && !/^[-*]\s+/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

function DownloadButton({
  sessionId, output, prominent,
}: { sessionId: string; output: RunOutput; prominent?: boolean }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const sess = (await supabase.auth.getSession()).data.session;
      // Drive the download by fetching with auth, then trigger a temporary
      // anchor click on the resulting blob URL. We can't just use a plain
      // <a href> because the request needs the bearer token.
      const url = `${FN_URL}/sessions/${sessionId}/files/${output.file_id}?download=1`;
      const res = await fetch(url, {
        headers: {
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${sess?.access_token ?? ""}`,
        },
      });
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = output.name ?? output.file_id;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
    } finally { setBusy(false); }
  }
  return (
    <button
      onClick={go}
      disabled={busy}
      className={prominent ? "btn-primary" : "btn-ghost"}
    >
      <LuDownload className="size-3.5" /> {busy ? "Downloading…" : "Download"}
    </button>
  );
}

