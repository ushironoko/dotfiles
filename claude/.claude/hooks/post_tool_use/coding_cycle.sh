#!/usr/bin/env bash
# PostToolUse hook (Write|Edit|MultiEdit): run the repository format script
# after a JavaScript/TypeScript file changes. Fires only when the nearest
# package.json (walking up from the edited file) defines scripts.format; a
# formatter failure feeds back as a block decision so the agent fixes it.
set -euo pipefail

INPUT=$(cat)
command -v jq >/dev/null 2>&1 || exit 0

# Malformed JSON must stay silent (exit 0), matching the documented contract.
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[ -n "$FILE_PATH" ] || exit 0
printf '%s\n' "$FILE_PATH" | grep -Eq '\.(js|ts)$' || exit 0

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || exit 0
[ -n "$CWD" ] && [ -d "$CWD" ] || CWD=$PWD

# Locate the nearest package.json upward from the edited file (falls back to
# the session cwd when the file's directory does not exist).
case "$FILE_PATH" in
  /*) DIR=$(dirname "$FILE_PATH") ;;
  *) DIR=$(dirname "$CWD/$FILE_PATH") ;;
esac
[ -d "$DIR" ] || DIR=$CWD

command -v bun >/dev/null 2>&1 || exit 0

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
jq -e '.scripts.format | type == "string"' "$PKG" >/dev/null 2>&1 || exit 0

if ! (cd "$DIR" && bun run format >/dev/null 2>&1); then
  jq -n '{
    decision: "block",
    reason: "編集後の `bun run format` が失敗しました。formatterのエラーを確認し、修正後に再実行してください。",
    systemMessage: "PostToolUse coding cycle: formatter failed"
  }'
fi
