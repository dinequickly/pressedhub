#!/usr/bin/env bash
# Phase B: Workflow CRUD round-trip.

source "$(dirname "$0")/_lib.sh"

section "Phase B: workflows CRUD"

[[ -f /tmp/hubbackend.alice.jwt ]] || fail "Run smoke-phase-a.sh first"
JWT=$(cat /tmp/hubbackend.alice.jwt)

WORKFLOW=$(jq -n '{
  name: "Inbox Triage",
  description: "Categorize new Gmail messages",
  category: "react",
  nodes: [
    { id: "t1", type: "trigger", connector: "gmail", operation: "new_email", config: {} },
    { id: "a1", type: "agent", role: "triage", instructions: "Classify the email into priority buckets.", tools: [] }
  ],
  edges: [{ from: "t1", to: "a1" }]
}')

CREATED=$(u_curl "$JWT" -X POST "${FN_URL}/workflows" -d "$WORKFLOW")
echo "$CREATED" | jq .
WID=$(jq -r '.id' <<<"$CREATED")
[[ "$WID" != "null" && -n "$WID" ]] || fail "No workflow id returned"
pass "Created workflow $WID"

LIST=$(u_curl "$JWT" "${FN_URL}/workflows")
[[ $(jq --arg id "$WID" '.data[] | select(.id == $id) | .id' <<<"$LIST") == "\"$WID\"" ]] \
  || fail "Workflow not in list"
pass "GET /workflows lists the workflow"

UPDATED=$(u_curl "$JWT" -X PATCH "${FN_URL}/workflows/${WID}" \
  -d '{"name":"Inbox Triage v2","description":"updated"}')
[[ $(jq -r '.name' <<<"$UPDATED") == "Inbox Triage v2" ]] || fail "Patch did not apply"
pass "PATCH /workflows/:id updates fields"

u_curl "$JWT" -X DELETE "${FN_URL}/workflows/${WID}"
pass "DELETE /workflows/:id removes the workflow"
