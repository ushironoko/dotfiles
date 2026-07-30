#!/usr/bin/env bash
# codex-stage.sh — single safety/permission boundary for delegating work to OpenAI Codex CLI.
#
# Used by the codex-reviewer / codex-poc agents and by ultracode Workflow stages.
# Centralizes the invariants every codex call must honor, so agents and workflow
# scripts never re-derive flags:
#   - never passes -m / --model (model comes from ~/.codex/config.toml)
#   - always --ephemeral (parallel-safe: no ~/.codex/sessions state collisions)
#   - auth preflight via `codex login status`
#   - in-script timeout (macOS ships no timeout(1) / gtimeout)
#   - poc mode validates the target is an isolated *linked* git worktree in code,
#     not prose — it refuses a main repository checkout
#
# Modes:
#   codex-stage.sh review [--uncommitted | --base <branch> | --commit <sha>]
#                         [--dir <path>] [--timeout <sec>] [--title <t>]
#       First-class diff review (codex exec review). `codex exec review` accepts
#       no -C/--sandbox flags, so the target directory is entered with cd.
#       Default selector: --uncommitted. Read-only by nature.
#
#   codex-stage.sh prompt [--dir <path>] [--timeout <sec>] [--schema <file>]
#       Read-only analysis/review with a custom prompt read from stdin.
#       The wrapper pins <dir> with cd before running codex from that cwd.
#
#   codex-stage.sh poc --worktree <abs-path> [--timeout <sec>] [--network]
#       Implementation PoC read from stdin, confined to an isolated linked git
#       worktree (codex -a never exec --sandbox workspace-write from <worktree>).
#       Prints `git status --porcelain` + `git diff --stat` of the worktree after
#       the run so callers get a machine-checkable change summary.
#
#   codex-stage.sh run --dir <path> [--timeout <sec>] [--network]
#       Like poc (workspace-write, task read from stdin) but WITHOUT the
#       isolated-worktree requirement: --dir may be the main repository checkout
#       or any subdirectory, as long as it is inside a git work tree (writes stay
#       reviewable via git). For a write-capable codex subagent the orchestrator
#       launches in parallel and places itself — the orchestrator owns
#       collision-avoidance across concurrent runs (partition files/dirs so two
#       runs never touch the same path). Same rails as poc (codex -a never exec
#       --sandbox workspace-write from the pinned <dir>; no danger flags, no
#       --add-dir, no -m). Prints a repo-wide `git status --porcelain` + `git diff --stat`
#       after the run. Changes stay uncommitted for review. Output is returned
#       on stdout. run uses exit 13, not poc's 14, for a non-git-work-tree target.
#       Note: confinement of codex's edits to
#       <dir> is codex's own workspace-write sandbox (writable root = the -C dir),
#       not something this wrapper enforces beyond withholding --add-dir.
#
# Retry (all modes):
#   --retry <n>        retries when codex fails with a rate-limit error
#                      (default 1; 0 disables)
#   --retry-wait <sec> backoff base; waits base, 2*base, 4*base... (default 30)
#   Only rate-limited failures are retried — timeouts (124) and other errors
#   are not. A rate-limited run with no retries left exits 15 so callers can
#   distinguish "retry later / proceed Claude-only" from a permanent failure.
#
# Exit codes: 0 ok / 11 codex missing / 12 unauthenticated / 13 usage error
#             14 validation refused (poc) / 15 rate limited (retryable)
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
  [ "$monitor_was_enabled" -eq 1 ] || set +m
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
  local rc=0
  wait "$cmd_pid" || rc=$?
  # A command leader may exit while a background descendant keeps the job's
  # process group alive. In that case retain the watchdog through its deadline
  # so TERM/KILL still reaches the whole group instead of returning early.
  if kill -0 -- "$kill_target" 2>/dev/null; then
    wait "$watchdog_pid" 2>/dev/null || true
  else
    kill "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
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
buffer_stdin() {
  [ -t 0 ] && die "this mode reads its prompt from stdin (pipe or heredoc)" 13
  PROMPT_FILE=$(mktemp "${TMPDIR:-/tmp}/codex-stage.XXXXXX")
  cat > "$PROMPT_FILE"
  [ -s "$PROMPT_FILE" ] || die "empty prompt on stdin" 13
}

STDERR_FILE=$(mktemp "${TMPDIR:-/tmp}/codex-stage-err.XXXXXX")
PROMPT_FILE=""
cleanup() {
  rm -f "$STDERR_FILE" ${PROMPT_FILE:+"$PROMPT_FILE"}
}
trap cleanup EXIT

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
NETWORK=0
SELECTOR=()

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
    --network) NETWORK=1 ;;
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
    rc=0
    run_codex "" codex exec review "${SELECTOR[@]}" \
      --ephemeral \
      ${TITLE:+--title "$TITLE"} || rc=$?
    [ "$rc" -eq 0 ] || { report_failure "$rc"; exit "$rc"; }
    ;;

  prompt)
    [ -d "$DIR" ] || die "no such directory: $DIR" 13
    pin_directory "$DIR"
    DIR=$PWD
    buffer_stdin
    rc=0
    run_codex "$PROMPT_FILE" codex exec \
      --sandbox read-only \
      --ephemeral \
      --skip-git-repo-check \
      ${SCHEMA:+--output-schema "$SCHEMA"} \
      - || rc=$?
    [ "$rc" -eq 0 ] || { report_failure "$rc"; exit "$rc"; }
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
    # workspace-write codex run can never touch the primary working copy.
    # Both sides MUST come from the same producer with the same symlink
    # handling: deriving one via --absolute-git-dir (canonicalized) and the
    # other via cd+pwd (not canonicalized) let a main checkout reached through
    # a symlinked path (e.g. macOS /tmp -> /private/tmp) pass as a worktree.
    GIT_DIR=$(git rev-parse --git-dir)
    GIT_COMMON_DIR=$(git rev-parse --git-common-dir)
    [ "$GIT_DIR" != "$GIT_COMMON_DIR" ] \
      || die "refusing: $TOPLEVEL is a main repository checkout, not an isolated linked worktree" 14
    buffer_stdin
    NETWORK_OPT=""
    [ "$NETWORK" -eq 1 ] && NETWORK_OPT="sandbox_workspace_write.network_access=true"
    rc=0
    run_codex "$PROMPT_FILE" codex -a never exec \
      --sandbox workspace-write \
      --ephemeral \
      ${NETWORK_OPT:+-c "$NETWORK_OPT"} \
      - || rc=$?
    [ "$rc" -eq 0 ] || { report_failure "$rc"; exit "$rc"; }
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
    buffer_stdin
    NETWORK_OPT=""
    [ "$NETWORK" -eq 1 ] && NETWORK_OPT="sandbox_workspace_write.network_access=true"
    rc=0
    run_codex "$PROMPT_FILE" codex -a never exec \
      --sandbox workspace-write \
      --ephemeral \
      ${NETWORK_OPT:+-c "$NETWORK_OPT"} \
      - || rc=$?
    [ "$rc" -eq 0 ] || { report_failure "$rc"; exit "$rc"; }
    echo ""
    echo "--- codex-stage run: resulting changes in $TOPLEVEL ---"
    git -C "$TOPLEVEL" status --porcelain
    git -C "$TOPLEVEL" diff --stat
    ;;

  *)
    die "unknown mode: $MODE (expected review | prompt | poc | run)" 13
    ;;
esac
