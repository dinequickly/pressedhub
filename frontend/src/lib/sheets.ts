// One-stop "open this CSV in the full Sheets editor" helper. Used by the
// Knowledge page, the chat page's session-file list, anywhere else that
// surfaces CSVs. Handles both shapes:
//
//   1) A file already in the KB → navigate straight to /sheets/:fileId.
//   2) An agent-produced file scoped to a session (only an Anthropic
//      file_id is known) → adopt it into the KB first via
//      /kb/files/import-from-session, then navigate.
//
// After this returns the user is on the Sheets page with Save, AI fill, the
// tool-use sidebar, and every other feature wired up — because the editor
// is always backed by a real kb_files row.

import { api, type KbFile } from "./api";

export type OpenCsvInput =
  | { kind: "kb"; fileId: string }
  | {
    kind: "session";
    sessionId: string;
    anthropicFileId: string;
    name?: string; // optional override (eg. agent output's display name)
  };

export async function openCsvInSheets(
  input: OpenCsvInput,
  nav: (path: string) => void,
): Promise<void> {
  if (input.kind === "kb") {
    nav(`/sheets/${input.fileId}`);
    return;
  }
  // Session-output file: ensure a kb_files row exists for it, then navigate.
  // Idempotent — server returns the existing row if this anthropic_file_id
  // was already adopted.
  const res = await api.post<{ file: KbFile; adopted: boolean }>(
    "/kb/files/import-from-session",
    {
      session_id: input.sessionId,
      anthropic_file_id: input.anthropicFileId,
      name: input.name,
    },
  );
  nav(`/sheets/${res.file.id}`);
}

// Quick predicate so callers can decide whether a session file should route
// to the Sheets editor (vs. a download / generic preview).
export function looksLikeCsv(input: { name?: string | null; mime?: string | null }): boolean {
  const name = (input.name ?? "").toLowerCase();
  const mime = (input.mime ?? "").toLowerCase();
  return name.endsWith(".csv") || mime === "text/csv";
}
