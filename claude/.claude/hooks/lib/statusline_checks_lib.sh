#!/bin/bash
# Pure helper functions for statusline check runner / renderer.
# Sourceable; each function should be side-effect free except for stdout.

statusline_now() {
    if [ -n "${STATUSLINE_NOW_OVERRIDE:-}" ]; then
        echo "$STATUSLINE_NOW_OVERRIDE"
    else
        date +%s
    fi
}

statusline_ttl() {
    case "$1" in
        lint)      echo "${STATUSLINE_TTL_LINT:-30}" ;;
        typecheck) echo "${STATUSLINE_TTL_TYPECHECK:-30}" ;;
        test)      echo "${STATUSLINE_TTL_TEST:-300}" ;;
        *)         echo 0 ;;
    esac
}

statusline_check_timeout() {
    case "$1" in
        lint|typecheck) echo 60 ;;
        test)           echo 300 ;;
        *)              echo 60 ;;
    esac
}

statusline_cache_dir() {
    echo "${STATUSLINE_CACHE_DIR:-${TMPDIR:-/tmp}/claude-statusline-checks}"
}

# walks up from CWD until project marker is found; echoes the abs path or empty.
find_project_root() {
    local dir=$1
    [ -z "$dir" ] && return 1
    while true; do
        if [ -f "$dir/Cargo.toml" ] || [ -f "$dir/moon.mod.json" ]; then
            echo "$dir"
            return 0
        fi
        if [ -f "$dir/package.json" ]; then
            if [ -f "$dir/tsconfig.json" ] || [ -f "$dir/pnpm-lock.yaml" ] || [ -f "$dir/bun.lock" ] || [ -f "$dir/bun.lockb" ]; then
                echo "$dir"
                return 0
            fi
        fi
        [ "$dir" = "/" ] && break
        local parent
        parent=$(dirname "$dir")
        [ "$parent" = "$dir" ] && break
        dir=$parent
    done
    return 1
}

detect_project_type() {
    local root=$1
    if [ -f "$root/Cargo.toml" ]; then
        echo "rust"
    elif [ -f "$root/moon.mod.json" ]; then
        echo "moonbit"
    elif [ -f "$root/package.json" ]; then
        if [ -f "$root/tsconfig.json" ] || [ -f "$root/pnpm-lock.yaml" ] || [ -f "$root/bun.lock" ] || [ -f "$root/bun.lockb" ]; then
            echo "ts"
        fi
    fi
}

project_label() {
    case "$1" in
        rust)    echo "RS" ;;
        moonbit) echo "MB" ;;
        ts)      echo "TS" ;;
    esac
}

# pnpm wins over bun when both lockfiles exist (matches global CLAUDE.md rule).
detect_package_manager() {
    local root=$1
    if [ -f "$root/pnpm-lock.yaml" ]; then
        echo "pnpm"
    elif [ -f "$root/bun.lock" ] || [ -f "$root/bun.lockb" ]; then
        echo "bun"
    fi
}

# Echoes the first scripts[key] found in package.json for the given slot.
resolve_script_key() {
    local slot=$1
    local pkg_path=$2
    [ -f "$pkg_path" ] || return 1
    local candidates
    case "$slot" in
        lint)      candidates="lint" ;;
        typecheck) candidates="typecheck tsc check" ;;
        test)      candidates="test" ;;
        *)         return 1 ;;
    esac
    for key in $candidates; do
        if jq -e --arg k "$key" '.scripts[$k]' "$pkg_path" > /dev/null 2>&1; then
            echo "$key"
            return 0
        fi
    done
    return 1
}

status_to_glyph() {
    case "$1" in
        ok)      printf '\033[32m✓\033[0m' ;;
        fail)    printf '\033[31m✗\033[0m' ;;
        running) printf '\033[33m…\033[0m' ;;
        skipped) printf '\033[90m-\033[0m' ;;
        *)       printf '\033[90m?\033[0m' ;;
    esac
}

# Exit 0 = skip (within TTL), exit 1 = must run.
should_skip_for_ttl() {
    local last=$1
    local now=$2
    local ttl=$3
    if [ -z "$last" ] || [ "$last" = "null" ] || [ "$last" = "0" ]; then
        return 1
    fi
    if [ $((last + ttl)) -gt "$now" ]; then
        return 0
    fi
    return 1
}

project_root_hash() {
    local root=$1
    if command -v shasum > /dev/null 2>&1; then
        printf '%s' "$root" | shasum -a 1 | awk '{print $1}'
    else
        printf '%s' "$root" | sha1sum | awk '{print $1}'
    fi
}

cache_file_path() {
    local root=$1
    printf '%s/%s.json\n' "$(statusline_cache_dir)" "$(project_root_hash "$root")"
}

lock_dir_path() {
    local root=$1
    printf '%s/%s.lockdir\n' "$(statusline_cache_dir)" "$(project_root_hash "$root")"
}
