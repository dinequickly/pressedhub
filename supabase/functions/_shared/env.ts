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
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  // Groq inference — used for per-row LLM calls in /kb ai-fill. Default
  // model is openai/gpt-oss-20b (cheap, fast, fine for cell-fill).
  "GROQ_API_KEY",
  "GROQ_MODEL",
  // Slack: required for the OAuth dance + Events API webhook signature.
  // Slack rejects requests if any of these is wrong, so we treat them as
  // optional at boot but let the relevant handlers surface a 500 on use.
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  // Where the Slack OAuth callback lands. Should be a public URL pointing
  // at /functions/v1/slack-oauth/callback. Set to the local supabase URL in
  // dev (use ngrok or a tunnel for testing).
  "PUBLIC_FUNCTIONS_URL",
  // Where to bounce the user back to after OAuth completes (the hub UI).
  "HUB_BASE_URL",
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
  OPENAI_API_KEY: env("OPENAI_API_KEY") ?? "",
  GEMINI_API_KEY: env("GEMINI_API_KEY") ?? "",
  GROQ_API_KEY: env("GROQ_API_KEY") ?? "",
  GROQ_MODEL: env("GROQ_MODEL") ?? "openai/gpt-oss-20b",
  SLACK_CLIENT_ID: env("SLACK_CLIENT_ID") ?? "",
  SLACK_CLIENT_SECRET: env("SLACK_CLIENT_SECRET") ?? "",
  SLACK_SIGNING_SECRET: env("SLACK_SIGNING_SECRET") ?? "",
  PUBLIC_FUNCTIONS_URL: env("PUBLIC_FUNCTIONS_URL") ?? "",
  HUB_BASE_URL: env("HUB_BASE_URL") ?? "",
} as const;
