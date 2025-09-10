#!/usr/bin/env bash

# Interactive Shell Functions
# Collection of fzf-based interactive functions for bash and zsh
# These functions provide enhanced navigation and repository management

# ============================================================================
# FCD - Fuzzy Change Directory
# Interactive directory navigation using fzf
# ============================================================================

fcd() {
  local current_path="${1:-$(pwd)}"
  
  while true; do
    # Build the directory list as a string
    local dirs_string=""
    
    # Add control options
    dirs_string="cd\n"
    
    # Add parent directory if not at root
    if [[ "$current_path" != "/" ]]; then
      dirs_string="${dirs_string}../\n"
    fi
    
    # Add subdirectories
    if [[ -d "$current_path" ]]; then
      # Use find for compatibility with both shells
      while IFS= read -r dir; do
        local basename="${dir##*/}"
        dirs_string="${dirs_string}${basename}/\n"
      done < <(find "$current_path" -maxdepth 1 -type d ! -path "$current_path" 2>/dev/null | sort)
    fi
    
    # Setup preview command
    local preview_cmd='
      selected={}
      current_path="'"$current_path"'"
      if [[ "$selected" == "cd" ]]; then
        echo "📁 Current: $current_path"
        echo ""
        echo "Press ENTER to change to this directory"
      elif [[ "$selected" == "../" ]]; then
        parent="$(dirname "$current_path")"
        echo "📁 Parent: $parent"
        echo ""
        ls -la "$parent" 2>/dev/null | head -20
      else
        target="$current_path/${selected%/}"
        if [[ -d "$target" ]]; then
          echo "📁 Directory: $target"
          echo ""
          ls -la "$target" 2>/dev/null | head -20
        fi
      fi
    '
    
    # Show fzf selector with fresh instance
    local selected
    selected=$(echo -e "$dirs_string" | sed '/^$/d' | fzf \
      --height 80% \
      --reverse \
      --layout=reverse-list \
      --header "$current_path" \
      --preview "$preview_cmd" \
      --preview-window "down,40%,wrap" \
      --bind "esc:abort" \
      --bind "ctrl-/:toggle-preview" \
      --bind "ctrl-l:clear-query" \
      --prompt "Search/Navigate > " \
      --ansi \
      --info=inline \
      --cycle \
      --marker "▶" \
      --pointer "▶" \
      --algo=v2
      )
    
    # Handle selection
    if [[ -z "$selected" ]]; then
      # Cancelled
      return 0
    elif [[ "$selected" == "cd" ]]; then
      # Change to the current virtual path
      cd "$current_path" || return 1
      echo "cd: $current_path"
      return 0
    elif [[ "$selected" == "../" ]]; then
      # Navigate to parent
      current_path=$(dirname "$current_path")
    else
      # Navigate to subdirectory
      current_path="$current_path/${selected%/}"
      # Resolve symlinks and normalize path
      current_path=$(cd "$current_path" 2>/dev/null && pwd || echo "$current_path")
    fi
  done
}

# ============================================================================
# GHQ/FZF Functions
# Repository management with ghq and fzf
# ============================================================================

# List all repositories
gls() { 
  ghq list
}

# Change directory to repository (interactive)
gcd() { 
  local r=$(ghq list | grep github.com | fzf --height 40% --reverse)
  [ -n "$r" ] && cd "$(ghq root)/$r"
}

# Open repository in VS Code (interactive)
ghcode() { 
  local r=$(ghq list | fzf --height 40% --reverse)
  [ -n "$r" ] && code "$(ghq root)/$r"
}

# Clone repository (no args: your repos, with args: any repo)
gget() { 
  [ $# -eq 0 ] && ghq get "https://github.com/$(gh repo list --limit 1000 --json nameWithOwner --jq '.[].nameWithOwner' | fzf --height 40% --reverse --preview "gh repo view {}")" || ghq get "$@"
}

# Search and clone from GitHub
gget-search() { 
  [ $# -eq 0 ] && echo "Usage: gget-search <query>" && return 1
  local r=$(gh search repos "$*" --limit 30 --json fullName,description,stargazersCount | jq -r '.[] | [.fullName, .description // ""] | @tsv' | column -t -s $'\t' | fzf --height 40% --reverse --with-nth 1,2 | awk '{print $1}')
  [ -n "$r" ] && ghq get "https://github.com/$r"
}

# Create new GitHub repo and clone
ghnew() { 
  [ $# -eq 0 ] && echo "Usage: ghnew <name> [--public|--private]" && return 1
  gh repo create "$@" && ghq get "https://github.com/$(gh api user --jq .login)/$1" && cd "$(ghq root)/github.com/$(gh api user --jq .login)/$1"
}

# Remove repository (interactive)
grm() { 
  local r=$(ghq list | fzf --height 40% --reverse)
  [ -n "$r" ] && echo "Remove $(ghq root)/$r? [y/N]" && read -r a && [ "$a" = "y" ] && rm -rf "$(ghq root)/$r" && echo "Removed"
}

# Git branch cleanup with safety checks
gclean() {
  # Fetch latest remote state
  git fetch --prune
  
  # Get current branch
  local current_branch=$(git branch --show-current)
  
  # Get all local branches that don't exist on remote
  local branches=$(git branch -vv | grep ': gone]' | awk '{print $1}' | grep -v "^*")
  
  if [ -z "$branches" ]; then
    echo "No branches to clean up"
    return 0
  fi
  
  # Filter out branches with unmerged commits
  local safe_branches=""
  for branch in $branches; do
    if git cherry main "$branch" | grep -q "^+"; then
      echo "Skipping $branch (has unmerged commits)"
    else
      safe_branches="$safe_branches$branch\n"
    fi
  done
  
  if [ -z "$safe_branches" ]; then
    echo "No safe branches to clean up"
    return 0
  fi
  
  # Use fzf for selection (multi-select enabled)
  local selected=$(echo -e "$safe_branches" | fzf --multi --height 40% --reverse \
    --header "Select branches to delete (TAB to select multiple, ENTER to confirm)")
  
  if [ -z "$selected" ]; then
    echo "No branches selected"
    return 0
  fi
  
  # Confirmation
  echo "Will delete the following branches:"
  echo "$selected"
  echo -n "Continue? [y/N]: "
  read -r confirm
  
  if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
    echo "$selected" | xargs -r git branch -d
    echo "Branches deleted successfully"
  else
    echo "Cancelled"
  fi
}

# Show ghq commands help
ghq-help() {
  echo "ghq/fzf commands:"
  echo "  gls         - List all repositories"
  echo "  gcd         - Change directory to GitHub repository (interactive)"
  echo "  ghcode      - Open repository in VS Code (interactive)"
  echo "  gget        - Clone repository (no args: your repos, with args: any repo)"
  echo "  gget-search - Search and clone from GitHub"
  echo "  ghnew       - Create new GitHub repo and clone"
  echo "  grm         - Remove repository (interactive)"
  echo "  gclean      - Clean up local branches not on remote (interactive)"
  echo "  fcd         - Interactive directory navigation with fzf"
  echo ""
  echo "Use 'type <command>' to see the function definition"
}

# ============================================================================
# Export functions based on shell
# ============================================================================

if [[ -n "$BASH_VERSION" ]]; then
  # Running in bash - export functions
  export -f fcd
  export -f gls
  export -f gcd
  export -f ghcd
  export -f ghcode
  export -f gget
  export -f gget-search
  export -f ghnew
  export -f grm
  export -f gclean
  export -f ghq-help
elif [[ -n "$ZSH_VERSION" ]]; then
  # Running in zsh - no need to export
  :
fi