#!/bin/sh
# copy_command hook for Zellij (see config.kdl). Zellij pipes the selected
# text to stdin when a mouse selection is released; setting copy_command
# disables OSC52, so forwarding to pbcopy is this script's responsibility.
# The capture file feeds translate-popup.sh (prefix t). Empty input (a stray
# click) is discarded so it cannot clobber the last real selection.
# Zellij reaps the copy command after 1 second — keep this fast (no network).

set -eu

umask 077

dir="${TMPDIR:-/tmp}/zellij-translate-${USER:-$(id -un)}"
mkdir -p "$dir"

incoming="$dir/.incoming.$$"
cat > "$incoming"

if [ -s "$incoming" ]; then
  pbcopy < "$incoming"
  mv -f "$incoming" "$dir/${ZELLIJ_SESSION_NAME:-default}.txt"
else
  rm -f "$incoming"
fi
