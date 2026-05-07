// Centralized env-var resolution. Edge functions never call Deno.env.get
// directly — they pull from this module so missing values fail loudly with a
// useful message at boot time instead of when the request hits a code path.

const required = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
] as const;

const optional = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_WEBHOOK_SIGNING_KEY",
  "ANTHROPIC_BETA_HEADER",
  "ANTHROPIC_DEFAULT_MODEL",
] as const;

type RequiredKey = (typeof required)[number];
type OptionalKey = (typeof optional)[number];
type EnvKey = RequiredKey | OptionalKey;

function read(key: EnvKey): string | undefined {
  return Deno.env.get(key);
}

export function env(key: RequiredKey): string;
export function env(key: OptionalKey): string | undefined;
export function env(key: EnvKey): string | undefined {
  const value = read(key);
  if ((required as readonly string[]).includes(key) && !value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

export const ENV = {
  SUPABASE_URL: env("SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: env("SUPABASE_SERVICE_ROLE_KEY"),
  SUPABASE_ANON_KEY: env("SUPABASE_ANON_KEY"),
  ANTHROPIC_API_KEY: env("ANTHROPIC_API_KEY") ?? "",
  ANTHROPIC_WEBHOOK_SIGNING_KEY: env("ANTHROPIC_WEBHOOK_SIGNING_KEY") ?? "",
  ANTHROPIC_BETA_HEADER: env("ANTHROPIC_BETA_HEADER") ?? "managed-agents-2026-04-01",
  ANTHROPIC_DEFAULT_MODEL: env("ANTHROPIC_DEFAULT_MODEL") ?? "claude-opus-4-7",
} as const;
