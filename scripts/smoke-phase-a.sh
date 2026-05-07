#!/usr/bin/env bash
# Phase A: Auth + profiles + connectors.
# Verifies: a fresh user can sign up, profiles row auto-creates, bootstrap
# admin works, connectors are seeded and visible.

source "$(dirname "$0")/_lib.sh"

section "Phase A: signup + profile + connectors"

EMAIL="alice+$(date +%s)@hubbackend.test"
PASSWORD="HubPassA123!"

JWT=$(signup_admin_user "$EMAIL" "$PASSWORD")
[[ -n "$JWT" ]] || fail "Failed to obtain JWT"
pass "Signed up $EMAIL"

ME=$(u_curl "$JWT" "${FN_URL}/profiles/me")
echo "$ME" | jq .
[[ $(jq -r '.email' <<<"$ME") == "$EMAIL" ]] || fail "Profile email mismatch"
pass "GET /profiles/me returns profile"

PROMOTED=$(u_curl "$JWT" -X POST "${FN_URL}/profiles/bootstrap-admin")
echo "$PROMOTED" | jq .
pass "POST /profiles/bootstrap-admin returns ${PROMOTED}"

ME2=$(u_curl "$JWT" "${FN_URL}/profiles/me")
echo "$ME2" | jq -r '"Role: \(.role)"'

CONNECTORS=$(u_curl "$JWT" "${FN_URL}/connectors")
COUNT=$(jq '.data | length' <<<"$CONNECTORS")
[[ "$COUNT" -gt 40 ]] || fail "Expected >40 connectors, got $COUNT"
pass "GET /connectors returns $COUNT connectors"

echo "$JWT" > /tmp/hubbackend.alice.jwt
echo "$EMAIL" > /tmp/hubbackend.alice.email
pass "Phase A passed. JWT cached at /tmp/hubbackend.alice.jwt"
