#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/share/mise/installs/github-d-kuro-gwq/0.0.17:$PATH"

INPUT=$(cat)
NAME=$(printf '%s' "$INPUT" | jq -r '.name // empty')

# name が空なら何もしない
[ -z "$NAME" ] && exit 1

# gwq add の出力は stderr へ（stdout は絶対パス専用）
gwq add -b "$NAME" >&2

# gwq get で worktree の絶対パスを取得し stdout に出力
gwq get "$NAME"
