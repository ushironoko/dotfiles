#!/bin/sh
# Translate helper for the Zellij prefix-T binding in config.kdl.
# Reads the latest mouse selection captured by copy-capture.sh and deletes it
# immediately so selection text does not linger on disk.

umask 077

# plamo-translate requires TMPDIR for its local server discovery config.
TMPDIR=${TMPDIR:-/tmp}
export TMPDIR

dir="$TMPDIR/zellij-translate-${USER:-$(id -un)}"
capture="$dir/${ZELLIJ_SESSION_NAME:-default}.txt"
# copy-capture.sh runs from the zellij server, which may not have
# ZELLIJ_SESSION_NAME in its environment; fall back to the shared capture
# file so a session-name mismatch cannot make the selection "disappear"
[ -f "$capture" ] || capture="$dir/default.txt"

text=""
if [ -f "$capture" ]; then
  text=$(cat "$capture")
  rm -f "$capture"
fi

if [ -z "$text" ]; then
  echo "翻訳対象が空です (選択テキストがキャプチャされていません)"
else
  printf '%s\n' "$text" | plamo-translate --from English --to Japanese
fi

printf '\n[Enter で閉じる]'
read -r _
