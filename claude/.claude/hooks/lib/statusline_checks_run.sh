#!/bin/bash
# Background runner for statusline lint/typecheck/test checks.
# Arguments:
#   $1 project cwd (any path within or at the project root)
#   $2 (optional) canonical trusted-root boundary — the discovered project root
#      must stay within it, else the run is refused (fail-closed).
# Behaviour: detect project, acquire lockdir, execute TTL-expired checks
# sequentially, write JSON cache atomically. All stdout/stderr from checks
# is discarded so that callers running this under `async: true` hooks
# don't leak output into the next-turn context.

set -u

PROJECT_ROOT_ARG=${1:-}
TRUST_BOUNDARY=${2:-}
[ -z "$PROJECT_ROOT_ARG" ] && exit 0

LIB_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=claude/.claude/hooks/lib/statusline_checks_lib.sh
source "$LIB_DIR/statusline_checks_lib.sh"

PROJECT_ROOT=$(find_project_root "$PROJECT_ROOT_ARG")
[ -z "$PROJECT_ROOT" ] && exit 0

# Trust boundary: this runner executes repository-defined commands, so a project
# root discovered by walking up from the cwd must not escape the canonical
# trusted root the caller verified. Without this, a missing in-trust marker lets
# find_project_root ascend into an untrusted parent and run its scripts (TOCTOU).
if [ -n "$TRUST_BOUNDARY" ]; then
    canon_root=$(cd "$PROJECT_ROOT" 2>/dev/null && pwd -P) || exit 0
    canon_boundary=$(cd "$TRUST_BOUNDARY" 2>/dev/null && pwd -P) || exit 0
    case "$canon_root" in
        "$canon_boundary" | "$canon_boundary"/*) : ;;
        *) exit 0 ;;
    esac
fi

LANG_TYPE=$(detect_project_type "$PROJECT_ROOT")
[ -z "$LANG_TYPE" ] && exit 0

LABEL=$(project_label "$LANG_TYPE")
CACHE_DIR=$(statusline_cache_dir)
CACHE_FILE=$(cache_file_path "$PROJECT_ROOT")
LOCKDIR=$(lock_dir_path "$PROJECT_ROOT")

mkdir -p "$CACHE_DIR"

acquire_lock() {
    if mkdir "$LOCKDIR" 2>/dev/null; then
        printf '%s %s\n' "$$" "$(statusline_now)" > "$LOCKDIR/owner"
        return 0
    fi
    if [ -f "$LOCKDIR/owner" ]; then
        local pid started_at now
        read -r pid started_at < "$LOCKDIR/owner"
        now=$(statusline_now)
        # Recover stale lock: holder gone, or older than 30 minutes.
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

if [ -n "${STATUSLINE_COUNTER_FILE:-}" ]; then
    echo "$$" >> "$STATUSLINE_COUNTER_FILE"
fi

read_cache() {
    if [ -f "$CACHE_FILE" ]; then
        local content
        content=$(cat "$CACHE_FILE")
        if printf '%s' "$content" | jq -e . > /dev/null 2>&1; then
            printf '%s' "$content"
            return
        fi
    fi
    jq -n \
        --arg root "$PROJECT_ROOT" \
        --arg lang "$LANG_TYPE" \
        --arg label "$LABEL" \
        '{
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
    local payload=$1
    local tmpfile="${CACHE_FILE}.tmp.$$"
    printf '%s' "$payload" > "$tmpfile"
    mv "$tmpfile" "$CACHE_FILE"
}

should_run_slot() {
    local slot=$1
    local cache=$2
    local now=$3
    local last ttl
    last=$(printf '%s' "$cache" | jq -r --arg s "$slot" '.checks[$s].last_completed_at // "null"')
    ttl=$(statusline_ttl "$slot")
    if should_skip_for_ttl "$last" "$now" "$ttl"; then
        return 1
    fi
    return 0
}

resolve_cmd() {
    local slot=$1
    case "$LANG_TYPE" in
        rust)
            case "$slot" in
                lint)      echo "cargo clippy --quiet --no-deps -- -D warnings" ;;
                typecheck) echo "cargo check --quiet" ;;
                test)      echo "cargo test --quiet" ;;
            esac
            ;;
        moonbit)
            case "$slot" in
                lint)      echo "moon check --deny-warn" ;;
                typecheck) echo "moon check" ;;
                test)      echo "moon test" ;;
            esac
            ;;
        ts)
            local pm script
            pm=$(detect_package_manager "$PROJECT_ROOT")
            [ -z "$pm" ] && return 0
            script=$(resolve_script_key "$slot" "$PROJECT_ROOT/package.json") || return 0
            [ -z "$script" ] && return 0
            echo "$pm run $script"
            ;;
    esac
}

mark_running() {
    local slot=$1
    local now=$2
    local current new
    current=$(read_cache)
    new=$(printf '%s' "$current" | jq \
        --arg s "$slot" \
        --argjson now "$now" \
        '
        .updated_at = $now |
        .checks[$s] = {
            status: "running",
            previous_status: .checks[$s].status,
            running_since: $now,
            last_completed_at: .checks[$s].last_completed_at
        }')
    write_cache "$new"
}

finish_slot() {
    local slot=$1
    local result=$2
    local now=$3
    local current new last_arg
    current=$(read_cache)
    if [ "$result" = "skipped" ]; then
        last_arg="null"
    else
        last_arg="$now"
    fi
    new=$(printf '%s' "$current" | jq \
        --arg s "$slot" \
        --arg r "$result" \
        --argjson now "$now" \
        --argjson last "$last_arg" \
        '
        .updated_at = $now |
        .checks[$s] = {
            status: $r,
            previous_status: null,
            running_since: null,
            last_completed_at: $last
        }')
    write_cache "$new"
}

# Resolves and runs a single timeout-wrapped command. Available timeout binary
# is detected once; absent on minimal systems → run without timeout.
run_with_timeout() {
    local secs=$1
    shift
    if command -v timeout > /dev/null 2>&1; then
        timeout "$secs" "$@"
    elif command -v gtimeout > /dev/null 2>&1; then
        gtimeout "$secs" "$@"
    else
        "$@"
    fi
}

run_check() {
    local slot=$1
    local now cmd tmo result done_at
    now=$(statusline_now)

    cmd=$(resolve_cmd "$slot")
    if [ -z "$cmd" ]; then
        finish_slot "$slot" "skipped" "$now"
        return
    fi

    mark_running "$slot" "$now"

    tmo=$(statusline_check_timeout "$slot")
    result="ok"
    (cd "$PROJECT_ROOT" && run_with_timeout "$tmo" bash -c "$cmd" > /dev/null 2>&1) || result="fail"

    done_at=$(statusline_now)
    finish_slot "$slot" "$result" "$done_at"
}

NOW=$(statusline_now)
CACHE=$(read_cache)

# Compute due slots once against the pre-mutation cache. Re-evaluating
# should_run_slot after mark_running has rewritten checks[].{status,running_since}
# would let a cache that's structurally diverged from the initial decision
# silently strand a slot in `running` without ever executing the command.
DUE_SLOTS=""
for slot in lint typecheck test; do
    if should_run_slot "$slot" "$CACHE" "$NOW"; then
        DUE_SLOTS="$DUE_SLOTS $slot"
    fi
done

# First pass: pre-mark every due slot with a resolvable command as running so
# the statusline shows in-flight state from the moment the runner starts,
# even before each individual check completes.
for slot in $DUE_SLOTS; do
    cmd=$(resolve_cmd "$slot")
    if [ -n "$cmd" ]; then
        mark_running "$slot" "$NOW"
    fi
done

# Second pass: execute the precomputed due set. run_check itself handles the
# empty-cmd case by writing a `skipped` result.
for slot in $DUE_SLOTS; do
    run_check "$slot"
done

exit 0
