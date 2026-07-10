#!/usr/bin/env bash
# Shared helpers for Codex background statusline checks and compatible renderers.

statusline_now() {
  if [ -n "${STATUSLINE_NOW_OVERRIDE:-}" ]; then
    echo "$STATUSLINE_NOW_OVERRIDE"
  else
    date +%s
  fi
}

statusline_ttl() {
  case "$1" in
    lint) echo "${STATUSLINE_TTL_LINT:-30}" ;;
    typecheck) echo "${STATUSLINE_TTL_TYPECHECK:-30}" ;;
    test) echo "${STATUSLINE_TTL_TEST:-300}" ;;
    *) echo 0 ;;
  esac
}

statusline_check_timeout() {
  case "$1" in
    lint|typecheck) echo 60 ;;
    test) echo 300 ;;
    *) echo 60 ;;
  esac
}

# Share the cache with the existing renderer during the compatibility period.
statusline_cache_dir() {
  echo "${STATUSLINE_CACHE_DIR:-${TMPDIR:-/tmp}/claude-statusline-checks}"
}

find_project_root() {
  local dir=$1 parent
  [ -n "$dir" ] || return 1
  while :; do
    if [ -f "$dir/Cargo.toml" ] || [ -f "$dir/moon.mod.json" ]; then
      echo "$dir"
      return 0
    fi
    if [ -f "$dir/package.json" ] \
      && { [ -f "$dir/tsconfig.json" ] || [ -f "$dir/pnpm-lock.yaml" ] || [ -f "$dir/bun.lock" ] || [ -f "$dir/bun.lockb" ]; }; then
      echo "$dir"
      return 0
    fi
    [ "$dir" = "/" ] && break
    parent=$(dirname "$dir")
    [ "$parent" = "$dir" ] && break
    dir=$parent
  done
  return 1
}

detect_project_type() {
  local root=$1
  if [ -f "$root/Cargo.toml" ]; then
    echo rust
  elif [ -f "$root/moon.mod.json" ]; then
    echo moonbit
  elif [ -f "$root/package.json" ] \
    && { [ -f "$root/tsconfig.json" ] || [ -f "$root/pnpm-lock.yaml" ] || [ -f "$root/bun.lock" ] || [ -f "$root/bun.lockb" ]; }; then
    echo ts
  fi
}

project_label() {
  case "$1" in
    rust) echo RS ;;
    moonbit) echo MB ;;
    ts) echo TS ;;
  esac
}

detect_package_manager() {
  local root=$1
  if [ -f "$root/pnpm-lock.yaml" ]; then
    echo pnpm
  elif [ -f "$root/bun.lock" ] || [ -f "$root/bun.lockb" ]; then
    echo bun
  fi
}

resolve_script_key() {
  local slot=$1 pkg=$2 candidates key
  [ -f "$pkg" ] || return 1
  case "$slot" in
    lint) candidates="lint" ;;
    typecheck) candidates="typecheck tsc check" ;;
    test) candidates="test" ;;
    *) return 1 ;;
  esac
  for key in $candidates; do
    if jq -e --arg key "$key" '.scripts[$key] | type == "string"' "$pkg" >/dev/null 2>&1; then
      echo "$key"
      return 0
    fi
  done
  return 1
}

should_skip_for_ttl() {
  local last=$1 now=$2 ttl=$3
  [ -n "$last" ] && [ "$last" != null ] && [ "$last" != 0 ] || return 1
  [ $((last + ttl)) -gt "$now" ]
}

project_root_hash() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 1 | awk '{print $1}'
  else
    printf '%s' "$1" | sha1sum | awk '{print $1}'
  fi
}

cache_file_path() {
  printf '%s/%s.json\n' "$(statusline_cache_dir)" "$(project_root_hash "$1")"
}

lock_dir_path() {
  printf '%s/%s.lockdir\n' "$(statusline_cache_dir)" "$(project_root_hash "$1")"
}
