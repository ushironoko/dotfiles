#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
TASK_ID=$(printf '%s' "$INPUT" | jq -r '.task_id // empty')
TASK_SUBJECT=$(printf '%s' "$INPUT" | jq -r '.task_subject // empty')

# task_idがなければ何もしない
[ -z "$TASK_ID" ] && exit 0

# branch名取得（worktree内のHEADから）
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
[ -z "$BRANCH" ] && exit 0

# GIT_DIR取得（worktree/main両対応）
# git rev-parse --git-common-dir はworktree内でも共有.gitパスを返す
MAIN_GIT="$(git rev-parse --git-common-dir 2>/dev/null)"
[ -d "$MAIN_GIT" ] || exit 0

# bit存在チェック
command -v bit &>/dev/null || exit 0

# [task:<branch>:<task_id>] を含むopen issueを検索
# bit issue list出力形式: "#<id> [open] <title>"
ISSUE_LINE=$(GIT_DIR="$MAIN_GIT" bit issue list --open 2>/dev/null | grep "\[task:${BRANCH}:${TASK_ID}\]" || true)
[ -z "$ISSUE_LINE" ] && exit 0

# issue IDを抽出
ISSUE_ID=$(printf '%s' "$ISSUE_LINE" | head -1 | sed 's/^#\([^ ]*\).*/\1/')
[ -z "$ISSUE_ID" ] && exit 0

# comment add + close
GIT_DIR="$MAIN_GIT" bit issue comment add "$ISSUE_ID" \
  --body "Task completed: ${TASK_SUBJECT}" 2>/dev/null || true

GIT_DIR="$MAIN_GIT" bit issue close "$ISSUE_ID" 2>/dev/null || true
