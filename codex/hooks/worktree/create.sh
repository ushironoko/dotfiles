#!/usr/bin/env bash
# Explicit compatibility command; Codex 0.144 has no WorktreeCreate hook event.
set -euo pipefail

fail() {
  printf 'worktree create: %s\n' "$*" >&2
  exit 1
}

canonical_dir() {
  (cd -P -- "$1" 2>/dev/null && pwd -P)
}

resolve_git_dir() {
  local worktree_path=$1
  local git_path=$2

  case "$git_path" in
    /*) canonical_dir "$git_path" ;;
    *) canonical_dir "$worktree_path/$git_path" ;;
  esac
}

sha1_text() {
  local value=$1

  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$value" | shasum -a 1 | awk '{ print $1 }'
  elif command -v sha1sum >/dev/null 2>&1; then
    printf '%s' "$value" | sha1sum | awk '{ print $1 }'
  elif command -v openssl >/dev/null 2>&1; then
    printf '%s' "$value" | openssl dgst -sha1 | awk '{ print $NF }'
  else
    return 1
  fi
}

command -v jq >/dev/null 2>&1 || fail 'jq is required'
command -v git >/dev/null 2>&1 || fail 'git is required'

INPUT=$(cat)
if ! NAME=$(printf '%s' "$INPUT" | jq -er '
  .name | select(type == "string" and length > 0)
' 2>/dev/null); then
  fail 'input must be JSON with a non-empty string field: name'
fi

if command -v gwq >/dev/null 2>&1; then
  GWQ=$(command -v gwq)
elif [ -x "$HOME/.local/share/mise/installs/github-d-kuro-gwq/0.0.17/gwq" ]; then
  GWQ="$HOME/.local/share/mise/installs/github-d-kuro-gwq/0.0.17/gwq"
else
  fail 'gwq not found'
fi

if ! SOURCE_TOP_RAW=$(git rev-parse --show-toplevel 2>/dev/null); then
  fail 'run this command from the Git repository that will own the worktree'
fi
SOURCE_TOP=$(canonical_dir "$SOURCE_TOP_RAW") \
  || fail 'could not canonicalize the source repository'
if ! SOURCE_COMMON_RAW=$(git -C "$SOURCE_TOP" rev-parse --git-common-dir 2>/dev/null); then
  fail 'could not determine the source Git common directory'
fi
SOURCE_COMMON=$(resolve_git_dir "$SOURCE_TOP" "$SOURCE_COMMON_RAW") \
  || fail 'could not canonicalize the source Git common directory'
if ! SOURCE_HEAD=$(git -C "$SOURCE_TOP" rev-parse --verify HEAD 2>/dev/null); then
  fail 'could not resolve the source HEAD commit'
fi

# Creation is a side effect, but the caller may cancel this hook at any point.
# Serialize the branch name and reserve its ref atomically. On SIGTERM, a
# created worktree is completed by publishing its safe-removal marker + path;
# failures before creation roll back only the exact ref reserved below.
NAME_SHA1=$(sha1_text "$NAME") \
  || fail 'no SHA-1 implementation is available (shasum, sha1sum, or openssl)'
CREATE_LOCK_PARENT="$SOURCE_COMMON/codex-harness-worktree-create-locks"
if [ -e "$CREATE_LOCK_PARENT" ] && { [ ! -d "$CREATE_LOCK_PARENT" ] || [ -L "$CREATE_LOCK_PARENT" ]; }; then
  fail "create lock location is not a safe directory: $CREATE_LOCK_PARENT"
fi
umask 077
mkdir -p "$CREATE_LOCK_PARENT" \
  || fail "could not create worktree lock directory: $CREATE_LOCK_PARENT"
chmod 700 "$CREATE_LOCK_PARENT" \
  || fail "could not secure worktree lock directory: $CREATE_LOCK_PARENT"
CREATE_LOCK="$CREATE_LOCK_PARENT/$NAME_SHA1.lock"
CREATE_LOCK_OWNER_TOKEN="owner.${BASHPID:-$$}.${RANDOM}.${RANDOM}"
CREATE_LOCK_OWNER_PATH="$CREATE_LOCK/$CREATE_LOCK_OWNER_TOKEN"
CREATE_LOCK_RELEASE="$CREATE_LOCK.releasing.$CREATE_LOCK_OWNER_TOKEN"
CREATE_LOCK_RELEASE_OWNER_PATH="$CREATE_LOCK_RELEASE/$CREATE_LOCK_OWNER_TOKEN"

# Every value read by a signal/EXIT handler is initialized before traps are
# armed. IN_CRITICAL defers trappable cancellation until a short ownership
# command and its parent-shell flags have committed together.
CREATE_LOCK_HELD=0
CREATE_LOCK_OWNER_PUBLISHED=0
BRANCH_OWNED=0
ROLLBACK_ARMED=0
CANCELLED=0
IN_CRITICAL=0
PUBLISHED=0
CREATED_PATH=''
MARKER_TMP=''
MARKER_PATH=''

install_marker() {
  local worktree_path=$1
  local branch=$2
  local path_sha1=''
  local marker_dir=''

  path_sha1=$(sha1_text "$worktree_path") || return 1
  [ "${#path_sha1}" -eq 40 ] || return 1
  case "$path_sha1" in
    *[!0-9a-f]*) return 1 ;;
  esac

  marker_dir="$SOURCE_COMMON/codex-harness-worktrees"
  MARKER_PATH="$marker_dir/$path_sha1.json"
  if [ -e "$marker_dir" ] && { [ ! -d "$marker_dir" ] || [ -L "$marker_dir" ]; }; then
    return 1
  fi
  umask 077
  mkdir -p "$marker_dir" || return 1
  chmod 700 "$marker_dir" || return 1

  if [ -e "$MARKER_PATH" ] || [ -L "$MARKER_PATH" ]; then
    [ -f "$MARKER_PATH" ] && [ ! -L "$MARKER_PATH" ] && \
      jq -e --arg path "$worktree_path" --arg branch "$branch" '
        type == "object"
        and .path == $path
        and .branch == $branch
        and (keys | sort) == ["branch", "path"]
      ' "$MARKER_PATH" >/dev/null 2>&1
    return
  fi

  MARKER_TMP=$(mktemp "$marker_dir/.${path_sha1}.XXXXXX") || return 1
  jq -n --arg path "$worktree_path" --arg branch "$branch" \
    '{path: $path, branch: $branch}' >"$MARKER_TMP" || return 1
  chmod 600 "$MARKER_TMP" || return 1
  ln "$MARKER_TMP" "$MARKER_PATH" || return 1
  rm "$MARKER_TMP" || return 1
  MARKER_TMP=''
}

release_create_lock() {
  [ "$CREATE_LOCK_HELD" -eq 1 ] || return 0

  # Rename ownership out of the shared branch-lock namespace first. A successor
  # may acquire CREATE_LOCK immediately after mv; every remaining cleanup step
  # uses this invocation's unique tombstone and can never remove that successor.
  if [ ! -e "$CREATE_LOCK_RELEASE" ] && [ ! -L "$CREATE_LOCK_RELEASE" ]; then
    if [ "$CREATE_LOCK_OWNER_PUBLISHED" -eq 1 ]; then
      [ -f "$CREATE_LOCK_OWNER_PATH" ] && [ ! -L "$CREATE_LOCK_OWNER_PATH" ] \
        || return 1
    else
      [ -d "$CREATE_LOCK" ] && [ ! -L "$CREATE_LOCK" ] || return 1
      chmod 700 "$CREATE_LOCK" || return 1
    fi
    mv "$CREATE_LOCK" "$CREATE_LOCK_RELEASE" || return 1
  fi
  [ -d "$CREATE_LOCK_RELEASE" ] && [ ! -L "$CREATE_LOCK_RELEASE" ] \
    || return 1
  if [ -e "$CREATE_LOCK_RELEASE_OWNER_PATH" ] || [ -L "$CREATE_LOCK_RELEASE_OWNER_PATH" ]; then
    [ -f "$CREATE_LOCK_RELEASE_OWNER_PATH" ] && [ ! -L "$CREATE_LOCK_RELEASE_OWNER_PATH" ] \
      || return 1
    rm -f "$CREATE_LOCK_RELEASE_OWNER_PATH" || return 1
  fi
  rmdir "$CREATE_LOCK_RELEASE" || rmdir "$CREATE_LOCK_RELEASE"
}

cleanup_create() {
  local status=$?
  local candidate_raw=''
  local candidate_path=''
  local candidate_top_raw=''
  local candidate_top=''
  local candidate_git_raw=''
  local candidate_git=''
  local candidate_common_raw=''
  local candidate_common=''
  local candidate_branch=''
  local candidate_valid=0

  trap - EXIT HUP INT TERM
  set +e
  if [ -n "$MARKER_TMP" ]; then
    rm -f "$MARKER_TMP"
    MARKER_TMP=''
  fi

  if [ "$ROLLBACK_ARMED" -eq 1 ] && [ "$PUBLISHED" -eq 0 ]; then
    candidate_path=$CREATED_PATH
    if [ -z "$candidate_path" ]; then
      candidate_raw=$("$GWQ" get "$NAME" 2>/dev/null)
      if [ -z "$candidate_raw" ]; then
        candidate_raw=$(git --git-dir="$SOURCE_COMMON" worktree list --porcelain 2>/dev/null | \
          awk -v ref="refs/heads/$NAME" '
            $1 == "worktree" { path = substr($0, 10) }
            $1 == "branch" && $2 == ref { print path; exit }
          ')
      fi
      if [ -n "$candidate_raw" ]; then
        candidate_path=$(canonical_dir "$candidate_raw" 2>/dev/null)
      fi
    fi

    if [ -n "$candidate_path" ] && [ -d "$candidate_path" ]; then
      candidate_top_raw=$(git -C "$candidate_path" rev-parse --show-toplevel 2>/dev/null)
      candidate_top=$(canonical_dir "$candidate_top_raw" 2>/dev/null)
      candidate_git_raw=$(git -C "$candidate_path" rev-parse --git-dir 2>/dev/null)
      candidate_git=$(resolve_git_dir "$candidate_path" "$candidate_git_raw" 2>/dev/null)
      candidate_common_raw=$(git -C "$candidate_path" rev-parse --git-common-dir 2>/dev/null)
      candidate_common=$(resolve_git_dir "$candidate_path" "$candidate_common_raw" 2>/dev/null)
      candidate_branch=$(git -C "$candidate_path" symbolic-ref --quiet --short HEAD 2>/dev/null)
      if [ "$candidate_top" = "$candidate_path" ] && \
        [ "$candidate_common" = "$SOURCE_COMMON" ] && \
        [ "$candidate_branch" = "$NAME" ]; then
        case "$candidate_git" in
          "$SOURCE_COMMON"/worktrees/*) candidate_valid=1 ;;
        esac
      fi
    fi

    if [ "$CANCELLED" -eq 1 ] && [ "$candidate_valid" -eq 1 ] && \
      install_marker "$candidate_path" "$NAME"; then
      # The caller accepts one unique non-empty path line, so a duplicate write
      # from a signal racing the normal printf remains unambiguous.
      printf '%s\n' "$candidate_path"
      PUBLISHED=1
      ROLLBACK_ARMED=0
    else
      if [ "$candidate_valid" -eq 1 ]; then
        if [ -n "$MARKER_PATH" ] && [ -f "$MARKER_PATH" ] && [ ! -L "$MARKER_PATH" ] && \
          jq -e --arg path "$candidate_path" --arg branch "$NAME" '
            type == "object" and .path == $path and .branch == $branch
          ' "$MARKER_PATH" >/dev/null 2>&1; then
          rm -f "$MARKER_PATH"
        fi
        git --git-dir="$SOURCE_COMMON" worktree remove --force "$candidate_path" >&2
      fi

      if [ "$BRANCH_OWNED" -eq 1 ] && \
        ! git --git-dir="$SOURCE_COMMON" worktree list --porcelain 2>/dev/null | \
          grep -Fqx "branch refs/heads/$NAME"; then
        # Delete only the unchanged ref this invocation atomically reserved.
        git -C "$SOURCE_TOP" update-ref -d "refs/heads/$NAME" "$SOURCE_HEAD"
      fi
    fi
  fi

  if [ "$CREATE_LOCK_HELD" -eq 1 ] && release_create_lock; then
    CREATE_LOCK_HELD=0
  fi
  exit "$status"
}

handle_cancel() {
  CANCELLED=1
  if [ "$IN_CRITICAL" -eq 1 ]; then
    return 0
  fi
  exit 130
}

honor_deferred_cancel() {
  if [ "$CANCELLED" -eq 1 ]; then
    exit 130
  fi
}

trap cleanup_create EXIT
trap handle_cancel HUP INT TERM

LOCK_STATUS=0
IN_CRITICAL=1
if (
  trap '' HUP INT TERM
  mkdir "$CREATE_LOCK" || exit 10
  : >"$CREATE_LOCK_OWNER_PATH" || exit 11
  chmod 600 "$CREATE_LOCK_OWNER_PATH" || exit 12
); then
  CREATE_LOCK_HELD=1
  CREATE_LOCK_OWNER_PUBLISHED=1
else
  LOCK_STATUS=$?
  # Distinct setup statuses prove mkdir ownership even when owner publication
  # itself failed. Commit that identity so EXIT cleanup can atomically rename
  # the directory into our unique tombstone instead of stranding the lock.
  case "$LOCK_STATUS" in
    11)
      CREATE_LOCK_HELD=1
      ;;
    12)
      CREATE_LOCK_HELD=1
      CREATE_LOCK_OWNER_PUBLISHED=1
      ;;
  esac
fi
IN_CRITICAL=0
honor_deferred_cancel
if [ "$LOCK_STATUS" -ne 0 ]; then
  if [ "$CREATE_LOCK_HELD" -eq 1 ]; then
    fail "could not initialize worktree create lock for branch: $NAME"
  fi
  fail "another worktree create is already using branch: $NAME"
fi

REF_STATUS=0
IN_CRITICAL=1
if (
  trap '' HUP INT TERM
  exec git -C "$SOURCE_TOP" update-ref "refs/heads/$NAME" "$SOURCE_HEAD" ''
); then
  BRANCH_OWNED=1
  ROLLBACK_ARMED=1
else
  REF_STATUS=$?
fi
IN_CRITICAL=0
honor_deferred_cancel
[ "$REF_STATUS" -eq 0 ] \
  || fail "branch already exists or is invalid: $NAME"
"$GWQ" add "$NAME" >&2 || fail "gwq could not create worktree for branch: $NAME"
if ! CREATED_PATH_RAW=$("$GWQ" get "$NAME" 2>/dev/null); then
  fail "gwq created the worktree but its path could not be resolved: $NAME"
fi
[ -n "$CREATED_PATH_RAW" ] \
  || fail "gwq returned an empty worktree path for branch: $NAME"
CREATED_PATH=$(canonical_dir "$CREATED_PATH_RAW") \
  || fail "created worktree path does not exist: $CREATED_PATH_RAW"

if ! TOP_RAW=$(git -C "$CREATED_PATH" rev-parse --show-toplevel 2>/dev/null); then
  fail "created path is not a Git worktree: $CREATED_PATH"
fi
TOP=$(canonical_dir "$TOP_RAW") \
  || fail "could not canonicalize the created worktree root: $TOP_RAW"
[ "$TOP" = "$CREATED_PATH" ] \
  || fail "created path is not the worktree root: $CREATED_PATH"

if ! GIT_DIR_RAW=$(git -C "$CREATED_PATH" rev-parse --git-dir 2>/dev/null); then
  fail "could not determine the created worktree Git directory: $CREATED_PATH"
fi
if ! COMMON_DIR_RAW=$(git -C "$CREATED_PATH" rev-parse --git-common-dir 2>/dev/null); then
  fail "could not determine the created worktree common directory: $CREATED_PATH"
fi
GIT_DIR=$(resolve_git_dir "$CREATED_PATH" "$GIT_DIR_RAW") \
  || fail 'could not canonicalize the created worktree Git directory'
COMMON_DIR=$(resolve_git_dir "$CREATED_PATH" "$COMMON_DIR_RAW") \
  || fail 'could not canonicalize the created worktree common directory'

[ "$COMMON_DIR" = "$SOURCE_COMMON" ] \
  || fail "created worktree belongs to a different repository: $CREATED_PATH"
case "$GIT_DIR" in
  "$COMMON_DIR"/worktrees/*) ;;
  *) fail "created path is not a linked Git worktree: $CREATED_PATH" ;;
esac

if ! BRANCH=$(git -C "$CREATED_PATH" symbolic-ref --quiet --short HEAD 2>/dev/null); then
  fail "created worktree has a detached HEAD: $CREATED_PATH"
fi
[ "$BRANCH" = "$NAME" ] \
  || fail "created worktree branch mismatch (expected '$NAME', got '$BRANCH')"

install_marker "$CREATED_PATH" "$BRANCH" \
  || fail "could not atomically install a safe-removal marker for: $CREATED_PATH"

# stdout is the publication record consumed by the TypeScript caller. A signal
# before this write publishes the same marker/path from cleanup_create.
printf '%s\n' "$CREATED_PATH"
PUBLISHED=1
ROLLBACK_ARMED=0
LOCK_RELEASE_STATUS=0
IN_CRITICAL=1
if (
  trap '' HUP INT TERM
  release_create_lock
); then
  CREATE_LOCK_HELD=0
else
  LOCK_RELEASE_STATUS=$?
fi
IN_CRITICAL=0
honor_deferred_cancel
[ "$LOCK_RELEASE_STATUS" -eq 0 ] \
  || fail "could not release worktree create lock: $CREATE_LOCK"
trap - EXIT HUP INT TERM
