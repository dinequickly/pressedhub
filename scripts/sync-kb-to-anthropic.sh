#!/usr/bin/env bash
# Upload a single KB file directly to Anthropic Files, bypassing the Edge
# Function's 150s wall clock. Use this for files large enough that
# /kb/files/:id/sync-to-anthropic times out.
#
# Usage:
#   bash scripts/sync-kb-to-anthropic.sh <kb_file_id>
#
# Reads ANTHROPIC_API_KEY, ANTHROPIC_BETA_HEADER, SUPABASE_URL,
# SUPABASE_SERVICE_ROLE_KEY from .env.

set -euo pipefail

if [[ ! -f "$(dirname "$0")/../.env" ]]; then
  echo "✗ .env not found at repo root" >&2
  exit 1
fi
# shellcheck disable=SC1091
set -o allexport
. "$(dirname "$0")/../.env"
set +o allexport

: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY required}"
: "${ANTHROPIC_BETA_HEADER:?ANTHROPIC_BETA_HEADER required}"
: "${SUPABASE_URL:?SUPABASE_URL required}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY required}"

KB_ID="${1:-}"
if [[ -z "$KB_ID" ]]; then
  echo "Usage: $0 <kb_file_id>" >&2
  exit 1
fi

echo "▶ Looking up kb_file $KB_ID"
ROW=$(curl -fsS \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  "${SUPABASE_URL}/rest/v1/kb_files?select=id,name,storage_path,anthropic_file_id&id=eq.${KB_ID}")
if [[ "$ROW" == "[]" ]]; then
  echo "✗ kb_file not found" >&2
  exit 1
fi
NAME=$(echo "$ROW" | jq -r '.[0].name')
STORAGE_PATH=$(echo "$ROW" | jq -r '.[0].storage_path')
EXISTING=$(echo "$ROW" | jq -r '.[0].anthropic_file_id // empty')

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
LOCAL="$TMP/$NAME"

echo "▶ Downloading from Storage → $LOCAL"
# URL-encode each path segment so spaces/uppercase/special chars survive curl.
ENCODED_PATH=$(printf '%s' "$STORAGE_PATH" | jq -sRr 'split("/") | map(@uri) | join("/")')
curl -fsS \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -o "$LOCAL" \
  "${SUPABASE_URL}/storage/v1/object/kb/${ENCODED_PATH}"
SIZE=$(stat -f%z "$LOCAL" 2>/dev/null || stat -c%s "$LOCAL")
echo "  $(printf '%.1f' "$(echo "$SIZE / 1024 / 1024" | bc -l)") MB"

if [[ -n "$EXISTING" ]]; then
  echo "▶ Deleting prior Anthropic file $EXISTING (best-effort)"
  curl -sS -X DELETE \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: $ANTHROPIC_BETA_HEADER" \
    "https://api.anthropic.com/v1/files/${EXISTING}" > /dev/null || true
fi

echo "▶ Uploading to Anthropic Files (no timeout, this can take a while)"
UPLOAD=$(curl -fsS \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: $ANTHROPIC_BETA_HEADER" \
  -F "purpose=agent" \
  -F "file=@${LOCAL}" \
  "https://api.anthropic.com/v1/files")
NEW_ID=$(echo "$UPLOAD" | jq -r '.id')
if [[ -z "$NEW_ID" || "$NEW_ID" == "null" ]]; then
  echo "✗ Upload failed: $UPLOAD" >&2
  exit 1
fi
echo "  → $NEW_ID"

echo "▶ Patching kb_files.anthropic_file_id"
curl -fsS -X PATCH \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  -d "$(jq -n --arg aid "$NEW_ID" '{anthropic_file_id: $aid}')" \
  "${SUPABASE_URL}/rest/v1/kb_files?id=eq.${KB_ID}" > /dev/null

printf '\n\033[1;32m✓ Synced %s → %s\033[0m\n' "$NAME" "$NEW_ID"
echo "  kb_attach will now mount this file instantly without re-uploading."
