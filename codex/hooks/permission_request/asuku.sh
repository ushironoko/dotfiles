#!/usr/bin/env bash
# Preserve the external approval bridge only on machines where asuku is installed.
set -u

ASUKU=/Applications/asuku.app/Contents/MacOS/asuku-hook
[ -x "$ASUKU" ] || { cat >/dev/null; exit 0; }

exec "$ASUKU" permission-request
