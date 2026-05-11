#!/usr/bin/env node
// Seed the marketing timeline by uploading three CSVs into the KB.
//
// Architecture: KB is the source of truth. The /timeline backend
// auto-syncs from these CSVs into the campaigns / metrics / annotations
// tables (a read cache for the visual timeline). Re-uploading a CSV with
// a fresher updated_at automatically triggers a re-sync on the next read.
//
// What this seeds (deterministic, ~6 months):
//   - campaigns.csv     ~24 campaigns across all 5 channels
//   - metrics.csv       180 daily points × 5 metric kinds (sessions,
//                       revenue, orders, ctr, conversion)
//   - annotations.csv   ~12 product / holiday / weather / competition
//                       events
//
// Idempotent: re-running replaces the previous KB CSVs (same names,
// matched by tag 'timeline-data'). Sync wipes + reinserts the table rows.
//
// Usage:  npm run seed-timeline

import { readFileSync, writeFileSync, mkdtempSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const ENV_PATH = resolve(import.meta.dirname, "..", ".env");
const env = parseEnv(readFileSync(ENV_PATH, "utf8"));
const SUPABASE_URL = env.EXTERNAL_SUPABASE_URL || env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) fail("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");

const TAG = "timeline-data";
const FOLDER_NAME = "Timeline data";

// ----- shape the window ---------------------------------------------------

const NOW = new Date();
const DAYS = 180;
const START = new Date(NOW.getTime() - (DAYS - 1) * 86400 * 1000);
START.setHours(0, 0, 0, 0);
function dayOffset(i) { return new Date(START.getTime() + i * 86400 * 1000); }

// ----- metric series ------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

const METRIC_CONFIG = {
  sessions:   { base: 4200, trend: 0.35, amp: 800,  weeklyAmp: 600,  noise: 400, seasons: 2,   round: true,  floor: 0,   seed: 7 },
  revenue:    { base: 1850, trend: 0.55, amp: 700,  weeklyAmp: 350,  noise: 280, seasons: 2.4, round: false, floor: 0,   seed: 11, precision: 2 },
  ctr:        { base: 2.4,  trend: 0.05, amp: 0.45, weeklyAmp: 0.18, noise: 0.15,seasons: 3,   round: false, floor: 0.5, seed: 13, precision: 2 },
  conversion: { base: 1.6,  trend: 0.10, amp: 0.30, weeklyAmp: 0.12, noise: 0.10,seasons: 2.6, round: false, floor: 0.4, seed: 17, precision: 2 },
  orders:     { base: 38,   trend: 0.45, amp: 12,   weeklyAmp: 8,    noise: 5,   seasons: 2.2, round: true,  floor: 0,   seed: 19 },
};

function buildSeries(kind) {
  const cfg = METRIC_CONFIG[kind];
  const r = rng(cfg.seed);
  const out = [];
  for (let i = 0; i < DAYS; i++) {
    const t = i / DAYS;
    const arc = cfg.base * (1 + cfg.trend * t);
    const seasonal = Math.sin(t * Math.PI * 2 * cfg.seasons) * cfg.amp;
    const weekly = Math.sin((dayOffset(i).getDay() / 7) * Math.PI * 2) * cfg.weeklyAmp;
    const noise = (r() - 0.5) * cfg.noise;
    let value = arc + seasonal + weekly + noise;
    if (cfg.floor != null) value = Math.max(cfg.floor, value);
    if (cfg.round) value = Math.round(value);
    if (cfg.precision) value = Number(value.toFixed(cfg.precision));
    out.push({ kind, occurred_at: dayOffset(i).toISOString().slice(0, 10), value });
  }
  return out;
}

// ----- campaigns ----------------------------------------------------------

