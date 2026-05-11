#!/usr/bin/env node
// Bulk upload local files into the media library.
//
// One-off helper for seeding the hub with brand assets / reference imagery,
// e.g. after downloading the Pressed asset folder from Drive. For each file:
//   1. Uploads to Supabase Storage bucket `media` at users/<owner-id>/<uuid>/<name>.
//   2. Inserts a media_assets row pointing at that storage path.
//   3. Tags the row so the Director's list_media tool can find it.
//
// Per-folder filtering + auto-tagging:
//   - --exclude <pat> (repeatable) skips any path containing <pat>
//     (case-insensitive substring match on any path segment).
//   - --include <pat> (repeatable) requires at least one path segment to
//     match. When omitted, everything not excluded is kept.
//   - Auto-tag: each file gets one tag per ancestor folder name (slugified)
//     in addition to the global --tag. So a file under "Blue/cans/hero.png"
//     ends up tagged ["pressed-assets", "blue", "cans"]. Lets you filter
//     the library by category in the app.
//
// Idempotent on (owner_id, name): re-running skips already-uploaded files.
// (We dedupe by name within an owner; nuke + re-upload if you want fresh.)
//
// Usage:
//   node scripts/upload-assets.mjs <local-folder> \
//     [--owner=<email>] \
//     [--tag=<tag>] \
//     [--exclude=<pat>] [--exclude=<pat>] ... \
//     [--include=<pat>] [--include=<pat>] ... \
//     [--recursive] [--dry-run]
//
// Example for Pressed (excludes caddy / label / render folders):
//   npm run upload-assets -- ~/Downloads/pressed --recursive \
//     --exclude=caddy --exclude=label --exclude=render

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnv, splitEnvArg } from "./_env.mjs";

// Pick local vs cloud BEFORE parsing the script's own args so `--env=cloud`
// is consumed cleanly.
const { argv: argvAfterEnv, target } = splitEnvArg(process.argv.slice(2));
const env = loadEnv(target);
const SUPABASE_URL = env.EXTERNAL_SUPABASE_URL || env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  fail("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
}
log(`target: ${target} (${SUPABASE_URL})`);

// -- args ----------------------------------------------------------------

const args = parseArgs(argvAfterEnv);
// Join all positional args with spaces — npm strips quotes when passing
// `--` args, which splits a path like "Pressed Asset Library Organized"
// into 4 separate args. This re-joins them.
const sourcePath = args.positional.join(" ");
if (!sourcePath) {
  fail("Usage: node scripts/upload-assets.mjs <folder> [--owner=...] [--tag=...] [--exclude=...] [--include=...] [--recursive] [--dry-run]");
}
const sourceAbs = resolve(sourcePath);
const tag = args.flags.tag ?? "pressed-assets";
const recursive = !!args.bool.recursive;
const dryRun = !!args.bool["dry-run"];
const excludes = (args.repeat.exclude ?? []).map((s) => s.toLowerCase());
const includes = (args.repeat.include ?? []).map((s) => s.toLowerCase());

// -- main ----------------------------------------------------------------

const ownerId = await resolveOwner(args.flags.owner);
log(`owner:    ${ownerId}`);
log(`tag:      "${tag}"`);
if (excludes.length) log(`excludes: ${excludes.map((e) => `"${e}"`).join(", ")}`);
if (includes.length) log(`includes: ${includes.map((i) => `"${i}"`).join(", ")}`);
if (dryRun) log("DRY RUN — no uploads will happen");

const allFiles = walk(sourceAbs, recursive);
const files = allFiles.filter((f) => pathPassesFilters(relative(sourceAbs, f)));
const skippedByFilter = allFiles.length - files.length;
log(`found ${allFiles.length} files; ${files.length} after filters (${skippedByFilter} filtered out)`);

if (dryRun) {
  for (const f of files) {
    const rel = relative(sourceAbs, f);
    log(`  + ${rel}  tags=[${derivedTags(rel).join(", ")}]`);
  }
  log("\ndone (dry-run).");
  process.exit(0);
}

let uploaded = 0, skipped = 0, failed = 0;
for (const file of files) {
  const rel = relative(sourceAbs, file);
  try {
    const result = await uploadOne({
      absPath: file,
      relName: basename(file),
      ownerId,
      tags: derivedTags(rel),
    });
    if (result === "skipped") { skipped++; log(`  - ${rel} (already in media, skipped)`); }
    else { uploaded++; log(`  + ${rel}  tags=[${derivedTags(rel).join(", ")}]`); }
  } catch (err) {
    failed++;
    log(`  ! ${rel} failed: ${err.message}`);
  }
}

