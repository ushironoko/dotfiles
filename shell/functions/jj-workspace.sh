#!/usr/bin/env bash

# Jujutsu Workspace Management Functions
# gwq-compatible functions for jj workspace management
# These functions provide workspace management with fzf integration

# ============================================================================
# Configuration
# ============================================================================

# Workspaces are created as siblings of the main repo under ghq root

# ============================================================================
# Helper Functions
# ============================================================================

# Check if jj is available
_jwq_check_jj() {
  if ! command -v jj &>/dev/null; then
    echo "Error: jj is not installed" >&2
    return 1
  fi
}

# Check if in a jj repository
_jwq_check_repo() {
  if ! jj root &>/dev/null; then
    echo "Error: Not in a jj repository" >&2
    return 1
  fi
}

# Get the repository name from the current directory or path
_jwq_get_repo_name() {
  local path="${1:-$(pwd)}"
  basename "$(jj root 2>/dev/null || echo "$path")"
}

# ============================================================================
# JWQ-LIST - List all workspaces
# ============================================================================

jwq-list() {
  _jwq_check_jj || return 1

  local global=false
  local json_output=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -g|--global)
        global=true
        shift
        ;;
      --json)
        json_output=true
        shift
        ;;
      -h|--help)
        echo "Usage: jwq-list [-g|--global] [--json]"
        echo ""
        echo "Options:"
        echo "  -g, --global    Search all workspaces under ghq root"
        echo "  --json          Output in JSON format"
        return 0
        ;;
      *)
        echo "Unknown option: $1" >&2
        return 1
        ;;
    esac
  done

  if $global; then
    # Global search: ghq配下で .jj/repo がファイルのディレクトリ = workspace
    local ghq_root
    ghq_root=$(ghq root 2>/dev/null)
    if [[ -z "$ghq_root" ]]; then
      if $json_output; then
        echo "[]"
      fi
      return 0
    fi

    local workspaces=()
    while IFS= read -r repo_file; do
      local ws_dir
      ws_dir=$(dirname "$(dirname "$repo_file")")
      local name
      name=$(basename "$ws_dir")
      workspaces+=("$name|$ws_dir")
    done < <(find "$ghq_root" -maxdepth 5 -path '*/.jj/repo' -type f 2>/dev/null)

    if $json_output; then
      echo "["
      local first=true
      for ws in "${workspaces[@]}"; do
        local branch="${ws%%|*}"
        local path="${ws#*|}"
        if $first; then
          first=false
        else
          echo ","
        fi
        printf '  {"branch": "%s", "path": "%s"}' "$branch" "$path"
      done
      echo ""
      echo "]"
    else
      for ws in "${workspaces[@]}"; do
        local branch="${ws%%|*}"
        local path="${ws#*|}"
        echo "$branch → $path"
      done
    fi
  else
    # Local: list workspaces in current repository
    _jwq_check_repo || return 1
    jj workspace list
  fi
}

# ============================================================================
# JWQ-ADD - Create a new workspace
# ============================================================================

jwq-add() {
  _jwq_check_jj || return 1
  _jwq_check_repo || return 1

  local branch=""
  local ws_name=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -b|--branch)
        branch="$2"
        shift 2
        ;;
      -h|--help)
        echo "Usage: jwq-add [-b|--branch <branch-name>] [workspace-name]"
        echo ""
        echo "Options:"
        echo "  -b, --branch    Create a new bookmark/branch with the given name"
        echo ""
        echo "If workspace-name is not provided, the branch name is used."
        return 0
        ;;
      *)
        ws_name="$1"
        shift
        ;;
    esac
  done

  # Use branch name as workspace name if not specified
  if [[ -z "$ws_name" ]]; then
    if [[ -n "$branch" ]]; then
      ws_name="$branch"
    else
      echo "Error: Please specify a workspace name or branch name (-b)" >&2
      return 1
    fi
  fi

  # Sanitize workspace name for directory
  local safe_name="${ws_name//\//-}"

  # Create workspace directory as sibling of current repo under ghq
  local repo_root
  repo_root=$(jj root 2>/dev/null || pwd)
  local repo_parent
  repo_parent=$(dirname "$repo_root")
  local repo_name
  repo_name=$(basename "$repo_root")
  local ws_path="$repo_parent/${repo_name}-${safe_name}"

  # Create the workspace
  echo "Creating workspace: $ws_name at $ws_path"
  if ! jj workspace add "$ws_path" --name "$safe_name"; then
    echo "Error: Failed to create workspace" >&2
    return 1
  fi

  # Create a new bookmark/branch if specified
  if [[ -n "$branch" ]]; then
    echo "Creating bookmark: $branch"
    (cd "$ws_path" && jj bookmark create "$branch" 2>/dev/null || jj bookmark set "$branch")
  fi

  # Enable colocation for git compatibility
  echo "Enabling git colocation..."
  (cd "$ws_path" && jj git init --colocate 2>/dev/null || true)

  echo ""
  echo "Workspace created (colocated): $ws_path"
  echo ""
  echo "To navigate to the workspace:"
  echo "  cd \$(jwq-get $safe_name)"
}

