#!/usr/bin/env bash
# codex-stage.sh — single safety/permission boundary for delegating work to OpenAI Codex CLI.
#
# Used by the codex-reviewer / codex-poc agents and by ultracode Workflow stages.
# Centralizes the invariants every codex call must honor, so agents and workflow
# scripts never re-derive flags:
#   - never passes -m / --model (model comes from ~/.codex/config.toml)
#   - persists session rollouts (one UUID-named file per run, so parallel-safe and
#     visible to usage trackers) but disables the memories feature, whose startup
#     pipeline would otherwise spend quota on every fan-out run
#   - auth preflight via `codex login status`
#   - in-script timeout (macOS ships no timeout(1) / gtimeout)
#   - poc mode validates the target is an isolated *linked* git worktree in code,
#     not prose — it refuses a main repository checkout
#   - every mode runs codex with sandbox_mode=danger-full-access and
#     approval_policy=never, so mise, cargo, gh, network, git index writes,
#     ps and kill all work; codex is NOT confined to the target directory
#   - history writes stay forbidden: stdin prompts get a launcher rule prepended
#     (no commit/merge/rebase/reset/tag/stash/push/ref changes, no GitHub
#     writes; staging is allowed), and a run whose HEAD moved exits 17
#
# Modes:
#   codex-stage.sh review [--uncommitted | --base <branch> | --commit <sha>]
#                         [--dir <path>] [--timeout <sec>] [--title <t>]
#       First-class diff review (codex exec review). `codex exec review` accepts
#       no -C/--sandbox flags, so the target directory is entered with cd.
#       Default selector: --uncommitted. Intended to be read-only.
#
#   codex-stage.sh prompt [--dir <path>] [--timeout <sec>] [--schema <file>]
#       Analysis/review with a custom prompt read from stdin.
#       The wrapper pins <dir> with cd before running codex from that cwd.
#
#   codex-stage.sh poc --worktree <abs-path> [--timeout <sec>]
#       Implementation PoC read from stdin, run from an isolated linked git
#       worktree. Prints `git status --porcelain` + `git diff --stat` of the
#       worktree after the run so callers get a machine-checkable change summary.
#
#   codex-stage.sh run --dir <path> [--timeout <sec>]
#       Like poc (task read from stdin) but WITHOUT the isolated-worktree
#       requirement: --dir may be the main repository checkout or any
#       subdirectory, as long as it is inside a git work tree (writes stay
#       reviewable via git). For a write-capable codex subagent the orchestrator
#       launches in parallel and places itself — the orchestrator owns
#       collision-avoidance across concurrent runs (partition files/dirs so two
#       runs never touch the same path). Prints a repo-wide
#       `git status --porcelain` + `git diff --stat` after the run. Changes stay
#       uncommitted for review. run uses exit 13, not poc's 14, for a
#       non-git-work-tree target. Write scope is the task's contract only; no
#       sandbox enforces it.
#
# Retry (all modes):
#   --retry <n>        retries when codex fails with a rate-limit error
#                      (default 1; 0 disables)
#   --retry-wait <sec> backoff base; waits base, 2*base, 4*base... (default 30)
#   Only rate-limited failures are retried — timeouts (124) and other errors
#   are not. A rate-limited run with no retries left exits 15 so callers can
#   distinguish "retry later / proceed Claude-only" from a permanent failure.
#
# Concurrency (poc and run):
#   A write-mode run takes an exclusive lock for its git work tree (keyed by the
#   resolved top-level path, held in the per-user temp directory). A second
#   write-mode run on the same work tree is refused with exit 16 while the
#   holder process is alive; a lock whose holder is gone is reclaimed.
#
# Exit codes: 0 ok / 11 codex missing / 12 unauthenticated / 13 usage error
#             14 validation refused (poc) / 15 rate limited (retryable)
#             16 another write-mode run holds this work tree
#             17 codex moved HEAD (history write) during the run
#             124 timed out / else codex's own code.
set -euo pipefail

# codex is installed via bun; agent shells may lack that PATH entry.
if ! command -v codex >/dev/null 2>&1; then
  [ -x "$HOME/.bun/bin/codex" ] && export PATH="$HOME/.bun/bin:$PATH"
fi

usage() {
  # Print the header comment block (everything up to the first non-comment line).
  sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 13
}

die() {
  echo "codex-stage: $1" >&2
  exit "${2:-13}"
}

validate_bounded_integer() {
  local name=$1 value=$2 minimum=$3 maximum=$4
  case $value in
    ""|*[!0-9]*|0[0-9]*) die "$name must be a canonical decimal integer" 13 ;;
  esac
  if [ "$value" -ge "$minimum" ] && [ "$value" -le "$maximum" ]; then
    return 0
  fi
  die "$name must be between $minimum and $maximum" 13
}