log(`\ndone: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

// -- filter + tag logic --------------------------------------------------

// Path is relative to sourceAbs. Returns true if the file should be kept.
function pathPassesFilters(rel) {
  const segments = rel.toLowerCase().split(sep);
  // Any segment matching any exclude → hard skip.
  for (const seg of segments) {
    for (const pat of excludes) {
      if (seg.includes(pat)) return false;
    }
  }
  // If includes were specified, at least one segment must match one.
  if (includes.length > 0) {
    let matched = false;
    for (const seg of segments) {
      for (const pat of includes) {
        if (seg.includes(pat)) { matched = true; break; }
      }
      if (matched) break;
    }
    if (!matched) return false;
  }
  return true;
}

// Auto-derive tags from the folder path. File at "Blue/cans/hero.png" gets
// tags ["pressed-assets" (global), "blue", "cans"]. Slugified so the agent
// can search by them via list_media(tag: "blue").
function derivedTags(rel) {
  const parentDir = dirname(rel);
  const segs = parentDir === "." || parentDir === "" ? [] : parentDir.split(sep);
  const folderTags = segs
    .map(slugify)
    .filter(Boolean)
    // De-dupe while preserving order.
    .filter((s, i, arr) => arr.indexOf(s) === i);
  const all = [tag, ...folderTags];
  return all.filter((s, i, arr) => arr.indexOf(s) === i);
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// -- impl ----------------------------------------------------------------

async function resolveOwner(emailFlag) {
  if (emailFlag) {
    const rows = await rest("GET", `/profiles?email=eq.${encodeURIComponent(emailFlag)}&select=id`);
    if (!rows[0]) fail(`No profile found for ${emailFlag}`);
    return rows[0].id;
  }
  // Try the single-admin shortcut.
  const admins = await rest("GET", "/profiles?role=eq.admin&select=id,email");
  if (admins.length === 1) return admins[0].id;
  if (admins.length === 0) fail("No admin profiles. Pass --owner=<email>.");
  fail(`Multiple admin profiles. Pass --owner=<email>. Candidates: ${admins.map((a) => a.email).join(", ")}`);
}

async function uploadOne({ absPath, relName, ownerId, tags }) {
  // Idempotency: skip if this owner already has a media asset with this name.
  const dupes = await rest(
    "GET",
    `/media_assets?owner_id=eq.${ownerId}&name=eq.${encodeURIComponent(relName)}&select=id`,
  );
  if (dupes[0]) return "skipped";

  const bytes = readFileSync(absPath);
  const mime = mimeFor(relName);
  const id = randomUUID();
  const storagePath = `users/${ownerId}/${id}/${relName}`;

  const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/media/${encodePath(storagePath)}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": mime,
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!upRes.ok) {
    throw new Error(`storage upload ${upRes.status}: ${(await upRes.text()).slice(0, 200)}`);
  }

  const inserted = await rest("POST", "/media_assets", {
    id,
    owner_id: ownerId,
    name: relName,
    storage_path: storagePath,
    mime,
    size_bytes: bytes.length,
    tags,
  });
  return inserted[0];
}

async function rest(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "apikey": SERVICE_KEY,
      "Content-Type": "application/json",
      "Prefer": method === "POST" ? "return=representation" : "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`PostgREST ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  if (res.status === 204) return [];
  return await res.json();
}

function walk(root, deep) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;          // .DS_Store, .git, etc.
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) { if (deep) visit(full); continue; }
      if (!st.isFile()) continue;
      out.push(full);
    }
  };
  visit(root);
  // Sort deterministically so retries upload in the same order.
  out.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
  return out;
}

function mimeFor(name) {
  const ext = extname(name).toLowerCase().replace(".", "");
  const map = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
    heic: "image/heic", avif: "image/avif", bmp: "image/bmp", tiff: "image/tiff",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
    pdf: "application/pdf",
    md: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

function encodePath(p) { return p.split("/").map(encodeURIComponent).join("/"); }

// Lightweight arg parser. Supports:
//   --flag           (boolean true)
//   --key=value      (single string)
//   --key=val (repeated occurrences accumulate into args.repeat[key])
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const bool = {};
  const repeat = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq < 0) {
        bool[a.slice(2)] = true;
      } else {
        const key = a.slice(2, eq);
        const val = a.slice(eq + 1);
        if (key in flags) {
          // Promote to repeat list.
          repeat[key] = repeat[key] ?? [flags[key]];
          repeat[key].push(val);
        } else if (key in repeat) {
          repeat[key].push(val);
        } else {
          flags[key] = val;
        }
      }
    } else {
      positional.push(a);
    }
  }
  // Anything that ended up in `flags` but also has multi-value semantics
  // should be accessible via repeat[key] too — fold singles into repeat for
  // the keys we know take lists.
  for (const multiKey of ["exclude", "include"]) {
    if (flags[multiKey] && !(multiKey in repeat)) {
      repeat[multiKey] = [flags[multiKey]];
    }
  }
  return { positional, flags, bool, repeat };
}

function log(s) { process.stdout.write(s + "\n"); }
function fail(s) { process.stderr.write(`error: ${s}\n`); process.exit(1); }
