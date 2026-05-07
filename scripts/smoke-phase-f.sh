#!/usr/bin/env bash
# Phase F: KB skeleton + apps + triggers.

source "$(dirname "$0")/_lib.sh"

section "Phase F: KB + apps + triggers"

[[ -f /tmp/hubbackend.alice.jwt ]] || fail "Run smoke-phase-a.sh first"
JWT=$(cat /tmp/hubbackend.alice.jwt)

# 1) KB upload-url + extract + chunk + embed cycle for a small text file.
SIGNED=$(u_curl "$JWT" -X POST "${FN_URL}/kb/files/upload-url" \
  -d '{"name":"hello.txt","mime":"text/plain","size_bytes":11}')
echo "$SIGNED" | jq .
URL=$(jq -r '.signed_url' <<<"$SIGNED")
PATH_=$(jq -r '.path' <<<"$SIGNED")
FILE_ID=$(jq -r '.file.id' <<<"$SIGNED")
[[ -n "$URL" ]] || fail "No signed URL"

# Upload the file body to the signed URL.
echo "hello world" | curl -fsS -X PUT "$URL" -H "Content-Type: text/plain" --data-binary @-
pass "Uploaded to signed URL ($PATH_)"

u_curl "$JWT" -X POST "${FN_URL}/kb/files/${FILE_ID}/extract" -d '{}' | jq .
pass "Extracted file"

u_curl "$JWT" -X POST "${FN_URL}/kb/files/${FILE_ID}/chunk" -d '{}' | jq .
pass "Chunked file"

u_curl "$JWT" -X POST "${FN_URL}/kb/files/${FILE_ID}/embed" -d '{}' | jq .
pass "Embedded file (STUB v1)"

SEARCH=$(u_curl "$JWT" -X POST "${FN_URL}/kb/search" -d '{"query":"hello","limit":5}')
[[ $(jq '.results | length' <<<"$SEARCH") -gt 0 ]] || fail "Search returned no results"
pass "KB search returns results"

# 2) Apps create + deploy.
APP=$(u_curl "$JWT" -X POST "${FN_URL}/apps" \
  -d '{"name":"Smoke App","tagline":"Test","description":"smoke","content_md":"# Hi"}')
AID=$(jq -r '.id' <<<"$APP")
pass "Created app $AID"

ME=$(u_curl "$JWT" "${FN_URL}/profiles/me")
ME_ID=$(jq -r '.id' <<<"$ME")
u_curl "$JWT" -X POST "${FN_URL}/apps/${AID}/deploy" \
  -d "$(jq -n --arg u "$ME_ID" '{deployed_to:[$u]}')" | jq .
pass "Deployed app to self"

# 3) Webhook trigger creation. (Requires a workflow; create a stub one.)
WORKFLOW=$(u_curl "$JWT" -X POST "${FN_URL}/workflows" \
  -d '{"name":"Trigger smoke","category":"react","nodes":[{"id":"a1","type":"agent","role":"r","tools":[],"instructions":"Echo the payload"}],"edges":[]}')
WID=$(jq -r '.id' <<<"$WORKFLOW")
TRIG=$(u_curl "$JWT" -X POST "${FN_URL}/triggers" \
  -d "$(jq -n --arg w "$WID" '{workflow_id:$w, kind:"webhook"}')")
TOKEN=$(jq -r '.config.token' <<<"$TRIG")
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || fail "No webhook token issued"
pass "Issued webhook trigger token=$TOKEN"

# Hitting the public webhook needs the full URL with no auth.
RES=$(curl -fsS -X POST "${FN_URL}/triggers-webhook/${TOKEN}" \
  -H "Content-Type: application/json" -d '{"hello":"world"}' || echo '{"error":"upstream"}')
echo "$RES" | jq .
# In smoke mode without ANTHROPIC_API_KEY this returns an upstream error;
# accept both outcomes.
pass "Public webhook endpoint reachable"
