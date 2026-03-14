#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${HOME}/.claude/hooks/task-completed/debug.log"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG_FILE"
}

log "=== TaskCompleted hook fired ==="
log "CWD: $(pwd)"

# Required dependencies: jq, git, bit (bit is optional — script exits gracefully if missing)
for cmd in jq git; do
  if ! command -v "$cmd" &>/dev/null; then
    log "ABORT: $cmd not found"
    exit 0
  fi
done

INPUT=$(cat)
log "INPUT: ${INPUT}"
TASK_ID=$(printf '%s' "$INPUT" | jq -r '.task_id // empty')
TASK_SUBJECT=$(printf '%s' "$INPUT" | jq -r '.task_subject // empty')

# task_idがなければ何もしない
if [ -z "$TASK_ID" ]; then
  log "ABORT: task_id is empty"
  exit 0
fi
log "TASK_ID: ${TASK_ID}"
log "TASK_SUBJECT: ${TASK_SUBJECT}"

# branch名取得（worktree内のHEADから）
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ -z "$BRANCH" ]; then
  log "ABORT: branch is empty (git rev-parse --abbrev-ref HEAD failed)"
  exit 0
fi
log "BRANCH: ${BRANCH}"

# GIT_DIR取得（worktree/main両対応）
# git rev-parse --git-common-dir はworktree内でも共有.gitパスを返す
MAIN_GIT="$(git rev-parse --git-common-dir 2>/dev/null)"
if [ ! -d "$MAIN_GIT" ]; then
  log "ABORT: MAIN_GIT not a directory: ${MAIN_GIT}"
  exit 0
fi
log "MAIN_GIT: ${MAIN_GIT}"

# bit存在チェック
if ! command -v bit &>/dev/null; then
  log "ABORT: bit not found"
  exit 0
fi

# [task:<branch>:<task_id>] を含むopen issueを検索
# bit issue list出力形式: "#<id> [open] <title>"
SEARCH_PATTERN="[task:${BRANCH}:${TASK_ID}]"
log "SEARCH_PATTERN: ${SEARCH_PATTERN}"

ALL_OPEN=$(GIT_DIR="$MAIN_GIT" bit issue list --open 2>/dev/null || true)
log "ALL_OPEN_ISSUES: ${ALL_OPEN}"

ISSUE_LINE=$(printf '%s' "$ALL_OPEN" | grep -F "$SEARCH_PATTERN" || true)
if [ -z "$ISSUE_LINE" ]; then
  log "ABORT: no matching issue found for pattern: ${SEARCH_PATTERN}"
  exit 0
fi
log "MATCHED: ${ISSUE_LINE}"

# 全マッチのissue IDを抽出し、それぞれ comment + close
printf '%s\n' "$ISSUE_LINE" | while IFS= read -r line; do
  ISSUE_ID=$(printf '%s' "$line" | sed 's/^#\([^ ]*\).*/\1/')
  [ -z "$ISSUE_ID" ] && continue

  log "CLOSING: issue #${ISSUE_ID}"

  GIT_DIR="$MAIN_GIT" bit issue comment add "$ISSUE_ID" \
    --body "Task completed: ${TASK_SUBJECT}" 2>/dev/null || true

  GIT_DIR="$MAIN_GIT" bit issue close "$ISSUE_ID" 2>/dev/null || true

  log "CLOSED: issue #${ISSUE_ID}"
done

log "=== TaskCompleted hook done ==="
