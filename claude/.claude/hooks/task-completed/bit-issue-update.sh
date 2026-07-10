#!/usr/bin/env bash
# TaskCompleted hook: close the bit issue whose title carries this task's
# marker. Primary contract: [task:<branch>#<seq>:<task_id>] (start-work skill);
# legacy [task:<branch>:<task_id>] titles still match as a fallback.
# Async hook — every abort path exits 0 silently; diagnostics go to the log.
set -u

umask 077
LOG_DIR="${TMPDIR:-/tmp}/claude-hooks"
LOG_FILE="$LOG_DIR/bit-issue-update.log"
mkdir -p "$LOG_DIR" 2>/dev/null || true

rotate_log() {
  local size=0
  if [ -f "$LOG_FILE" ]; then
    size=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
  fi
  if [ "$size" -ge 262144 ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || true
  fi
}

log() {
  rotate_log
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >> "$LOG_FILE" 2>/dev/null || true
}

for cmd in jq git bit; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log "abort: $cmd not found"
    exit 0
  fi
done

INPUT=$(cat)
TASK_ID=$(printf '%s' "$INPUT" | jq -r '.task_id // empty' 2>/dev/null) || TASK_ID=""
TASK_SUBJECT=$(printf '%s' "$INPUT" | jq -r '.task_subject // empty' 2>/dev/null) || TASK_SUBJECT=""

if [ -z "$TASK_ID" ]; then
  log "abort: task_id is empty"
  exit 0
fi
log "task ${TASK_ID}: ${TASK_SUBJECT}"

BRANCH=$(git branch --show-current 2>/dev/null) || BRANCH=""
if [ -z "$BRANCH" ]; then
  log "abort: branch unavailable"
  exit 0
fi

# The shared .git path works from any worktree.
MAIN_GIT=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || MAIN_GIT=""
if [ -z "$MAIN_GIT" ] || [ ! -d "$MAIN_GIT" ]; then
  log "abort: git common directory unavailable"
  exit 0
fi

ALL_OPEN=$(GIT_DIR="$MAIN_GIT" bit issue list --open 2>/dev/null) || ALL_OPEN=""
if [ -z "$ALL_OPEN" ]; then
  log "abort: no open issues"
  exit 0
fi

# Preferred contract: [task:<branch>#<seq>:<id>]. Parse the final id instead of
# interpolating a regex so branch names containing regex punctuation are safe.
MATCHES=$(printf '%s\n' "$ALL_OPEN" | awk -v branch="$BRANCH" -v wanted="$TASK_ID" '
  {
    marker = "[task:" branch "#"
    pos = index($0, marker)
    if (pos == 0) next
    rest = substr($0, pos + length(marker))
    closing = index(rest, "]")
    if (closing == 0) next
    token = substr(rest, 1, closing - 1)
    colon = 0
    for (i = 1; i <= length(token); i++) {
      if (substr(token, i, 1) == ":") colon = i
    }
    if (colon > 0 && substr(token, colon + 1) == wanted) print $0
  }
')

# Backward compatibility for historical [task:<branch>:<id>] issues.
if [ -z "$MATCHES" ]; then
  MATCHES=$(printf '%s\n' "$ALL_OPEN" | awk -v marker="[task:${BRANCH}:${TASK_ID}]" '
    index($0, marker) > 0 { print $0 }
  ')
fi

if [ -z "$MATCHES" ]; then
  log "abort: no matching issue for task ${TASK_ID} on ${BRANCH}"
  exit 0
fi

printf '%s\n' "$MATCHES" | while IFS= read -r line; do
  [ -n "$line" ] || continue
  ISSUE_ID=$(printf '%s' "$line" | sed -n 's/^#\([^ ]*\).*/\1/p')
  [ -n "$ISSUE_ID" ] || continue

  GIT_DIR="$MAIN_GIT" bit issue comment add "$ISSUE_ID" \
    --body "Task completed: ${TASK_SUBJECT}" >/dev/null 2>&1 \
    || log "warn: comment failed for issue ${ISSUE_ID}"

  if GIT_DIR="$MAIN_GIT" bit issue close "$ISSUE_ID" >/dev/null 2>&1; then
    log "closed: issue ${ISSUE_ID}"
  else
    log "warn: close failed for issue ${ISSUE_ID}"
  fi
done

exit 0
