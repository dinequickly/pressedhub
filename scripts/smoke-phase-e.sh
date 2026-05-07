#!/usr/bin/env bash
# Phase E: Skills + MCP servers. Skipped if ANTHROPIC_API_KEY is unset
# (the create path hits Anthropic).

source "$(dirname "$0")/_lib.sh"

section "Phase E: skills + mcp servers"

[[ -f /tmp/hubbackend.alice.jwt ]] || fail "Run smoke-phase-a.sh first"
JWT=$(cat /tmp/hubbackend.alice.jwt)

# MCP server (no Anthropic round-trip).
MCP=$(u_curl "$JWT" -X POST "${FN_URL}/mcp-servers" \
  -d '{"name":"github","url":"https://api.githubcopilot.com/mcp/","description":"GitHub MCP"}')
MID=$(jq -r '.id' <<<"$MCP")
[[ -n "$MID" && "$MID" != "null" ]] || fail "No MCP id"
pass "Registered MCP server $MID"

if [[ -z "${ANTHROPIC_API_KEY:-}" || "${ANTHROPIC_API_KEY}" != sk-ant-api* ]]; then
  printf '\033[1;33m⊘ Skipping skill creation (ANTHROPIC_API_KEY not set)\033[0m\n'
  exit 0
fi

# Anthropic skill.
SKILL=$(u_curl "$JWT" -X POST "${FN_URL}/skills" \
  -d '{"type":"anthropic","name":"Excel","description":"Spreadsheet operations","content_md":"","anthropic_skill_id":"xlsx"}')
SKID=$(jq -r '.id' <<<"$SKILL")
[[ -n "$SKID" && "$SKID" != "null" ]] || fail "No skill id"
pass "Registered anthropic skill $SKID"
