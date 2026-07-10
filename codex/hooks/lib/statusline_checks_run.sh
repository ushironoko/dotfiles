#!/usr/bin/env bash
# Background lint/typecheck/test runner. All command output is intentionally discarded.
set -u

PROJECT_ROOT_ARG=${1:-}
[ -n "$PROJECT_ROOT_ARG" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

LIB_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=codex/hooks/lib/statusline_checks_lib.sh
source "$LIB_DIR/statusline_checks_lib.sh"
# shellcheck source=codex/hooks/lib/trusted_project.sh
source "$LIB_DIR/trusted_project.sh"

PROJECT_ROOT=$(find_project_root "$PROJECT_ROOT_ARG")
[ -n "$PROJECT_ROOT" ] || exit 0
# User hooks are global. Check the directory that owns the commands, not merely
# the input cwd, so a trusted subdirectory cannot authorize an untrusted parent.
codex_project_is_trusted "$PROJECT_ROOT" || exit 0
LANG_TYPE=$(detect_project_type "$PROJECT_ROOT")
[ -n "$LANG_TYPE" ] || exit 0

LABEL=$(project_label "$LANG_TYPE")
CACHE_DIR=$(statusline_cache_dir)
CACHE_FILE=$(cache_file_path "$PROJECT_ROOT")
LOCKDIR=$(lock_dir_path "$PROJECT_ROOT")
mkdir -p "$CACHE_DIR"

acquire_lock() {
  local pid started_at now
  if mkdir "$LOCKDIR" 2>/dev/null; then
    printf '%s %s\n' "$$" "$(statusline_now)" > "$LOCKDIR/owner"
    return 0
  fi
  if [ -f "$LOCKDIR/owner" ]; then
    read -r pid started_at < "$LOCKDIR/owner"
    now=$(statusline_now)
    if ! kill -0 "$pid" 2>/dev/null || [ $((now - started_at)) -gt 1800 ]; then
      rm -rf "$LOCKDIR"
      mkdir "$LOCKDIR" 2>/dev/null || return 1
      printf '%s %s\n' "$$" "$now" > "$LOCKDIR/owner"
      return 0
    fi
  fi
  return 1
}

acquire_lock || exit 0
# shellcheck disable=SC2064
trap "rm -rf '$LOCKDIR'" EXIT INT TERM

read_cache() {
  local content
  if [ -f "$CACHE_FILE" ]; then
    content=$(cat "$CACHE_FILE")
    if printf '%s' "$content" | jq -e . >/dev/null 2>&1; then
      printf '%s' "$content"
      return
    fi
  fi
  jq -n --arg root "$PROJECT_ROOT" --arg lang "$LANG_TYPE" --arg label "$LABEL" '{
    project_root: $root,
    language: $lang,
    label: $label,
    updated_at: 0,
    checks: {
      lint:      {status:"skipped", previous_status:null, running_since:null, last_completed_at:null},
      typecheck: {status:"skipped", previous_status:null, running_since:null, last_completed_at:null},
      test:      {status:"skipped", previous_status:null, running_since:null, last_completed_at:null}
    }
  }'
}

write_cache() {
  local payload=$1 tmpfile="${CACHE_FILE}.tmp.$$"
  printf '%s' "$payload" > "$tmpfile"
  mv "$tmpfile" "$CACHE_FILE"
}

resolve_cmd() {
  local slot=$1 pm script
  case "$LANG_TYPE:$slot" in
    rust:lint) echo 'cargo clippy --quiet --no-deps -- -D warnings' ;;
    rust:typecheck) echo 'cargo check --quiet' ;;
    rust:test) echo 'cargo test --quiet' ;;
    moonbit:lint) echo 'moon check --deny-warn' ;;
    moonbit:typecheck) echo 'moon check' ;;
    moonbit:test) echo 'moon test' ;;
    ts:*)
      pm=$(detect_package_manager "$PROJECT_ROOT")
      [ -n "$pm" ] || return 0
      script=$(resolve_script_key "$slot" "$PROJECT_ROOT/package.json") || return 0
      [ -n "$script" ] && echo "$pm run $script"
      ;;
  esac
}

mark_running() {
  local slot=$1 now=$2 current new
  current=$(read_cache)
  new=$(printf '%s' "$current" | jq --arg slot "$slot" --argjson now "$now" '
    .updated_at = $now
    | .checks[$slot] = {
        status: "running",
        previous_status: .checks[$slot].status,
        running_since: $now,
        last_completed_at: .checks[$slot].last_completed_at
      }
  ')
  write_cache "$new"
}

finish_slot() {
  local slot=$1 result=$2 now=$3 current new last
  current=$(read_cache)
  if [ "$result" = skipped ]; then last=null; else last=$now; fi
  new=$(printf '%s' "$current" | jq \
    --arg slot "$slot" --arg result "$result" --argjson now "$now" --argjson last "$last" '
      .updated_at = $now
      | .checks[$slot] = {
          status: $result,
          previous_status: null,
          running_since: null,
          last_completed_at: $last
        }
    ')
  write_cache "$new"
}

run_with_timeout() {
  local seconds=$1
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
  else
    "$@"
  fi
}

run_check() {
  local slot=$1 command timeout_seconds result completed_at
  command=$(resolve_cmd "$slot")
  if [ -z "$command" ]; then
    finish_slot "$slot" skipped "$(statusline_now)"
    return
  fi
  result=ok
  timeout_seconds=$(statusline_check_timeout "$slot")
  (cd "$PROJECT_ROOT" && run_with_timeout "$timeout_seconds" bash -c "$command" >/dev/null 2>&1) || result=fail
  completed_at=$(statusline_now)
  finish_slot "$slot" "$result" "$completed_at"
}

NOW=$(statusline_now)
CACHE=$(read_cache)
DUE_SLOTS=""
for slot in lint typecheck test; do
  last=$(printf '%s' "$CACHE" | jq -r --arg slot "$slot" '.checks[$slot].last_completed_at // "null"')
  ttl=$(statusline_ttl "$slot")
  if ! should_skip_for_ttl "$last" "$NOW" "$ttl"; then
    DUE_SLOTS="$DUE_SLOTS $slot"
  fi
done

for slot in $DUE_SLOTS; do
  command=$(resolve_cmd "$slot")
  if [ -n "$command" ]; then
    mark_running "$slot" "$NOW"
  fi
done

for slot in $DUE_SLOTS; do
  run_check "$slot"
done