pin_directory() {
  local path=$1
  cd -P -- "$path" || die "cannot enter directory: $path" 13
  pwd -P >/dev/null || die "cannot resolve directory after entry: $path" 13
}

# Portable timeout: background the command, kill it from a watchdog.
# Background jobs get stdin rewired to /dev/null by the shell, so the prompt
# is buffered to a temp file and redirected explicitly inside the job.
# Usage: run_with_timeout <secs> <stdin-file-or-empty> <cmd> [args...]
run_with_timeout() {
  local secs=$1 stdin_file=$2
  shift 2
  local mark
  mark=$(mktemp "${TMPDIR:-/tmp}/codex-stage-timeout.XXXXXX")
  rm -f "$mark"
  local monitor_was_enabled=0
  case $- in *m*) monitor_was_enabled=1 ;; esac
  set -m
  "$@" < "${stdin_file:-/dev/null}" &
  local cmd_pid=$! kill_target="-$!"
  (
    sleep "$secs"
    # Mark a timeout only when the process group is still alive at the
    # deadline. The mark is written BEFORE TERM so the parent, woken by the
    # leader's exit, waits for the watchdog's group-wide KILL.
    if kill -0 -- "$kill_target" 2>/dev/null; then
      touch "$mark"
      kill -TERM -- "$kill_target" 2>/dev/null
      sleep 5
      kill -KILL -- "$kill_target" 2>/dev/null
    fi
  ) &
  local watchdog_pid=$!
  [ "$monitor_was_enabled" -eq 1 ] || set +m
  local rc=0
  wait "$cmd_pid" || rc=$?
  # Once the leader has exited its result is final; a descendant left in the
  # group must not hold the caller until the deadline, so stop the watchdog
  # first and then give leftovers a short grace before ending the group.
  if [ ! -e "$mark" ]; then
    kill -TERM -- "-$watchdog_pid" 2>/dev/null || true
  fi
  wait "$watchdog_pid" 2>/dev/null || true
  local grace=0
  while kill -0 -- "$kill_target" 2>/dev/null && [ "$grace" -lt 10 ]; do
    sleep 1
    grace=$((grace + 1))
  done
  if kill -0 -- "$kill_target" 2>/dev/null; then
    kill -TERM -- "$kill_target" 2>/dev/null
    sleep 2
    kill -KILL -- "$kill_target" 2>/dev/null
  fi
  if [ -e "$mark" ]; then
    rm -f "$mark"
    return 124
  fi
  return "$rc"
}

preflight() {
  command -v codex >/dev/null 2>&1 \
    || die "codex CLI not found — install it, then run 'codex login'" 11
  codex login status >/dev/null 2>&1 \
    || die "codex is not authenticated — run 'codex login'" 12
}

# Rate limits are only visible at execution time (auth preflight still passes),
# so they are classified from codex's stderr after a failed run.
is_rate_limited() {
  grep -qiE 'rate.?limit|too many requests|429|usage limit|quota exceeded' "$STDERR_FILE"
}

# Shared execution path for all modes: runs codex under the timeout, classifies
# rate-limited failures as exit 15, and retries those (and only those) with
# exponential backoff. Usage: run_codex <stdin-file-or-empty> <cmd> [args...]
run_codex() {
  local stdin_file=$1
  shift
  local attempt=0 rc wait_s
  while :; do
    : > "$STDERR_FILE"
    rc=0
    run_with_timeout "$TIMEOUT" "$stdin_file" "$@" 2>"$STDERR_FILE" || rc=$?
    if [ "$rc" -ne 0 ] && [ "$rc" -ne 124 ] && is_rate_limited; then
      rc=15
    fi
    if [ "$rc" -eq 15 ] && [ "$attempt" -lt "$RETRY" ]; then
      attempt=$((attempt + 1))
      wait_s=$((RETRY_WAIT * (1 << (attempt - 1))))
      echo "codex-stage: codex is rate limited — retry $attempt/$RETRY in ${wait_s}s" >&2
      sleep "$wait_s"
      continue
    fi
    break
  done
  return "$rc"
}

# Buffer stdin to a temp file so the backgrounded codex process gets a stable fd.
HISTORY_RULE='Launcher rule (overrides anything below): never write git history or refs and never write to GitHub. Do not run git commit, merge, rebase, cherry-pick, revert, tag, stash, push, update-ref, a reset or switch/checkout that moves HEAD, branch creation or deletion, or any gh command that creates or modifies something (pr, issue, release, api writes). Staging with git add/rm is allowed. Leave every change uncommitted.'