# ============================================================================
# JWQ-GET - Get workspace path
# ============================================================================

jwq-get() {
  _jwq_check_jj || return 1

  local ws_name="$1"

  if [[ -z "$ws_name" ]]; then
    # Interactive selection with fzf
    if ! command -v fzf &>/dev/null; then
      echo "Error: Please specify a workspace name or install fzf for interactive selection" >&2
      return 1
    fi

    local selected
    selected=$(jwq-list -g 2>/dev/null | fzf --height 40% --reverse --prompt "Workspace > ")
    [[ -z "$selected" ]] && return 1
    # Extract path from "branch → path" format
    ws_name="${selected#*→ }"
    echo "$ws_name"
    return 0
  fi

  # Search as sibling of current repo under ghq
  local repo_root
  repo_root=$(jj root 2>/dev/null || pwd)
  local repo_parent
  repo_parent=$(dirname "$repo_root")
  local repo_name
  repo_name=$(basename "$repo_root")

  # Try exact match: repo-name
  local ws_path="$repo_parent/${repo_name}-${ws_name}"
  if [[ -d "$ws_path/.jj" ]]; then
    echo "$ws_path"
    return 0
  fi

  # Try sanitized name: repo-sanitized
  local safe_name="${ws_name//\//-}"
  ws_path="$repo_parent/${repo_name}-${safe_name}"
  if [[ -d "$ws_path/.jj" ]]; then
    echo "$ws_path"
    return 0
  fi

  # Search globally under ghq root
  local ghq_root
  ghq_root=$(ghq root 2>/dev/null)
  if [[ -n "$ghq_root" ]]; then
    while IFS= read -r repo_file; do
      local dir
      dir=$(dirname "$(dirname "$repo_file")")
      local dir_name
      dir_name=$(basename "$dir")
      if [[ "$dir_name" == "$ws_name" || "$dir_name" == "$safe_name" || "$dir_name" == *"-${ws_name}" || "$dir_name" == *"-${safe_name}" ]]; then
        echo "$dir"
        return 0
      fi
    done < <(find "$ghq_root" -maxdepth 5 -path '*/.jj/repo' -type f 2>/dev/null)
  fi

  echo "Error: Workspace not found: $ws_name" >&2
  return 1
}

# ============================================================================
# JWQ-EXEC - Execute command in workspace
# ============================================================================

