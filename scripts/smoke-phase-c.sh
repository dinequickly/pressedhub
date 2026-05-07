#!/usr/bin/env bash
# Phase C: Anthropic Managed Agents end-to-end.
# This is the slowest test and the one most likely to bill credits. It is
# skipped if ANTHROPIC_API_KEY is not set.

source "$(dirname "$0")/_lib.sh"

section "Phase C: Anthropic agent + environment + session"

if [[ -z "${ANTHROPIC_API_KEY:-}" || "${ANTHROPIC_API_KEY}" != sk-ant-api* ]]; then
  printf '\033[1;33m⊘ Skipping (ANTHROPIC_API_KEY not set)\033[0m\n'
  exit 0
fi

[[ -f /tmp/hubbackend.alice.jwt ]] || fail "Run smoke-phase-a.sh first"
JWT=$(cat /tmp/hubbackend.alice.jwt)

# Create environment.
ENV_BODY=$(jq -n '{ name: ("smoke-env-" + (now | tostring)), config: {type:"cloud", networking:{type:"unrestricted"}} }')
ENV=$(u_curl "$JWT" -X POST "${FN_URL}/environments" -d "$ENV_BODY")
ENV_ID=$(jq -r '.id' <<<"$ENV")
[[ -n "$ENV_ID" && "$ENV_ID" != "null" ]] || fail "No environment id"
pass "Created environment $ENV_ID"

# Create agent.
AGENT_BODY=$(jq -n '{ name:"Smoke Agent", model:"claude-opus-4-7", system_prompt:"You are a helpful assistant.", instructions:"" }')
AGENT=$(u_curl "$JWT" -X POST "${FN_URL}/agents" -d "$AGENT_BODY")
AGENT_ID=$(jq -r '.id' <<<"$AGENT")
[[ -n "$AGENT_ID" && "$AGENT_ID" != "null" ]] || fail "No agent id"
pass "Created agent $AGENT_ID"

# Start session with an initial_message.
SESSION_BODY=$(jq -n --arg a "$AGENT_ID" --arg e "$ENV_ID" '{
  agent_id:$a, environment_id:$e, title:"Smoke session",
  initial_message:"Reply with the single word HELLO."
}')
SESSION=$(u_curl "$JWT" -X POST "${FN_URL}/sessions" -d "$SESSION_BODY")
SID=$(jq -r '.id' <<<"$SESSION")
ANT=$(jq -r '.anthropic_id' <<<"$SESSION")
[[ -n "$ANT" && "$ANT" != "null" ]] || fail "No anthropic session id"
pass "Started session $SID (anthropic $ANT)"

# Tail the stream for up to 60s, breaking when status_idle arrives.
section "Streaming events (will stop after session.status_idle or 60s)"
timeout 60 curl -fsS -N \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${JWT}" \
  "${FN_URL}/sessions/${SID}/stream" 2>/dev/null \
  | head -c 8192 || true
echo

# Confirm events were persisted to session_events.
EVENTS=$(u_curl "$JWT" "${FN_URL}/runs/${SID}")
COUNT=$(jq '.events | length' <<<"$EVENTS")
[[ "$COUNT" -gt 0 ]] || fail "No events persisted"
pass "Persisted $COUNT session events"
