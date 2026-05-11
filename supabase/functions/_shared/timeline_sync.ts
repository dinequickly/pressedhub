// Timeline KB → tables sync.
//
// The CSVs in the user's KB tagged `timeline-data` are the canonical store.
// The campaigns / metrics / annotations tables are a read cache so the UI can
// query by date range fast. This module keeps them in lockstep.
//
// Files we look for (matched on `name`, must carry tag 'timeline-data'):
//   campaigns.csv     → public.campaigns        (source = 'kb-csv')
//   metrics.csv       → public.metrics          (source = 'kb-csv')
//   annotations.csv   → public.annotations      (source = 'kb-csv')
//
// Sync semantics: full replace per-resource. We delete every row where
// source = 'kb-csv' for that resource, then insert from the parsed CSV.
// Rows from other sources (e.g. 'seed', 'klaviyo' once connectors land)
// are untouched.
//
// Trigger:
//   - explicit POST /timeline/sync (returns row counts)
//   - lazy: every GET /timeline/* checks if any KB file's updated_at is
//     newer than the recorded last_kb_updated_at for its resource. If so,
//     resyncs that resource only. Cheap when nothing's changed (one
//     metadata query, no parsing).

import { serviceClient } from "./supabase.ts";

export const TIMELINE_KB_TAG = "timeline-data";

const RESOURCE_FILES: Record<Resource, string> = {
  campaigns: "campaigns.csv",
  metrics: "metrics.csv",
  annotations: "annotations.csv",
};

type Resource = "campaigns" | "metrics" | "annotations";

export type SyncResult = {
  campaigns: number;
  metrics: number;
  annotations: number;
  skipped: Resource[];
};

// Public entrypoint: sync any resource whose KB file has changed since
// last_kb_updated_at. Pass `force = true` to always resync regardless.
export async function maybeSyncTimeline(force = false): Promise<SyncResult> {
  const sc = serviceClient();
  const out: SyncResult = { campaigns: 0, metrics: 0, annotations: 0, skipped: [] };

  for (const resource of Object.keys(RESOURCE_FILES) as Resource[]) {
    const file = await findKbFile(sc, RESOURCE_FILES[resource]);
    if (!file) { out.skipped.push(resource); continue; }
    const stateRow = await getSyncState(sc, resource);
    const stale =
      force ||
      stateRow == null ||
      !stateRow.last_kb_updated_at ||
      new Date(file.updated_at).getTime() > new Date(stateRow.last_kb_updated_at).getTime() ||
      stateRow.kb_file_id !== file.id;
    if (!stale) continue;

    const csvText = await downloadKbCsv(sc, file.storage_path);
    const rows = parseCsv(csvText);
    const inserted = await reloadResource(sc, resource, rows);
    await upsertSyncState(sc, resource, file.id, file.updated_at, inserted);
    out[resource] = inserted;
  }

  return out;
}

// -----------------------------------------------------------------------

async function findKbFile(
  sc: ReturnType<typeof serviceClient>,
  name: string,
): Promise<{ id: string; storage_path: string; updated_at: string } | null> {
  const { data, error } = await sc
    .from("kb_files")
    .select("id,storage_path,updated_at,tags,name")
    .eq("name", name)
    .contains("tags", [TIMELINE_KB_TAG])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(`[timeline_sync] lookup ${name} failed:`, error.message);
    return null;
  }
  return data ? { id: data.id, storage_path: data.storage_path, updated_at: data.updated_at } : null;
}

async function getSyncState(
  sc: ReturnType<typeof serviceClient>,
  resource: Resource,
): Promise<{ kb_file_id: string | null; last_kb_updated_at: string | null } | null> {
  const { data } = await sc
    .from("timeline_sync_state")
    .select("kb_file_id,last_kb_updated_at")
    .eq("resource", resource)
    .maybeSingle();
  return data ?? null;
}

async function upsertSyncState(
  sc: ReturnType<typeof serviceClient>,
  resource: Resource,
  kbFileId: string,
  kbUpdatedAt: string,
  rowCount: number,
): Promise<void> {
  await sc.from("timeline_sync_state").upsert({
    resource,
    kb_file_id: kbFileId,
    last_kb_updated_at: kbUpdatedAt,
    last_synced_at: new Date().toISOString(),
    rows_synced: rowCount,
    updated_at: new Date().toISOString(),
  });
}

async function downloadKbCsv(
  sc: ReturnType<typeof serviceClient>,
  storagePath: string,
): Promise<string> {
  const { data, error } = await sc.storage.from("kb").download(storagePath);
  if (error || !data) throw new Error(`KB download failed: ${error?.message ?? "no body"}`);
  return await data.text();
}

// Tiny RFC4180-ish CSV parser. Handles quoted fields with embedded commas,
// quoted "" escaping, and \r\n / \n line endings. Emits header-keyed objects.
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
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
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.length === header.length).map((r) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = r[i];
    return obj;
  });
}

async function reloadResource(
  sc: ReturnType<typeof serviceClient>,
  resource: Resource,
  rows: Array<Record<string, string>>,
): Promise<number> {
  // Wipe prior rows from this source.
  const { error: delErr } = await sc.from(resource).delete().eq("source", "kb-csv");
  if (delErr) throw new Error(`wipe ${resource} failed: ${delErr.message}`);
  if (rows.length === 0) return 0;

  const inserts =
    resource === "campaigns" ? rows.map(rowToCampaign) :
    resource === "metrics" ? rows.map(rowToMetric) :
    rows.map(rowToAnnotation);

  // PostgREST will choke on giant single inserts; chunk.
  const CHUNK = 500;
  for (let i = 0; i < inserts.length; i += CHUNK) {
    const slice = inserts.slice(i, i + CHUNK);
    const { error } = await sc.from(resource).insert(slice);
    if (error) throw new Error(`insert ${resource} failed: ${error.message}`);
  }
  return inserts.length;
}

// -- row converters -------------------------------------------------------
// Each row is parsed strings; convert to typed columns matching the table.

function rowToCampaign(r: Record<string, string>): Record<string, unknown> {
  return {
    name: r.name,
    channel: r.channel,
    started_at: parseDate(r.started_at),
    ended_at: parseDate(r.ended_at),
    description: r.description ?? "",
    metadata: r.metadata ? JSON.parse(r.metadata) : {},
    source: "kb-csv",
  };
}
function rowToMetric(r: Record<string, string>): Record<string, unknown> {
  return {
    kind: r.kind,
    occurred_at: parseDate(r.occurred_at),
    value: Number(r.value),
    dimensions: r.dimensions ? JSON.parse(r.dimensions) : {},
    source: "kb-csv",
  };
}
function rowToAnnotation(r: Record<string, string>): Record<string, unknown> {
  return {
    at: parseDate(r.at),
    kind: r.kind,
    label: r.label,
    description: r.description ?? "",
    source: "kb-csv",
  };
}

function parseDate(s: string): string {
  // Accept ISO 8601 and YYYY-MM-DD; pad-out date-only strings to a UTC noon
  // timestamp so they fall on the right day in any timezone.
  const trimmed = (s ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T12:00:00.000Z`;
  return new Date(trimmed).toISOString();
}
