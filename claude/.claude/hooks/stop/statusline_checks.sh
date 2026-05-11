#!/bin/bash
input=$(cat 2>/dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$cwd" ] && cwd="$PWD"
exec "$HOME/.claude/hooks/lib/statusline_checks_run.sh" "$cwd"