buffer_stdin() {
  [ -t 0 ] && die "this mode reads its prompt from stdin (pipe or heredoc)" 13
  PROMPT_FILE=$(mktemp "${TMPDIR:-/tmp}/codex-stage.XXXXXX")
  BODY_FILE=$(mktemp "${TMPDIR:-/tmp}/codex-stage-body.XXXXXX")
  cat > "$BODY_FILE"
  [ -s "$BODY_FILE" ] || die "empty prompt on stdin" 13
  { printf '%s\n\n' "$HISTORY_RULE"; cat "$BODY_FILE"; } > "$PROMPT_FILE"
}

head_state() {
  printf '%s %s' \
    "$(git rev-parse -q --verify HEAD 2>/dev/null || echo unborn)" \
    "$(git symbolic-ref -q HEAD 2>/dev/null || echo detached)"
}

record_head() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  HEAD_BEFORE=$(head_state)
}

check_head() {
  [ -n "$HEAD_BEFORE" ] || return 0
  local after
  after=$(head_state)
  [ "$after" = "$HEAD_BEFORE" ] && return 0
  echo "codex-stage: codex moved HEAD during the run ($HEAD_BEFORE -> $after); history writes are forbidden — inspect and undo it before using the result" >&2
  exit 17
}

finish_codex() {
  local rc=$1
  check_head
  [ "$rc" -eq 0 ] || { report_failure "$rc"; exit "$rc"; }
}

STDERR_FILE=$(mktemp "${TMPDIR:-/tmp}/codex-stage-err.XXXXXX")
PROMPT_FILE=""
BODY_FILE=""
HEAD_BEFORE=""
LOCK_DIR=""
cleanup() {
  rm -f "$STDERR_FILE" ${PROMPT_FILE:+"$PROMPT_FILE"} ${BODY_FILE:+"$BODY_FILE"}
  if [ -n "$LOCK_DIR" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null || true)" = "$$" ]; then
    rm -rf -- "$LOCK_DIR"
  fi
}
trap cleanup EXIT

# One write-mode run per git work tree. The lock lives in the per-user temp
# directory (stable across shells, outside the work tree and its .git) and is
# named by a digest of the resolved top-level path.
acquire_write_lock() {
  local top=$1 base key holder age
  base=$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)
  base=${base:-${TMPDIR:-/tmp}}
  mkdir -p "$base/codex-stage-locks" || die "cannot create lock directory" 16
  key=$(printf '%s' "$top" | shasum -a 256 | cut -c1-32)
  local dir="$base/codex-stage-locks/$key"
  if mkdir "$dir" 2>/dev/null; then
    printf '%s\n' "$$" > "$dir/pid"
    printf '%s\n' "$top" > "$dir/worktree"
    LOCK_DIR=$dir
    return 0
  fi
  holder=$(cat "$dir/pid" 2>/dev/null || true)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    die "another write-mode codex run (pid $holder) holds $top; refusing a concurrent writer" 16
  fi
  if [ -z "$holder" ]; then
    age=$(( $(date +%s) - $(stat -f %m "$dir" 2>/dev/null || date +%s) ))
    [ "$age" -ge 60 ] || die "a write-mode codex run is starting on $top; refusing a concurrent writer" 16
  fi
  rm -rf -- "$dir"
  mkdir "$dir" 2>/dev/null || die "lost the race for the work-tree lock on $top" 16
  printf '%s\n' "$$" > "$dir/pid"
  printf '%s\n' "$top" > "$dir/worktree"
  LOCK_DIR=$dir
}

report_failure() {
  local rc=$1
  if [ "$rc" -eq 124 ]; then
    echo "codex-stage: codex timed out after ${TIMEOUT}s" >&2
  elif [ "$rc" -eq 15 ]; then
    echo "codex-stage: codex is rate limited (retries exhausted) — retry later or proceed without the codex stage" >&2
  else
    echo "codex-stage: codex exited with code $rc" >&2
  fi
  echo "--- codex stderr (tail) ---" >&2
  tail -n 40 "$STDERR_FILE" >&2 || true
}

MODE=${1:-}
case $MODE in
  ""|-h|--help) usage ;;
esac
shift

TIMEOUT=600
RETRY=1
RETRY_WAIT=30
DIR=$PWD
SCHEMA=""
TITLE=""
WORKTREE=""
SELECTOR=()
CODEX_GLOBAL_OPTS=(
  -c features.memories=false
  -c 'sandbox_mode="danger-full-access"'
  -c 'approval_policy="never"'
)

while [ $# -gt 0 ]; do
  case $1 in
    --uncommitted) SELECTOR=(--uncommitted) ;;
    --base) SELECTOR=(--base "${2:?--base needs a branch}"); shift ;;
    --commit) SELECTOR=(--commit "${2:?--commit needs a sha}"); shift ;;
    --dir) DIR=${2:?--dir needs a path}; shift ;;
    --timeout) TIMEOUT=${2:?--timeout needs seconds}; shift ;;
    --retry) RETRY=${2:?--retry needs a count}; shift ;;
    --retry-wait) RETRY_WAIT=${2:?--retry-wait needs seconds}; shift ;;
    --title) TITLE=${2:?--title needs text}; shift ;;
    --schema) SCHEMA=${2:?--schema needs a file}; shift ;;
    --worktree) WORKTREE=${2:?--worktree needs an absolute path}; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" 13 ;;
  esac
  shift
