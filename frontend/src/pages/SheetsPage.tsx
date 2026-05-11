// /sheets/:fileId — full-page Google-Sheets-style editor for a CSV in the KB.
// Wraps the existing CsvEditor with Sheets-style chrome and a right-hand AI
// sidebar that can READ + EDIT the sheet via tool-use.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  LuArrowLeft, LuSparkles, LuSend, LuX, LuLoader, LuPanelRightOpen,
  LuPanelRightClose, LuFileSpreadsheet, LuWrench, LuCheck,
} from "react-icons/lu";
import { api, type KbFile } from "../lib/api";
import { useApi } from "../lib/swr";
import { CsvEditor, type CsvEditorHandle } from "../components/KbFileModal";
import { humanizeBytes } from "../lib/format";

// ---------------------------------------------------------------- AI types --
// Mirrors the server-side ContentBlock union from _shared/anthropic.ts.
type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
type Turn = { role: "user" | "assistant"; content: string | ContentBlock[] };

// Tool definitions the sidebar advertises to Claude. The dispatcher below
// matches by `name` to call the editor's imperative API.
const TOOLS = [
  {
    name: "set_cells",
    description:
      "Overwrite specific cells. row is 1-based (row 1 = first data row, header is row 0); col is either a header name or an A1 letter.",
    input_schema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              row: { type: "integer", description: "1-based data row. Use 0 only to rename a header." },
              col: { type: "string", description: "Header name or A1 letter (e.g. 'description' or 'D')." },
              value: { type: "string" },
            },
            required: ["row", "col", "value"],
          },
        },
      },
      required: ["changes"],
    },
  },
  {
    name: "fill_column",
    description:
      "Generate values for many rows of a single column using a per-row LLM call. Use this instead of set_cells when the same instruction applies to every row (or a range). The model will see the other columns of each row as context. If target_column doesn't exist yet, it's appended.",
    input_schema: {
      type: "object",
      properties: {
        target_column: { type: "string", description: "Header name (or A1 letter) of the column to fill." },
        prompt: { type: "string", description: "Per-row instruction. E.g. 'classify the merchant as food/transport/other'." },
        context_columns: {
          type: "array",
          items: { type: "string" },
          description: "Optional: limit context to these columns. If omitted, all other columns are passed.",
        },
        row_range: {
          type: "object",
          properties: {
            start: { type: "integer", description: "1-based first data row, inclusive." },
            end: { type: "integer", description: "1-based last data row, inclusive." },
          },
          required: ["start", "end"],
          description: "Optional: restrict to a row range. If omitted, fills every data row.",
        },
      },
      required: ["target_column", "prompt"],
    },
  },
  {
    name: "add_column",
    description: "Add a new column. Inserts at position (0-based) or appends if omitted.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        position: { type: "integer", description: "0-based index to insert at. Omit to append." },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_rows",
    description: "Delete data rows by their 1-based indices.",
    input_schema: {
      type: "object",
      properties: {
        row_indices: { type: "array", items: { type: "integer" } },
      },
      required: ["row_indices"],
    },
  },
];

// ---------------------------------------------------------------- SheetsPage --

