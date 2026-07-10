#!/usr/bin/env bash
# Run the repository formatter after apply_patch changes JavaScript/TypeScript.
set -euo pipefail

INPUT=$(cat)
command -v jq >/dev/null 2>&1 || exit 0

PATCH=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
LEGACY_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0

SHOULD_FORMAT=0
if [ -n "$LEGACY_PATH" ] && printf '%s\n' "$LEGACY_PATH" | grep -Eq '\.(js|ts)$'; then
  SHOULD_FORMAT=1
elif [ -n "$PATCH" ] && printf '%s\n' "$PATCH" \
  | grep -Eq '^\*\*\* (Add|Update|Delete) File: .+\.(js|ts)$|^\*\*\* Move to: .+\.(js|ts)$'; then
  SHOULD_FORMAT=1
fi
[ "$SHOULD_FORMAT" -eq 1 ] || exit 0

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || exit 0
[ -n "$CWD" ] && [ -d "$CWD" ] || CWD=$PWD

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TRUST_LIB="$SCRIPT_DIR/../lib/trusted_project.sh"
[ -r "$TRUST_LIB" ] || exit 0
# shellcheck source=codex/hooks/lib/trusted_project.sh
source "$TRUST_LIB"
command -v bun >/dev/null 2>&1 || exit 0

DIR=$CWD
PKG=""
while :; do
  if [ -f "$DIR/package.json" ]; then
    PKG="$DIR/package.json"
    break
  fi
  [ "$DIR" = "/" ] && break
  PARENT=$(dirname "$DIR")
  [ "$PARENT" = "$DIR" ] && break
  DIR=$PARENT
done

[ -n "$PKG" ] || exit 0
codex_project_is_trusted "$DIR" || exit 0
jq -e '.scripts.format | type == "string"' "$PKG" >/dev/null 2>&1 || exit 0

if ! (cd "$DIR" && bun run format >/dev/null 2>&1); then
  jq -n '{
    decision: "block",
    reason: "apply_patch後の `bun run format` が失敗しました。formatterのエラーを確認し、修正後に再実行してください。",
    systemMessage: "PostToolUse coding cycle: formatter failed"
  }'
fi
