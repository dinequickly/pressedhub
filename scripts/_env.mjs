// Shared env loader for seed/upload scripts.
//
// Reads .env from the repo root and returns a resolved environment record.
// With `--env=cloud` (passed in argv), substitutes any keys matching
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / EXTERNAL_SUPABASE_URL with their
// CLOUD_ prefixed counterparts so the same script can target either local
// dev or your deployed Supabase project without manually editing .env.
//
// Define in .env:
//   SUPABASE_URL=http://127.0.0.1:54321
//   SUPABASE_SERVICE_ROLE_KEY=<local key>
//   CLOUD_SUPABASE_URL=https://<project>.supabase.co
//   CLOUD_SUPABASE_SERVICE_ROLE_KEY=<prod service role key>
//
// Usage in a script:
//   import { loadEnv, splitEnvArg } from "./_env.mjs";
//   const { argv, target } = splitEnvArg(process.argv.slice(2));
//   const env = loadEnv(target);
//
// `splitEnvArg` strips the `--env=...` flag out so each script's own arg
// parser doesn't have to think about it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_PATH = resolve(import.meta.dirname, "..", ".env");

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (m[0].trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const SWAPPABLE = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "EXTERNAL_SUPABASE_URL",
];

export function loadEnv(target = "local") {
  const raw = parseEnv(readFileSync(ENV_PATH, "utf8"));
  if (target === "local") return raw;
  if (target !== "cloud") {
    throw new Error(`unknown --env value "${target}" (expected local|cloud)`);
  }
  const out = { ...raw };
  for (const key of SWAPPABLE) {
    const cloudKey = `CLOUD_${key}`;
    if (raw[cloudKey]) out[key] = raw[cloudKey];
  }
  // Sanity: confirm the cloud URL actually looks like a real one.
  const url = out.SUPABASE_URL ?? "";
  if (!url.startsWith("https://")) {
    throw new Error(
      `--env=cloud but CLOUD_SUPABASE_URL isn't set (or doesn't start with https://). ` +
        `Add it to .env first.`,
    );
  }
  if (!out.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("--env=cloud but CLOUD_SUPABASE_SERVICE_ROLE_KEY isn't set in .env.");
  }
  return out;
}

// Pull `--env=...` out of argv, default to local. Returns the remaining
// args (sans the env flag) plus the resolved target name.
export function splitEnvArg(argv) {
  const out = [];
  let target = "local";
  for (const a of argv) {
    const m = a.match(/^--env=(.+)$/);
    if (m) { target = m[1]; continue; }
    out.push(a);
  }
  return { argv: out, target };
}