export function SheetsPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const nav = useNavigate();
  const { data: file, mutate: refetchFile } = useApi<KbFile>(
    fileId ? `/kb/files/${fileId}` : null,
  );
  const [panelOpen, setPanelOpen] = useState(true);
  const [editorState, setEditorState] = useState<{
    csv: string;
    cellRef: string;
    cellValue: string;
  }>({ csv: "", cellRef: "", cellValue: "" });
  const editorRef = useRef<CsvEditorHandle | null>(null);

  const onEditorState = useCallback(
    (s: { csv: string; cellRef: string; cellValue: string }) => setEditorState(s),
    [],
  );

  if (!fileId) return <div className="p-6 text-ink-500">Missing file id.</div>;
  if (!file) return <div className="p-6 text-ink-500">Loading…</div>;

  return (
    <div className="h-full flex flex-col bg-neutral-50">
      <div className="border-b border-neutral-200 bg-white px-3 py-2 flex items-center gap-2">
        <button className="btn-ghost" onClick={() => nav("/knowledge")} title="Back to Knowledge">
          <LuArrowLeft className="size-4" />
        </button>
        <div className="size-7 rounded-md bg-emerald-50 text-emerald-600 grid place-items-center">
          <LuFileSpreadsheet className="size-4" />
        </div>
        <div className="text-sm font-semibold truncate max-w-md">{file.name}</div>
        <div className="text-[11px] text-ink-400 font-mono ml-1 truncate">
          {humanizeBytes(file.size_bytes)} · {file.mime}
        </div>
        <div className="flex-1" />
        <button
          className={["btn-ghost", panelOpen ? "text-violet-700 bg-violet-50" : ""].join(" ")}
          onClick={() => setPanelOpen((v) => !v)}
          title={panelOpen ? "Hide sheet helper" : "Show sheet helper"}
        >
          {panelOpen
            ? <><LuPanelRightClose className="size-4" /> Helper</>
            : <><LuPanelRightOpen className="size-4" /> Helper</>}
        </button>
      </div>

      <div className="border-b border-neutral-200 bg-white px-3 py-1 flex items-center gap-2 text-xs">
        <div className="font-mono text-ink-500 w-16 text-center border-r border-neutral-200">
          {editorState.cellRef || "—"}
        </div>
        <div className="italic text-ink-400 mr-1">ƒx</div>
        <div className="flex-1 font-mono text-ink-700 truncate min-h-[1.25rem]">
          {editorState.cellValue}
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-w-0 flex flex-col">
          <CsvEditor
            ref={editorRef}
            proxyPath={`/kb/files/${file.id}/content`}
            fileId={file.id}
            mime={file.mime}
            onCancel={() => nav("/knowledge")}
            onSaved={() => refetchFile()}
            showColLetters
            onStateChange={onEditorState}
          />
          <div className="border-t border-neutral-200 bg-neutral-100 px-2 py-1 flex items-center gap-1">
            <div className="px-3 py-1 rounded-t-md bg-white border border-neutral-200 border-b-white text-xs font-medium -mb-px">
              {file.name.replace(/\.csv$/i, "")}
            </div>
          </div>
        </div>

        {panelOpen && (
          <AiPanel
            fileId={file.id}
            csvProvider={() => editorState.csv}
            editorRef={editorRef}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- AiPanel --

function AiPanel({
  fileId,
  csvProvider,
  editorRef,
  onClose,
}: {
  fileId: string;
  csvProvider: () => string;
  editorRef: React.RefObject<CsvEditorHandle | null>;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns.length, busy]);

  // Execute a single tool_use against the editor and return the string the
  // model will receive as tool_result content.
  async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
    const handle = editorRef.current;
    if (!handle) return "Editor not ready.";
    try {
      if (name === "set_cells") {
        const changes = (input.changes as Array<{ row: number; col: string | number; value: string }>) ?? [];
        return handle.setCells(changes);
      }
      if (name === "fill_column") {
        return await handle.fillColumn(input as Parameters<CsvEditorHandle["fillColumn"]>[0]);
      }
      if (name === "add_column") {
        return handle.addColumn(input.name as string, input.position as number | undefined);
      }
      if (name === "delete_rows") {
        return handle.deleteRows((input.row_indices as number[]) ?? []);
      }
      return `Unknown tool: ${name}`;
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  }

  async function sendOnce(messages: Turn[]): Promise<Turn[]> {
    const res = await api.post<{
      content: ContentBlock[];
      stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
    }>(`/kb/files/${fileId}/sheets-chat`, {
      messages,
      csv_state: csvProvider(),
      tools: TOOLS,
    });
    const assistantTurn: Turn = { role: "assistant", content: res.content };
    const nextMessages: Turn[] = [...messages, assistantTurn];

    if (res.stop_reason !== "tool_use") return nextMessages;

    // Execute every tool_use block, build a single user turn carrying their
    // tool_result blocks, and recurse so Claude sees the results.
    const toolUses = res.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const resultBlocks: ToolResultBlock[] = [];
    for (const tu of toolUses) {
      // eslint-disable-next-line no-await-in-loop
      const text = await runTool(tu.name, tu.input);
      resultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: text,
        is_error: text.startsWith("Error:"),
      });
    }
    const resultTurn: Turn = { role: "user", content: resultBlocks };
    return await sendOnce([...nextMessages, resultTurn]);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const userTurn: Turn = { role: "user", content: text };
    setInput("");
    setBusy(true);
    setErr(null);
    try {
      const updated = await sendOnce([...turns, userTurn]);
      setTurns(updated);
    } catch (e) {
      setErr((e as Error).message);
      setTurns((t) => [...t, userTurn]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="w-[380px] shrink-0 border-l border-neutral-200 bg-white flex flex-col">
      <div className="px-3 py-2 border-b border-neutral-200 flex items-center gap-2">
        <LuSparkles className="size-4 text-violet-500" />
        <div className="text-sm font-semibold">Sheet helper</div>
        <div className="text-[10px] text-ink-400">Read, organize, and update this sheet</div>
        <button className="btn-ghost ml-auto" onClick={onClose} title="Close">
          <LuX className="size-3.5" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {turns.length === 0 && !busy ? (
          <div className="text-xs text-ink-500 space-y-2">
            <div>I can read and edit this sheet. Try:</div>
            <div className="grid gap-1.5">
              {[
                "Add a 'category' column and classify each row.",
                "Fill the description column based on the at and kind columns.",
                "Find rows where the description is empty and tell me which ones.",
                "Delete any rows where kind is 'team'.",
              ].map((s) => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  className="text-left rounded-lg border border-neutral-200 hover:border-violet-300 hover:bg-violet-50/40 px-2.5 py-1.5"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t, i) => <TurnView key={i} turn={t} />)
        )}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-ink-500">
            <LuLoader className="size-3.5 animate-spin" /> Working…
          </div>
        )}
        {err && (
          <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5">
            {err}
          </div>
        )}
      </div>

      <div className="border-t border-neutral-200 p-2 flex gap-2">
        <textarea
          className="input flex-1 resize-none text-sm"
          rows={2}
          placeholder="Ask for an edit or cleanup…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={busy}
        />
        <button
          className="btn-primary self-stretch"
          disabled={!input.trim() || busy}
          onClick={send}
          title="⌘+Enter to send"
        >
          <LuSend className="size-4" />
        </button>
      </div>
    </aside>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  // String-only user turns: plain bubble.
  if (turn.role === "user" && typeof turn.content === "string") {
    return (
      <div className="rounded-lg px-3 py-2 text-sm whitespace-pre-wrap bg-violet-50 text-ink-900 ml-6">
        {turn.content}
      </div>
    );
  }
  // Tool-result user turns: render compact chips.
  if (turn.role === "user" && Array.isArray(turn.content)) {
    return (
      <div className="space-y-1 ml-2">
        {turn.content.map((b, i) =>
          b.type === "tool_result"
            ? (
              <div
                key={i}
                className={[
                  "rounded-md border px-2 py-1 text-[11px] flex items-start gap-1.5",
                  b.is_error
                    ? "border-rose-200 bg-rose-50 text-rose-700"
                    : "border-emerald-200 bg-emerald-50 text-emerald-800",
                ].join(" ")}
              >
                {b.is_error ? <LuWrench className="size-3 mt-[2px] shrink-0" /> : <LuCheck className="size-3 mt-[2px] shrink-0" />}
                <div>{b.is_error ? "That step needs attention." : "Sheet updated successfully."}</div>
              </div>
            )
            : null,
        )}
      </div>
    );
  }
  // Assistant turn: text + tool_use blocks inline.
  if (turn.role === "assistant" && Array.isArray(turn.content)) {
    const toolUses = turn.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      return (
        <div className="rounded-lg px-3 py-2 text-sm text-ink-500 bg-neutral-100 mr-6">
          Reviewing the sheet…
        </div>
      );
    }
    return (
      <div className="space-y-1.5 mr-6">
        {toolUses.map((b, i) => (
          <div
            key={i}
            className="rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-[11px] text-violet-800 flex items-start gap-1.5"
          >
            <LuWrench className="size-3 mt-[2px] shrink-0" />
            <div>
              <span className="font-semibold capitalize">{humanizeToolName(b.name)}</span>
              <span className="text-ink-500"> · {summarizeInput(b.input) || "working"}</span>
            </div>
          </div>
        ))}
      </div>
    );
  }
  return null;
}

function summarizeInput(input: Record<string, unknown>): string {
  // Show a short hint about what the tool is about to do.
  if (Array.isArray(input.changes)) return `${input.changes.length} cell${input.changes.length === 1 ? "" : "s"}`;
  if (typeof input.target_column === "string") {
    const r = input.row_range as { start: number; end: number } | undefined;
    return r ? `${input.target_column}, rows ${r.start}-${r.end}` : `${input.target_column}, all rows`;
  }
  if (typeof input.name === "string") return `"${input.name}"`;
  if (Array.isArray(input.row_indices)) return `rows ${input.row_indices.slice(0, 6).join(",")}${input.row_indices.length > 6 ? "…" : ""}`;
  return "";
}

function humanizeToolName(name: string): string {
  if (name === "set_cells") return "Updating cells";
  if (name === "fill_column") return "Filling a column";
  if (name === "add_column") return "Adding a column";
  if (name === "delete_rows") return "Removing rows";
  return "Applying changes";
}
