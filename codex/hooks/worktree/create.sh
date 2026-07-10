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

"$GWQ" add -b "$NAME" >&2 || fail "gwq could not create branch: $NAME"
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

PATH_SHA1=$(sha1_text "$CREATED_PATH") \
  || fail 'no SHA-1 implementation is available (shasum, sha1sum, or openssl)'
[ "${#PATH_SHA1}" -eq 40 ] || fail 'failed to compute the canonical path SHA-1'
case "$PATH_SHA1" in
  *[!0-9a-f]*) fail 'failed to compute the canonical path SHA-1' ;;
esac

MARKER_DIR="$COMMON_DIR/codex-harness-worktrees"
MARKER_PATH="$MARKER_DIR/$PATH_SHA1.json"
if [ -e "$MARKER_DIR" ] && { [ ! -d "$MARKER_DIR" ] || [ -L "$MARKER_DIR" ]; }; then
  fail "marker location is not a safe directory: $MARKER_DIR"
fi
umask 077
mkdir -p "$MARKER_DIR" || fail "could not create marker directory: $MARKER_DIR"
chmod 700 "$MARKER_DIR" || fail "could not secure marker directory: $MARKER_DIR"
if [ -e "$MARKER_PATH" ] || [ -L "$MARKER_PATH" ]; then
  fail "refusing to overwrite an existing worktree marker: $MARKER_PATH"
fi

MARKER_TMP=$(mktemp "$MARKER_DIR/.${PATH_SHA1}.XXXXXX") \
  || fail 'could not create a temporary worktree marker'
cleanup_marker_tmp() {
  rm -f "$MARKER_TMP"
}
trap cleanup_marker_tmp EXIT
if ! jq -n --arg path "$CREATED_PATH" --arg branch "$BRANCH" \
  '{path: $path, branch: $branch}' >"$MARKER_TMP"; then
  fail 'could not serialize the worktree marker'
fi
chmod 600 "$MARKER_TMP" || fail 'could not secure the worktree marker'
ln "$MARKER_TMP" "$MARKER_PATH" \
  || fail "could not atomically install marker without overwriting: $MARKER_PATH"
rm "$MARKER_TMP" || fail "could not remove temporary marker: $MARKER_TMP"
trap - EXIT

printf '%s\n' "$CREATED_PATH"
