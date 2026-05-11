#!/usr/bin/env bash
# Restart the local Supabase edge-functions runtime cleanly.
#
# The CLI's file-watcher hot-reload occasionally fails on a docker-container
# name conflict — the watcher tries to spin up a new container before the old
# one is gone. This script force-removes the stale container, then starts
# fresh.
#
# Usage:
#   bash scripts/restart-fn.sh        # blocks the terminal, tail logs live
#   bash scripts/restart-fn.sh &      # background

set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER="supabase_edge_runtime_hubbackend"

echo "→ removing $CONTAINER (if present)…"
docker rm -f "$CONTAINER" 2>/dev/null || true

echo "→ starting functions serve…"
exec npx supabase functions serve --env-file .env
