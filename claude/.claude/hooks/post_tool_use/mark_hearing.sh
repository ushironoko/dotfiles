#!/usr/bin/env bash
# AskUserQuestion使用時にフラグを立てる

FLAG_FILE="/tmp/.claude_hearing_done"
PERMISSION_MODE=$(cat)

if [[ "$PERMISSION_MODE" == "plan" ]]; then
  touch "$FLAG_FILE"
fi

exit 0
