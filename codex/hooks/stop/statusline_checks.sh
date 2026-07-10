#!/usr/bin/env bash
# Refresh the quality cache after the turn without holding the Stop hook open.
set -u

INPUT=$(cat 2>/dev/null || true)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$CWD" ] || CWD=$PWD

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
RUNNER="$SCRIPT_DIR/../lib/statusline_checks_run.sh"
[ -r "$RUNNER" ] || exit 0

nohup bash "$RUNNER" "$CWD" >/dev/null 2>&1 </dev/null &
exit 0
