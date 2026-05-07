#!/usr/bin/env bash
# Phase D: Memory + dreams.

source "$(dirname "$0")/_lib.sh"

section "Phase D: memory stores + dreams"

[[ -f /tmp/hubbackend.alice.jwt ]] || fail "Run smoke-phase-a.sh first"
JWT=$(cat /tmp/hubbackend.alice.jwt)

# Create a store.
STORE=$(u_curl "$JWT" -X POST "${FN_URL}/memory/stores" \
  -d '{"name":"smoke","description":"smoke test","scope":"user"}')
SID=$(jq -r '.id' <<<"$STORE")
[[ -n "$SID" && "$SID" != "null" ]] || fail "No store id"
pass "Created memory store $SID"

# Upsert a doc.
u_curl "$JWT" -X POST "${FN_URL}/memory/upsert/document" \
  -d "$(jq -n --arg s "$SID" '{store_id:$s, path:"context/notes.md", content:"# Notes\n- alpha\n- beta"}')" | jq .
pass "Upserted memory doc"

# Read it back.
QUERY=$(u_curl "$JWT" -X POST "${FN_URL}/memory/query" \
  -d "$(jq -n --arg s "$SID" '{store_id:$s, path:"context/notes.md"}')")
[[ $(jq -r '.document.content' <<<"$QUERY") == *"alpha"* ]] || fail "Document content mismatch"
pass "Memory query returns the document"

# Create a dream that adds a doc and changes the existing one.
DREAM_BODY=$(jq -n --arg s "$SID" '{
  store_id:$s,
  instructions:"Refactor notes",
  new_snapshot:[
    { path:"context/notes.md", content:"# Notes (revised)\n- alpha\n- beta\n- gamma" },
    { path:"context/extra.md", content:"Extra info" }
  ]
}')
DREAM=$(u_curl "$JWT" -X POST "${FN_URL}/dreams" -d "$DREAM_BODY")
DID=$(jq -r '.id' <<<"$DREAM")
[[ -n "$DID" && "$DID" != "null" ]] || fail "No dream id"
pass "Created dream $DID"
echo "$DREAM" | jq '.diff'

# Approve the dream.
u_curl "$JWT" -X POST "${FN_URL}/dreams/${DID}/decide" -d '{"decision":"approve"}' | jq .
pass "Approved dream"

# Confirm the doc was applied.
QUERY2=$(u_curl "$JWT" -X POST "${FN_URL}/memory/query" \
  -d "$(jq -n --arg s "$SID" '{store_id:$s, path:"context/extra.md"}')")
[[ $(jq -r '.document.content' <<<"$QUERY2") == "Extra info" ]] || fail "Dream did not apply"
pass "Dream applied to memory store"