jwq-exec() {
  _jwq_check_jj || return 1

  local ws_name=""
  local cmd=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        echo "Usage: jwq-exec <workspace-name> -- <command...>"
        echo ""
        echo "Execute a command in the specified workspace directory."
        return 0
        ;;
      --)
        shift
        cmd=("$@")
        break
        ;;
      *)
        if [[ -z "$ws_name" ]]; then
          ws_name="$1"
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$ws_name" ]]; then
    echo "Error: Please specify a workspace name" >&2
    return 1
  fi

  if [[ ${#cmd[@]} -eq 0 ]]; then
    echo "Error: Please specify a command after --" >&2
    return 1
  fi

  local ws_path
  ws_path=$(jwq-get "$ws_name")
  if [[ $? -ne 0 ]]; then
    return 1
  fi

  echo "Executing in $ws_path: ${cmd[*]}"
  (cd "$ws_path" && "${cmd[@]}")
}

# ============================================================================
# JWQ-REMOVE - Remove a workspace
# ============================================================================

jwq-remove() {
  _jwq_check_jj || return 1

  local ws_name=""
  local remove_branch=false
  local force=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -b|--branch)
        remove_branch=true
        shift
        ;;
      -f|--force)
        force=true
        shift
        ;;
      -h|--help)
        echo "Usage: jwq-remove [-b|--branch] [-f|--force] <workspace-name>"
        echo ""
        echo "Options:"
        echo "  -b, --branch    Also delete the associated bookmark"
        echo "  -f, --force     Force removal even with uncommitted changes"
        return 0
        ;;
      *)
        ws_name="$1"
        shift
        ;;
    esac
  done

  if [[ -z "$ws_name" ]]; then
    # Interactive selection with fzf
    if ! command -v fzf &>/dev/null; then
      echo "Error: Please specify a workspace name or install fzf for interactive selection" >&2
      return 1
    fi

    local selected
    selected=$(jwq-list -g 2>/dev/null | fzf --height 40% --reverse --prompt "Remove workspace > ")
    [[ -z "$selected" ]] && return 1
    ws_name="${selected%%→*}"
    ws_name="${ws_name% }"
  fi

  local ws_path
  ws_path=$(jwq-get "$ws_name" 2>/dev/null)
  if [[ $? -ne 0 || -z "$ws_path" ]]; then
    echo "Error: Workspace not found: $ws_name" >&2
    return 1
  fi

  # Check for uncommitted changes
  if ! $force; then
    local status
    status=$(cd "$ws_path" && jj status 2>/dev/null)
    if [[ -n "$status" ]] && ! echo "$status" | grep -q "The working copy is clean"; then
      echo "Warning: Workspace has uncommitted changes:"
      echo "$status"
      echo ""
      echo "Use -f to force removal."
      return 1
    fi
  fi

  # Get the workspace's sanitized name for jj
  local safe_name
  safe_name=$(basename "$ws_path")

  # Forget the workspace from jj (must be done from main repo)
  local main_repo
  main_repo=$(jj root 2>/dev/null)
  if [[ -n "$main_repo" && "$main_repo" != "$ws_path" ]]; then
    echo "Forgetting workspace from jj..."
    (cd "$main_repo" && jj workspace forget "$safe_name" 2>/dev/null || true)
  fi

  # Remove the directory
  echo "Removing workspace directory: $ws_path"
  rm -rf "$ws_path"

  # Remove bookmark if requested
  if $remove_branch && [[ -n "$main_repo" ]]; then
    echo "Deleting bookmark: $ws_name"
    (cd "$main_repo" && jj bookmark delete "$ws_name" 2>/dev/null || true)
  fi

  echo "Workspace removed: $ws_name"
}

# ============================================================================
# JWQ-STATUS - Show status of all workspaces
# ============================================================================

jwq-status() {
  _jwq_check_jj || return 1

  local global=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -g|--global)
        global=true
        shift
        ;;
      -h|--help)
        echo "Usage: jwq-status [-g|--global]"
        echo ""
        echo "Options:"
        echo "  -g, --global    Show status of all workspaces under ghq root"
        return 0
        ;;
      *)
        echo "Unknown option: $1" >&2
        return 1
        ;;
    esac
  done

  if $global; then
    local ghq_root
    ghq_root=$(ghq root 2>/dev/null)
    if [[ -z "$ghq_root" ]]; then
      echo "No ghq root found"
      return 0
    fi

    local found=false
    while IFS= read -r repo_file; do
      local ws_dir
      ws_dir=$(dirname "$(dirname "$repo_file")")
      found=true
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo "📁 $ws_dir"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      (cd "$ws_dir" && jj status 2>/dev/null)
      echo ""
    done < <(find "$ghq_root" -maxdepth 5 -path '*/.jj/repo' -type f 2>/dev/null)

    if ! $found; then
      echo "No workspaces found"
    fi
  else
    _jwq_check_repo || return 1

    echo "Current repository workspaces:"
    jj workspace list
    echo ""
    echo "Workspace status:"
    jj status
  fi
}

# ============================================================================
# Export functions based on shell
# ============================================================================

if [[ -n "$BASH_VERSION" ]]; then
  export -f jwq-list
  export -f jwq-add
  export -f jwq-get
  export -f jwq-exec
  export -f jwq-remove
  export -f jwq-status
  export -f _jwq_check_jj
  export -f _jwq_check_repo
  export -f _jwq_get_repo_name
elif [[ -n "$ZSH_VERSION" ]]; then
  :
fi
