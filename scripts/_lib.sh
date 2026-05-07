#!/usr/bin/env bash
# Shared helpers for smoke test scripts. Source this from each phase script.

set -euo pipefail

# Load .env if present.
if [[ -f "$(dirname "$0")/../.env" ]]; then
  # shellcheck disable=SC1091
  set -o allexport
  . "$(dirname "$0")/../.env"
  set +o allexport
fi

: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY is required}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required}"

FN_URL="${SUPABASE_URL%/}/functions/v1"

# Pretty section header.
section() {
  printf '\n\033[1;36m▶ %s\033[0m\n' "$1"
}

# Pretty failure.
fail() {
  printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2
  exit 1
}

# Pretty pass.
pass() {
  printf '\033[1;32m✓ %s\033[0m\n' "$1"
}

# Auth-ed curl using the service role key (bypasses RLS — only use this where
# tests need cross-user setup; functional smoke tests should mint a real user
# JWT via supabase.auth.signUp).
sk_curl() {
  curl -fsS \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    "$@"
}

# Sign up a fresh user via the GoTrue admin API; returns the new JWT.
# Usage: tok=$(signup_admin_user "alice@example.com" "Hubpass123!")
signup_admin_user() {
  local email="$1" password="$2"
  local body
  body=$(jq -n --arg email "$email" --arg password "$password" \
    '{email:$email, password:$password, email_confirm:true}')
  sk_curl -X POST "${SUPABASE_URL}/auth/v1/admin/users" -d "$body" >/dev/null
  # Sign in to obtain a JWT.
  jq -n --arg email "$email" --arg password "$password" '{email:$email, password:$password}' |
    curl -fsS -H "apikey: ${SUPABASE_ANON_KEY}" -H "Content-Type: application/json" \
      -d @- "${SUPABASE_URL}/auth/v1/token?grant_type=password" | jq -r '.access_token'
}

# Bearer auth curl with the supplied user JWT.
u_curl() {
  local jwt="$1"; shift
  curl -fsS \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${jwt}" \
    -H "Content-Type: application/json" \
    "$@"
}