const CAMPAIGNS = [
  { offset:   3, dur: 9,  channel: "email",     name: "Welcome flow refresh — V3",        description: "New welcome sequence with reformulation messaging." },
  { offset:   8, dur: 14, channel: "paid",      name: "Spring re-engagement",             description: "Meta + Google retargeting to lapsed Q4 buyers." },
  { offset:  16, dur: 6,  channel: "organic",   name: "Citrus drop teaser series",        description: "Six-post Instagram carousel teasing the SKU." },
  { offset:  22, dur: 4,  channel: "email",     name: "Citrus drop launch send",          description: "Hero email + reminder; segmented by lifecycle." },
  { offset:  26, dur: 14, channel: "in_store",  name: "Citrus retail rollout",            description: "Endcaps in 240 stores; sampling kits to 12 markets." },
  { offset:  35, dur: 10, channel: "paid",      name: "Citrus paid social bursts",        description: "TikTok + Reels boosts on top organic posts." },
  { offset:  44, dur: 7,  channel: "email",     name: "Loyalty April newsletter",         description: "Editorial-format monthly with founder note." },
  { offset:  52, dur: 5,  channel: "organic",   name: "Earth Day brand spotlight",        description: "Sustainability post + IG live with sourcing partner." },
  { offset:  60, dur: 12, channel: "paid",      name: "Pinterest summer beauty",          description: "Visual discovery push for the wellness audience." },
  { offset:  72, dur: 8,  channel: "email",     name: "Mother's Day editorial",           description: "Warm palette, narrative hero, product as supporting cast." },
  { offset:  78, dur: 14, channel: "in_store",  name: "MD gift kit retail",               description: "Limited gift kits in NY/LA flagships + 60 partner stores." },
  { offset:  88, dur: 6,  channel: "paid",      name: "MD performance boost",             description: "Meta lookalike + Google shopping; 4 creative variants." },
  { offset:  98, dur: 9,  channel: "email",     name: "Memorial sale cadence",            description: "Three-send series with tiered discount unlock." },
  { offset: 108, dur: 7,  channel: "organic",   name: "Behind-the-scenes: founder",       description: "Long-form Reels/TikTok with the founder, brand POV." },
  { offset: 115, dur: 14, channel: "paid",      name: "Summer always-on",                 description: "Evergreen prospecting; weekly creative refresh." },
  { offset: 124, dur: 10, channel: "email",     name: "Subscriber-only drop",             description: "Surprise SKU access for Tier 2+ loyalty members." },
  { offset: 132, dur: 6,  channel: "in_store",  name: "Summer sampling — beach markets",  description: "Field activations; coastal retail in NY, NJ, MA." },
  { offset: 140, dur: 8,  channel: "organic",   name: "Recipe series w/ creators",        description: "10 micro-creators × short-form content; co-promotion." },
  { offset: 150, dur: 5,  channel: "email",     name: "Bundle introduction",              description: "Curated 3-pack bundles with intro pricing." },
  { offset: 156, dur: 9,  channel: "paid",      name: "Bundle conversion campaign",       description: "Lower-funnel push tied to bundle SKUs." },
  { offset: 165, dur: 4,  channel: "organic",   name: "End-of-summer retro",              description: "Carousel of top moments / customer wins." },
  { offset: 169, dur: 6,  channel: "email",     name: "Fall lineup tease",                description: "Soft-launch reveal of fall flavor system." },
  { offset: 174, dur: 5,  channel: "in_store",  name: "Fall preview — flagship only",     description: "NYC + LA flagship preview event with media + creators." },
  { offset: 178, dur: 2,  channel: "paid",      name: "Fall preview boost",               description: "Quick burst of attention around the preview." },
];

// ----- annotations --------------------------------------------------------

const ANNOTATIONS = [
  { offset:  21, kind: "product",     label: "Citrus Drop launches",                description: "New SKU live in DTC + select retail." },
  { offset:  35, kind: "weather",     label: "NYC heat wave",                       description: "Daily highs above 85°F for 8 days." },
  { offset:  52, kind: "holiday",     label: "Earth Day",                           description: "" },
  { offset:  74, kind: "holiday",     label: "Mother's Day",                        description: "" },
  { offset:  85, kind: "competition", label: "Olipop launches summer drop",         description: "Direct competitor; meaningful share-of-voice impact." },
  { offset:  98, kind: "holiday",     label: "Memorial Day weekend",                description: "" },
  { offset: 110, kind: "team",        label: "Q3 strategy offsite",                 description: "Plan for fall through end-of-year locked." },
  { offset: 130, kind: "weather",     label: "Coastal heat advisory",               description: "NJ + MA highs; field sampling pulls strong." },
  { offset: 145, kind: "product",     label: "Bundle SKUs ship",                    description: "First bundle SKUs land in fulfillment centers." },
  { offset: 158, kind: "competition", label: "Recess national distribution",        description: "Recess goes wide via a major retail partner." },
  { offset: 168, kind: "team",        label: "Fall lineup approved",                description: "Final flavor system signed off; PR plan locked." },
  { offset: 175, kind: "product",     label: "Fall preview event",                  description: "Press + creators preview the fall system." },
];

