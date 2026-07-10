#!/usr/bin/env bash
# Deny relay-backed or importing bit commands before Codex executes Bash.
set -euo pipefail

INPUT=$(cat)
command -v jq >/dev/null 2>&1 || exit 0

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0

REASON=""
if printf '%s\n' "$CMD" | grep -Eq '(^|[^[:alnum:]_.-])bit[[:space:]]+issue[[:space:]]+(claim|unclaim|claims|watch|import)([[:space:]]|$)'; then
  REASON='bit issue claim/unclaim/claims/watch/import は relay または外部取り込みを伴うため禁止されています。list/view/create/update/comment/close などのローカル操作を使用してください。'
elif printf '%s\n' "$CMD" | grep -Eq '(^|[^[:alnum:]_.-])bit[[:space:]]+pr[[:space:]]+import([[:space:]]|$)'; then
  REASON='bit pr import は外部サービスへ接続し得るため禁止されています。'
elif printf '%s\n' "$CMD" | grep -Eq '(^|[^[:alnum:]_.-])bit[[:space:]]+relay([[:space:]]|$)'; then
  REASON='bit relay はローカル issue 情報を外部へ送信し得るため禁止されています。'
elif printf '%s\n' "$CMD" | grep -Eq '(^|[^[:alnum:]_.-])bit[[:space:]]+clone[[:space:]]+relay\+[^[:space:];|&)]*'; then
  REASON='bit clone relay+... は relay 経由のcloneであるため禁止されています。'
fi

[ -n "$REASON" ] || exit 0

jq -n --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  },
  systemMessage: "bit の relay/import 系コマンドを安全ポリシーにより拒否しました。"
}'
