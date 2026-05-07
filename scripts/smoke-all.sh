#!/usr/bin/env bash
# Run every phase in order, stopping on the first failure.
set -e
HERE="$(dirname "$0")"
bash "$HERE/smoke-phase-a.sh"
bash "$HERE/smoke-phase-b.sh"
bash "$HERE/smoke-phase-c.sh"
bash "$HERE/smoke-phase-d.sh"
bash "$HERE/smoke-phase-e.sh"
bash "$HERE/smoke-phase-f.sh"
echo
echo "All phases passed."