// ----- write CSVs to KB --------------------------------------------------

const ownerId = await resolveOwner();
console.log(`owner: ${ownerId}`);

const folderId = await ensureKbFolder(FOLDER_NAME);
console.log(`kb folder: "${FOLDER_NAME}" → ${folderId}`);

const campaignsCsv = csv(
  ["name", "channel", "started_at", "ended_at", "description"],
  CAMPAIGNS.map((c) => [
    c.name, c.channel,
    dayOffset(c.offset).toISOString().slice(0, 10),
    dayOffset(c.offset + c.dur).toISOString().slice(0, 10),
    c.description,
  ]),
);
const metricsCsv = csv(
  ["kind", "occurred_at", "value"],
  Object.keys(METRIC_CONFIG).flatMap((k) =>
    buildSeries(k).map((m) => [m.kind, m.occurred_at, String(m.value)]),
  ),
);
const annotationsCsv = csv(
  ["at", "kind", "label", "description"],
  ANNOTATIONS.map((a) => [
    dayOffset(a.offset).toISOString().slice(0, 10),
    a.kind, a.label, a.description,
  ]),
);

await uploadCsv("campaigns.csv", campaignsCsv, ownerId, folderId);
await uploadCsv("metrics.csv", metricsCsv, ownerId, folderId);
await uploadCsv("annotations.csv", annotationsCsv, ownerId, folderId);

console.log("\ndone — timeline CSVs uploaded to KB.");
console.log(
  "Reload /apps/image-creator → timeline (or hit POST /timeline/sync) to ingest into the read-cache tables.",
);

// -------------------------------------------------------------------------

async function uploadCsv(name, content, ownerId, folderId) {
  // Replace any prior row for this owner with the same name.
  const dupes = await rest(
    "GET",
    `/kb_files?folder_id=eq.${folderId}&name=eq.${encodeURIComponent(name)}&select=id,storage_path`,
  );
  for (const d of dupes) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/kb/${encodePath(d.storage_path)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${KEY}` },
    });
  }
  if (dupes.length) {
    await rest("DELETE", `/kb_files?folder_id=eq.${folderId}&name=eq.${encodeURIComponent(name)}`);
  }

  const id = randomUUID();
  const storagePath = `users/${ownerId}/${id}/${name}`;
  const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/kb/${encodePath(storagePath)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "text/csv",
      "x-upsert": "true",
    },
    body: content,
  });
  if (!upRes.ok) throw new Error(`storage upload ${upRes.status}: ${(await upRes.text()).slice(0, 200)}`);

  const inserted = await rest("POST", "/kb_files", {
    id,
    folder_id: folderId,
    name,
    storage_path: storagePath,
    mime: "text/csv",
    size_bytes: Buffer.byteLength(content, "utf8"),
    status: "uploaded",
    tags: [TAG],
    uploaded_by: ownerId,
  });
  console.log(`  + ${name} (${inserted[0].size_bytes.toLocaleString()} bytes)`);
  return inserted[0];
}

async function resolveOwner() {
  const admins = await rest("GET", "/profiles?role=eq.admin&select=id,email");
  if (admins.length === 0) fail("No admin profiles. Promote yourself before seeding.");
  return admins[0].id;
}

async function ensureKbFolder(name) {
  const existing = await rest("GET", `/kb_folders?name=eq.${encodeURIComponent(name)}&parent_id=is.null&select=id`);
  if (existing[0]) return existing[0].id;
  const inserted = await rest("POST", "/kb_folders", {
    name, parent_id: null, path: name, created_by: ownerId,
  });
  return inserted[0].id;
}

function csv(headers, rows) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

async function rest(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      apikey: KEY,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "return=representation" : "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  if (res.status === 204) return [];
  if (method === "DELETE") return [];
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}
function encodePath(p) { return p.split("/").map(encodeURIComponent).join("/"); }
function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (m[0].trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
function fail(s) { process.stderr.write(`error: ${s}\n`); process.exit(1); }
