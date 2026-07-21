#!/usr/bin/env bash
# Explicit compatibility command; Codex 0.144 has no WorktreeRemove hook event.
set -euo pipefail

fail() {
  printf 'worktree remove: %s\n' "$*" >&2
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

file_identity() {
  local path=$1
  local identity=''
  if identity=$(stat -c '%d:%i' -- "$path" 2>/dev/null); then
    :
  elif identity=$(stat -f '%d:%i' "$path" 2>/dev/null); then
    :
  else
    return 1
  fi
  case "$identity" in
    *[!0-9:]* | :* | *: | *:*:*) return 1 ;;
  esac
  printf '%s\n' "$identity"
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
if ! printf '%s' "$INPUT" | jq -e '.confirmed == true' >/dev/null 2>&1; then
  fail 'refusing removal without JSON field: confirmed=true'
fi
if ! WORKTREE_PATH=$(printf '%s' "$INPUT" | jq -er '
  .worktree_path | select(type == "string" and length > 0)
' 2>/dev/null); then
  fail 'input must include a non-empty string field: worktree_path'
fi
case "$WORKTREE_PATH" in
  /*) ;;
  *) fail "worktree_path must be an absolute canonical path: $WORKTREE_PATH" ;;
esac
[ -d "$WORKTREE_PATH" ] \
  || fail "worktree path does not exist or is not a directory: $WORKTREE_PATH"
CANONICAL_PATH=$(canonical_dir "$WORKTREE_PATH") \
  || fail "could not canonicalize worktree path: $WORKTREE_PATH"
[ "$WORKTREE_PATH" = "$CANONICAL_PATH" ] \
  || fail "worktree_path is not canonical (expected '$CANONICAL_PATH')"

if ! TOP_RAW=$(git -C "$CANONICAL_PATH" rev-parse --show-toplevel 2>/dev/null); then
  fail "path is not a Git worktree: $CANONICAL_PATH"
fi
TOP=$(canonical_dir "$TOP_RAW") \
  || fail "could not canonicalize Git worktree root: $TOP_RAW"
[ "$TOP" = "$CANONICAL_PATH" ] \
  || fail "path is not the exact worktree root: $CANONICAL_PATH"

if ! GIT_DIR_RAW=$(git -C "$CANONICAL_PATH" rev-parse --git-dir 2>/dev/null); then
  fail "could not determine the worktree Git directory: $CANONICAL_PATH"
fi
if ! COMMON_DIR_RAW=$(git -C "$CANONICAL_PATH" rev-parse --git-common-dir 2>/dev/null); then
  fail "could not determine the Git common directory: $CANONICAL_PATH"
fi
GIT_DIR=$(resolve_git_dir "$CANONICAL_PATH" "$GIT_DIR_RAW") \
  || fail 'could not canonicalize the worktree Git directory'
COMMON_DIR=$(resolve_git_dir "$CANONICAL_PATH" "$COMMON_DIR_RAW") \
  || fail 'could not canonicalize the Git common directory'
case "$GIT_DIR" in
  "$COMMON_DIR"/worktrees/*) ;;
  *) fail "refusing to remove a path that is not a linked Git worktree: $CANONICAL_PATH" ;;
esac

if ! BRANCH=$(git -C "$CANONICAL_PATH" symbolic-ref --quiet --short HEAD 2>/dev/null); then
  fail "refusing to remove a detached worktree: $CANONICAL_PATH"
fi
PATH_SHA1=$(sha1_text "$CANONICAL_PATH") \
  || fail 'no SHA-1 implementation is available (shasum, sha1sum, or openssl)'
[ "${#PATH_SHA1}" -eq 40 ] || fail 'failed to compute the canonical path SHA-1'
case "$PATH_SHA1" in
  *[!0-9a-f]*) fail 'failed to compute the canonical path SHA-1' ;;
esac

MARKER_DIR="$COMMON_DIR/codex-harness-worktrees"
MARKER_PATH="$MARKER_DIR/$PATH_SHA1.json"
if [ ! -d "$MARKER_DIR" ] || [ -L "$MARKER_DIR" ]; then
  fail "safe marker directory does not exist: $MARKER_DIR"
fi
if [ ! -f "$MARKER_PATH" ] || [ -L "$MARKER_PATH" ]; then
  fail "matching worktree marker does not exist: $MARKER_PATH"
fi
if ! jq -e --arg path "$CANONICAL_PATH" --arg branch "$BRANCH" '
  type == "object"
  and .version == 1
  and .path == $path
  and .branch == $branch
  and (.root | type == "object" and (keys | sort) == ["dev", "ino"])
  and (.dotGit | type == "object" and (keys | sort) == ["dev", "ino"])
  and (.root.dev | type == "string" and test("^(0|[1-9][0-9]*)$"))
  and (.root.ino | type == "string" and test("^(0|[1-9][0-9]*)$"))
  and (.dotGit.dev | type == "string" and test("^(0|[1-9][0-9]*)$"))
  and (.dotGit.ino | type == "string" and test("^(0|[1-9][0-9]*)$"))
  and (keys | sort) == ["branch", "dotGit", "path", "root", "version"]
' "$MARKER_PATH" >/dev/null 2>&1; then
  fail "worktree marker does not exactly match path, branch, and identity: $MARKER_PATH"
fi
MARKER_ROOT_DEV=$(jq -r '.root.dev' "$MARKER_PATH")
MARKER_ROOT_INO=$(jq -r '.root.ino' "$MARKER_PATH")
MARKER_DOT_GIT_DEV=$(jq -r '.dotGit.dev' "$MARKER_PATH")
MARKER_DOT_GIT_INO=$(jq -r '.dotGit.ino' "$MARKER_PATH")

marker_identity_matches() {
  local root_identity=''
  local dot_git_identity=''
  [ -d "$CANONICAL_PATH" ] && [ ! -L "$CANONICAL_PATH" ] || return 1
  [ -f "$CANONICAL_PATH/.git" ] && [ ! -L "$CANONICAL_PATH/.git" ] || return 1
  root_identity=$(file_identity "$CANONICAL_PATH") || return 1
  dot_git_identity=$(file_identity "$CANONICAL_PATH/.git") || return 1
  [ "$root_identity" = "$MARKER_ROOT_DEV:$MARKER_ROOT_INO" ] &&
    [ "$dot_git_identity" = "$MARKER_DOT_GIT_DEV:$MARKER_DOT_GIT_INO" ]
}

marker_identity_matches \
  || fail "worktree identity no longer matches its safe-removal marker: $CANONICAL_PATH"

if ! STATUS=$(git -C "$CANONICAL_PATH" status --porcelain=v1 --untracked-files=normal 2>/dev/null); then
  fail "could not inspect worktree status: $CANONICAL_PATH"
fi
[ -z "$STATUS" ] \
  || fail "refusing to remove a dirty worktree: $CANONICAL_PATH"
marker_identity_matches \
  || fail "worktree identity changed during removal validation: $CANONICAL_PATH"

if ! git --git-dir="$COMMON_DIR" worktree remove "$CANONICAL_PATH" >&2; then
  fail "Git refused to remove the worktree without force: $CANONICAL_PATH"
fi
rm "$MARKER_PATH" \
  || fail "worktree was removed, but its marker could not be deleted: $MARKER_PATH"