done

validate_bounded_integer "--timeout" "$TIMEOUT" 1 3600
validate_bounded_integer "--retry" "$RETRY" 0 10
validate_bounded_integer "--retry-wait" "$RETRY_WAIT" 0 300

preflight

case $MODE in
  review)
    [ -d "$DIR" ] || die "no such directory: $DIR" 13
    [ ${#SELECTOR[@]} -gt 0 ] || SELECTOR=(--uncommitted)
    pin_directory "$DIR"
    DIR=$PWD
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
      || die "review mode requires a git repository: $DIR" 13
    record_head
    rc=0
    run_codex "" codex "${CODEX_GLOBAL_OPTS[@]}" exec review "${SELECTOR[@]}" \
      ${TITLE:+--title "$TITLE"} || rc=$?
    finish_codex "$rc"
    ;;

  prompt)
    [ -d "$DIR" ] || die "no such directory: $DIR" 13
    pin_directory "$DIR"
    DIR=$PWD
    buffer_stdin
    record_head
    rc=0
    run_codex "$PROMPT_FILE" codex "${CODEX_GLOBAL_OPTS[@]}" exec \
      --skip-git-repo-check \
      ${SCHEMA:+--output-schema "$SCHEMA"} \
      - || rc=$?
    finish_codex "$rc"
    ;;

  poc)
    [ -n "$WORKTREE" ] || die "poc mode requires --worktree <abs-path>" 13
    case $WORKTREE in
      /*) ;;
      *) die "worktree path must be absolute: $WORKTREE" 14 ;;
    esac
    git -C "$WORKTREE" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
      || die "not a git work tree: $WORKTREE" 14
    TOPLEVEL=$(git -C "$WORKTREE" rev-parse --show-toplevel)
    pin_directory "$TOPLEVEL"
    TOPLEVEL=$PWD
    # A linked worktree has its own git-dir under <main>/.git/worktrees/<name>;
    # in a main checkout git-dir == git-common-dir. Refuse main checkouts so a
    # PoC run always starts from an isolated copy, never the primary checkout.
    # Both sides MUST come from the same producer with the same symlink
    # handling: deriving one via --absolute-git-dir (canonicalized) and the
    # other via cd+pwd (not canonicalized) let a main checkout reached through
    # a symlinked path (e.g. macOS /tmp -> /private/tmp) pass as a worktree.
    GIT_DIR=$(git rev-parse --git-dir)
    GIT_COMMON_DIR=$(git rev-parse --git-common-dir)
    [ "$GIT_DIR" != "$GIT_COMMON_DIR" ] \
      || die "refusing: $TOPLEVEL is a main repository checkout, not an isolated linked worktree" 14
    acquire_write_lock "$TOPLEVEL"
    buffer_stdin
    record_head
    rc=0
    run_codex "$PROMPT_FILE" codex "${CODEX_GLOBAL_OPTS[@]}" exec - || rc=$?
    finish_codex "$rc"
    echo ""
    echo "--- codex-stage poc: resulting changes in $TOPLEVEL ---"
    git -C "$TOPLEVEL" status --porcelain
    git -C "$TOPLEVEL" diff --stat
    ;;

  run)
    [ -d "$DIR" ] || die "no such directory: $DIR" 13
    # Absolutize --dir so -C and the post-run git summary are unambiguous.
    case $DIR in /*) ;; *) DIR="$PWD/$DIR" ;; esac
    # Require a git work tree so writes stay reviewable — but, UNLIKE poc, the
    # main repository checkout is allowed: run mode deliberately drops the
    # isolated-linked-worktree refusal. Placement/isolation is the caller's job.
    pin_directory "$DIR"
    DIR=$PWD
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
      || die "run mode requires a git work tree (for reviewability): $DIR" 13
    TOPLEVEL=$(git rev-parse --show-toplevel)
    acquire_write_lock "$TOPLEVEL"
    buffer_stdin
    record_head
    rc=0
    run_codex "$PROMPT_FILE" codex "${CODEX_GLOBAL_OPTS[@]}" exec - || rc=$?
    finish_codex "$rc"
    echo ""
    echo "--- codex-stage run: resulting changes in $TOPLEVEL ---"
    git -C "$TOPLEVEL" status --porcelain
    git -C "$TOPLEVEL" diff --stat
    ;;

  *)
    die "unknown mode: $MODE (expected review | prompt | poc | run)" 13
    ;;
esac
