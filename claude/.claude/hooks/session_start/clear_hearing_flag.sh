#!/usr/bin/env bash
# セッション開始時にフラグをクリア

FLAG_FILE="/tmp/.claude_hearing_done"
rm -f "$FLAG_FILE"

exit 0
