#!/usr/bin/env bash
# Close the local bit issue associated with an explicitly verified Codex task.
set -u

umask 077
LOG_DIR="${TMPDIR:-/tmp}/codex-hooks"
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

log_event() {
  rotate_log
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >> "$LOG_FILE" 2>/dev/null || true
}

TASK_ID=${1:-}
TASK_SUBJECT=""
CWD=$PWD

if [ -n "$TASK_ID" ]; then
  shift
  TASK_SUBJECT=$*
else
  cat >/dev/null 2>&1 || true
  log_event 'error: explicit compatibility task id unavailable'
  exit 2
fi

command -v git >/dev/null 2>&1 || { log_event 'error: git unavailable'; exit 1; }
command -v bit >/dev/null 2>&1 || { log_event 'error: bit unavailable'; exit 1; }

BRANCH=$(git -C "$CWD" branch --show-current 2>/dev/null) || BRANCH=""
[ -n "$BRANCH" ] || { log_event 'error: branch unavailable'; exit 1; }

MAIN_GIT=$(git -C "$CWD" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || MAIN_GIT=""
if [ -z "$MAIN_GIT" ] || [ ! -d "$MAIN_GIT" ]; then
  log_event 'error: git common directory unavailable'
  exit 1
fi

if ! ALL_OPEN=$(GIT_DIR="$MAIN_GIT" bit issue list --open 2>/dev/null); then
  log_event 'error: could not list open issues'
  exit 1
fi
[ -n "$ALL_OPEN" ] || { log_event 'error: no open issues'; exit 1; }

# Preferred contract: [task:<branch>#<seq>:<id>]. Parse the final id instead
# of interpolating a regex so branch names containing regex punctuation are safe.
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

[ -n "$MATCHES" ] || { log_event 'error: no matching issue'; exit 1; }
MATCH_COUNT=$(printf '%s\n' "$MATCHES" | awk 'NF { count++ } END { print count + 0 }')
log_event "matched: ${MATCH_COUNT} issue(s)"

FAILED=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  ISSUE_ID=$(printf '%s' "$line" | sed -n 's/^#\([^ ]*\).*/\1/p')
  if [ -z "$ISSUE_ID" ]; then
    log_event 'error: could not parse matched issue id'
    FAILED=1
    continue
  fi

  if [ -n "$TASK_SUBJECT" ]; then
    if ! GIT_DIR="$MAIN_GIT" bit issue comment add "$ISSUE_ID" \
      --body "Task completed: ${TASK_SUBJECT}" >/dev/null 2>&1; then
      log_event "error: comment failed for issue ${ISSUE_ID}"
      FAILED=1
    fi
  else
    if ! GIT_DIR="$MAIN_GIT" bit issue comment add "$ISSUE_ID" \
      --body 'Task completed by Codex' >/dev/null 2>&1; then
      log_event "error: comment failed for issue ${ISSUE_ID}"
      FAILED=1
    fi
  fi
  if ! GIT_DIR="$MAIN_GIT" bit issue close "$ISSUE_ID" >/dev/null 2>&1; then
    log_event "error: close failed for issue ${ISSUE_ID}"
    FAILED=1
  fi
done <<< "$MATCHES"

if [ "$FAILED" -ne 0 ]; then
  log_event "failed: ${MATCH_COUNT} issue(s) processed with errors"
  exit 1
fi

log_event "completed: ${MATCH_COUNT} issue(s) processed"
exit 0
