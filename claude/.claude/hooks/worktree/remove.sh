#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/share/mise/installs/github-d-kuro-gwq/0.0.17:$PATH"

INPUT=$(cat)
WORKTREE_PATH=$(printf '%s' "$INPUT" | jq -r '.worktree_path')

# パスが存在しなければ何もしない
[ -d "$WORKTREE_PATH" ] || exit 0

# worktree パスからブランチ名を逆引き
BRANCH=$(git worktree list --porcelain | awk -v path="$WORKTREE_PATH" '
  /^worktree / { wt=substr($0, 10) }
  /^branch /   { if (wt == path) { b=substr($0, 8); sub(/^refs\/heads\//, "", b); print b } }
')

if [ -n "$BRANCH" ]; then
  # gwq失敗時はgit worktree removeにフォールバック
  gwq remove -f -b "$BRANCH" >&2 || git worktree remove --force "$WORKTREE_PATH" >&2 || true
else
  # ブランチ名が取れない場合は git worktree remove で直接削除
  git worktree remove --force "$WORKTREE_PATH" >&2 || true
fi
