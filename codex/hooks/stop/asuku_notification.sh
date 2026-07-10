#!/usr/bin/env bash
# Codex has no Notification event; Stop is the nearest completion notification.
set -u

ASUKU=/Applications/asuku.app/Contents/MacOS/asuku-hook
[ -x "$ASUKU" ] || { cat >/dev/null; exit 0; }

INPUT=$(cat 2>/dev/null || true)
# Stop stdout is parsed as hook JSON. Detach the notifier and discard both
# streams so a human-facing asuku message can never become invalid hook output.
printf '%s' "$INPUT" | nohup "$ASUKU" notification >/dev/null 2>&1 &
exit 0
