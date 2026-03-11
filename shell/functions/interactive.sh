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
    
    # Add subdirectories and symlinks
    if [[ -d "$current_path" ]]; then
      # Use find for compatibility with both shells
      # Include both directories and symlinks that point to directories
      while IFS= read -r item; do
        local basename="${item##*/}"
        # Check if it's a symlink that points to a directory
        if [[ -L "$item" ]]; then
          # Check if the symlink points to a directory
          if [[ -d "$item" ]]; then
            # Add symlink marker
            dirs_string="${dirs_string}${basename}/ →\n"
          fi
        elif [[ -d "$item" ]]; then
          # Regular directory
          dirs_string="${dirs_string}${basename}/\n"
        fi
      done < <(find "$current_path" -maxdepth 1 \( -type d -o -type l \) ! -path "$current_path" 2>/dev/null | sort)
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
        # Remove symlink marker if present
        selected_clean="${selected% →}"
        target="$current_path/${selected_clean%/}"
        if [[ -L "$target" ]]; then
          # Handle symlink
          echo "🔗 Symlink: $target"
          real_path=$(readlink -f "$target" 2>/dev/null)
          if [[ -n "$real_path" ]]; then
            echo "→ Target: $real_path"
            if [[ -d "$real_path" ]]; then
              echo ""
              ls -la "$real_path" 2>/dev/null | head -20
            else
              echo "(Target is not accessible or not a directory)"
            fi
          else
            echo "(Broken symlink)"
          fi
        elif [[ -d "$target" ]]; then
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
      # Navigate to subdirectory (remove symlink marker if present)
      selected_clean="${selected% →}"
      current_path="$current_path/${selected_clean%/}"
      # Resolve symlinks and normalize path
      current_path=$(cd "$current_path" 2>/dev/null && pwd || echo "$current_path")
    fi
  done
}

# ============================================================================
# GHQ/FZF Functions
# Repository management with ghq and fzf
# ============================================================================

# 選択履歴ファイル
GHQ_SELECT_HISTFILE="$HOME/.cache/.ghq_fzf_history"

# ファイル内容を逆順出力（履歴の新しい順表示に使用）
revcat() {
  if command -v tac >/dev/null 2>&1; then
    tac "$@"
  elif tail -r /dev/null >/dev/null 2>&1; then
    tail -r "$@"
  else
    awk '{ buf[NR]=$0 } END { for (i=NR;i>0;i--) print buf[i] }' "$@"
  fi
}

# List all repositories
gls() { 
  ghq list
}

# Change directory to repository or jj workspace (interactive)
# -f オプションで頻度順表示（デフォルトは最近使った順）
gcd() {
  # zshのジョブ制御通知を抑制（関数スコープのみ）
  [[ -n "$ZSH_VERSION" ]] && setopt local_options no_monitor no_notify

  local frequency_mode=false
  if [[ "$1" == "-f" ]]; then
    frequency_mode=true
    shift
  fi

  local tmp_dir=$(mktemp -d)
  local ghq_root=$(ghq root)
  local histfile="$GHQ_SELECT_HISTFILE"

  local _gcd_pids=()

  # 全ソースを並列で収集（findベースで高速化: ghq list/gwq listはVCSチェックで遅い）
  find "$ghq_root" -maxdepth 4 \( -name '.git' -type d -o -name '.jj' -type d \) 2>/dev/null \
    | sed "s|$ghq_root/||;s|/\.git$||;s|/\.jj$||" | grep github.com | sort -u > "$tmp_dir/ghq" &
  _gcd_pids+=($!)

  # jj workspace検索（ghq配下で .jj/repo がファイル = workspace）
  {
    if command -v jj &>/dev/null; then
      find "$ghq_root" -maxdepth 5 -path '*/.jj/repo' -type f 2>/dev/null | while IFS= read -r repo_file; do
        local ws_dir=$(dirname "$(dirname "$repo_file")")
        echo "$(basename "$ws_dir")|$ws_dir|${ws_dir#$ghq_root/}"
      done
    fi
  } > "$tmp_dir/jwq_raw" 2>/dev/null &
  _gcd_pids+=($!)

  # git worktree一覧（findベースで高速化: gwq list -gは内部git操作で遅い）
  {
    local gwq_basedir="${GWQ_BASEDIR:-$(command -v gwq &>/dev/null && gwq config get worktree.basedir 2>/dev/null | sed "s|^~|$HOME|")}"
    if [[ -d "$gwq_basedir" ]]; then
      find "$gwq_basedir" -maxdepth 5 -name '.git' -type f 2>/dev/null | while IFS= read -r git_file; do
        local dir=$(dirname "$git_file")
        local gitdir=$(sed 's/gitdir: //' "$git_file")
        if [[ -f "$gitdir/HEAD" ]]; then
          local ref=$(cat "$gitdir/HEAD")
          echo "⎇ ${ref#ref: refs/heads/} → $dir"
        else
          echo "⎇ $(basename "$dir") → $dir"
        fi
      done
    fi
  } > "$tmp_dir/gwq" 2>/dev/null &
  _gcd_pids+=($!)

  wait "${_gcd_pids[@]}"

  # jj workspace処理: 表示用エントリ作成 + ghq listから重複除外
  if [[ -s "$tmp_dir/jwq_raw" ]]; then
    # 表示用エントリと相対パスを分離
    while IFS='|' read -r name abs_path rel_path; do
      echo "⟳ $name → $abs_path" >> "$tmp_dir/jwq"
      echo "$rel_path" >> "$tmp_dir/jwq_rel"
    done < "$tmp_dir/jwq_raw"
    # ghq listからworkspaceエントリを除外
    grep -v -x -F -f "$tmp_dir/jwq_rel" "$tmp_dir/ghq" > "$tmp_dir/ghq_filtered" 2>/dev/null || cp "$tmp_dir/ghq" "$tmp_dir/ghq_filtered"
  else
    cp "$tmp_dir/ghq" "$tmp_dir/ghq_filtered"
  fi

  # ghqエントリを履歴順に並べ替え
  if [[ -f "$histfile" ]]; then
    if [[ "$frequency_mode" == true ]]; then
      # 頻度順（使用回数の多い順）
      (sort "$histfile" | uniq -c | sort -nr | awk '{print $2}'; cat "$tmp_dir/ghq_filtered") | awk '!seen[$0]++' > "$tmp_dir/ghq_sorted"
    else
      # 最近使った順（デフォルト）
      (revcat "$histfile"; cat "$tmp_dir/ghq_filtered") | awk '!seen[$0]++' > "$tmp_dir/ghq_sorted"
    fi
  else
    cp "$tmp_dir/ghq_filtered" "$tmp_dir/ghq_sorted"
  fi

  # 結合: workspace → repos (履歴順) → worktrees
  local combined
  combined=$(cat "$tmp_dir/jwq" "$tmp_dir/ghq_sorted" "$tmp_dir/gwq" 2>/dev/null | sed '/^$/d')
  rm -rf "$tmp_dir"

  [[ -z "$combined" ]] && return

  # fzfヘッダ
  local header="ghq repositories"
  if [[ "$frequency_mode" == true ]]; then
    header="$header (frequency order)"
  else
    header="$header (recent order)"
  fi

  # READMEプレビュー
  local preview_cmd='
    selected={}
    ghq_root="'"$ghq_root"'"
    if [[ "$selected" == ⟳* ]] || [[ "$selected" == ⎇* ]]; then
      dir=$(echo "$selected" | sed "s/.*→ //")
      head -n200 "$dir/README.md" 2>/dev/null || echo "No README.md"
    else
      head -n200 "${ghq_root}/${selected}/README.md" 2>/dev/null || echo "No README.md"
    fi
  '

  local selected=$(echo "$combined" | fzf \
    --height 40% \
    --reverse \
    --header "$header" \
    --preview "$preview_cmd" \
    --preview-window "right:40%")
  [[ -z "$selected" ]] && return

  if [[ "$selected" == ⟳* ]] || [[ "$selected" == ⎇* ]]; then
    # jj workspace or git worktree: パスを抽出して移動
    cd "$(echo "$selected" | sed 's/.*→ //')"
  else
    # ghq repository: 履歴に追記して移動
    mkdir -p "$(dirname "$histfile")"
    echo "$selected" >> "$histfile"
    cd "$ghq_root/$selected"
  fi
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
  local r=$(gh search repos "$*" --limit 30 --json fullName,description,stargazersCount | jq -r '.[] | .fullName' | fzf --height 40% --reverse --preview "gh repo view {}")
  [ -n "$r" ] && ghq get "https://github.com/$r"
}

# Create new GitHub repo and clone
ghnew() { 
  [ $# -eq 0 ] && echo "Usage: ghnew <name> [--public|--private]" && return 1
  gh repo create "$@" && ghq get "https://github.com/$(gh api user --jq .login)/$1" && cd "$(ghq root)/github.com/$(gh api user --jq .login)/$1"
}

# Remove repository (interactive, multi-select, oldest first)
grm() {
  local ghq_root
  ghq_root=$(ghq root | head -n1) || return

  local selected
  selected=$(
    ghq list -p | while IFS= read -r d; do
      local mtime
      if stat --version >/dev/null 2>&1; then
        # GNU stat
        mtime=$(date -d "@$(stat -c %Y "$d")" +%Y-%m-%d 2>/dev/null)
      else
        # BSD stat (macOS)
        mtime=$(date -r "$(stat -f %m "$d")" +%Y-%m-%d 2>/dev/null)
      fi
      printf '%s\t%s\n' "${mtime:-unknown}" "${d#$ghq_root/}"
    done | sort | fzf --multi --height 40% --reverse \
      --header "Select repositories to remove (oldest first, TAB to multi-select)" | cut -f2
  ) || return

  if [[ -z "$selected" ]]; then
    echo "No repositories selected."
    return
  fi

  echo "Removing:"
  echo "$selected" | sed 's/^/  /'
  echo ""
  echo -n "Are you sure? (y/N) "
  read -r reply
  [[ ! "$reply" =~ ^[yY]$ ]] && return

  local histfile="$GHQ_SELECT_HISTFILE"

  echo "$selected" | while IFS= read -r r; do
    rm -rf "${ghq_root}/${r}"
    if [[ -f "$histfile" ]]; then
      grep -v "^${r}$" "$histfile" > "${histfile}.tmp" && mv "${histfile}.tmp" "$histfile"
    fi
    echo "Removed ${r}"
  done
}

# Git branch cleanup with safety checks
gclean() {
  local ghq_root=$(ghq root)
  local items=""

  # 1. Gone branches (current repo)
  git fetch --prune
  local branches=$(git branch -vv | grep ': gone]' | awk '{print $1}' | grep -v "^*")
  for branch in $branches; do
    items="${items}[branch] ${branch}\n"
  done

  # 2. jj workspaces (ghq配下, .jj/repo がファイル = non-main workspace)
  if command -v jj &>/dev/null; then
    while IFS= read -r repo_file; do
      local ws_dir=$(dirname "$(dirname "$repo_file")")
      items="${items}[jj-ws] $(basename "$ws_dir") → ${ws_dir}\n"
    done < <(find "$ghq_root" -maxdepth 5 -path '*/.jj/repo' -type f 2>/dev/null)
  fi

  # 3. git worktrees (non-main)
  if command -v gwq &>/dev/null; then
    while IFS= read -r line; do
      [ -n "$line" ] && items="${items}[worktree] ${line}\n"
    done < <(gwq list -g --json 2>/dev/null | jq -r '.[] | select(.is_main == false) | "\(.branch) → \(.path)"' 2>/dev/null)
  fi

  items=$(echo -e "$items" | sed '/^$/d')

  if [ -z "$items" ]; then
    echo "Nothing to clean up"
    return 0
  fi

  # Use fzf for selection (multi-select enabled)
  local selected=$(echo "$items" | fzf --multi --height 40% --reverse \
    --header "Select items to delete (TAB to select, ENTER to confirm)")

  if [ -z "$selected" ]; then
    echo "No items selected"
    return 0
  fi

  # Confirmation
  echo "Will delete:"
  echo "$selected"
  echo -n "Continue? [y/N]: "
  read -r confirm

  if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
    echo "$selected" | while IFS= read -r item; do
      case "$item" in
        \[branch\]*)
          local name="${item#\[branch\] }"
          git branch -D "$name" && echo "Deleted branch: $name"
          ;;
        \[jj-ws\]*)
          local target="${item#*→ }"
          rm -rf "$target" && echo "Removed jj workspace: $target"
          ;;
        \[worktree\]*)
          local target="${item#*→ }"
          git worktree remove --force "$target" && echo "Removed worktree: $target"
          ;;
      esac
    done
  else
    echo "Cancelled"
  fi
}

# Git switch to remote branch with fzf
gsw() {
  # Fetch latest remote branches
  git fetch --prune

  # Get all remote branches (excluding HEAD)
  # Remove 'origin/' prefix and trim whitespace
  local branches=$(git branch -r | grep -v HEAD | sed 's/^[[:space:]]*//' | sed 's/origin\///' | sort -u)

  if [ -z "$branches" ]; then
    echo "No remote branches found"
    return 1
  fi

  # Get current branch
  local current_branch=$(git branch --show-current)

  # Setup preview command
  local preview_cmd='
    branch={}
    # Trim any whitespace
    branch=$(echo "$branch" | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")

    echo "🌿 Branch: $branch"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    # Show last 5 commits
    git log --oneline --graph --decorate "origin/$branch" -n 5 2>/dev/null

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Show branch info
    git log -1 --pretty=format:"Author: %an <%ae>%nDate:   %ad%nCommit: %H%n%nMessage:%n%s%n%b" "origin/$branch" 2>/dev/null
  '

  # Show fzf selector
  local selected=$(echo "$branches" | fzf \
    --height 80% \
    --reverse \
    --layout=reverse-list \
    --header "Select branch to switch (current: $current_branch)" \
    --preview "$preview_cmd" \
    --preview-window "down,60%,wrap" \
    --bind "esc:abort" \
    --bind "ctrl-/:toggle-preview" \
    --prompt "Branch > " \
    --ansi \
    --info=inline \
    --cycle \
    --marker "▶" \
    --pointer "▶"
  )

  # Handle selection
  if [ -z "$selected" ]; then
    echo "No branch selected"
    return 0
  fi

  # Clean up branch name - remove all whitespace
  selected=$(echo "$selected" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

  # Debug output
  echo "Selected branch: '$selected'"

  # Check if branch exists locally
  if git show-ref --verify --quiet "refs/heads/$selected"; then
    # Branch exists locally, just switch
    echo "Switching to existing local branch: $selected"
    git switch "$selected"
  else
    # Create and switch to new branch tracking the remote
    echo "Creating and switching to new branch: $selected (tracking origin/$selected)"
    git switch -c "$selected" "origin/$selected"
  fi
}

# Show ghq commands help
ghq-help() {
  echo "ghq/fzf commands:"
  echo "  gls         - List all repositories"
  echo "  gcd         - Change directory to GitHub repository (interactive, -f for frequency order)"
  echo "  ghcode      - Open repository in VS Code (interactive)"
  echo "  gget        - Clone repository (no args: your repos, with args: any repo)"
  echo "  gget-search - Search and clone from GitHub"
  echo "  ghnew       - Create new GitHub repo and clone"
  echo "  grm         - Remove repository (multi-select, oldest first)"
  echo "  gclean      - Clean up gone branches, jj workspaces, git worktrees (interactive)"
  echo "  gsw         - Switch to remote branch with fzf (interactive)"
  echo "  fcd         - Interactive directory navigation with fzf"
  echo "  ns          - Run package.json scripts with fzf (interactive)"
  echo ""
  echo "Use 'type <command>' to see the function definition"
}

# ============================================================================
# NS - NPM Package Scripts Runner
# Interactive package.json scripts execution using fzf
# ============================================================================

ns() {
  # Find package.json in current or parent directories
  local pkg_dir="$PWD"
  local pkg_json=""

  while [[ "$pkg_dir" != "/" ]]; do
    if [[ -f "$pkg_dir/package.json" ]]; then
      pkg_json="$pkg_dir/package.json"
      break
    fi
    pkg_dir=$(dirname "$pkg_dir")
  done

  if [[ -z "$pkg_json" ]]; then
    echo "Error: No package.json found in current or parent directories"
    return 1
  fi

  # Extract scripts from package.json (using | as separator to avoid conflicts with scripts like test:unit)
  local scripts=$(jq -r '.scripts | to_entries | .[] | "\(.key)|\(.value)"' "$pkg_json" 2>/dev/null)

  if [[ -z "$scripts" ]]; then
    echo "Error: No scripts found in package.json"
    return 1
  fi

  # Detect package manager
  local pkg_manager="npm"
  local pkg_dir_base=$(dirname "$pkg_json")

  if [[ -f "$pkg_dir_base/pnpm-lock.yaml" ]]; then
    pkg_manager="pnpm"
  elif [[ -f "$pkg_dir_base/bun.lockb" ]] || [[ -f "$pkg_dir_base/bun.lock" ]]; then
    pkg_manager="bun"
  elif [[ -f "$pkg_dir_base/yarn.lock" ]]; then
    pkg_manager="yarn"
  elif [[ -f "$pkg_dir_base/package-lock.json" ]]; then
    pkg_manager="npm"
  fi

  # Setup preview command
  local preview_cmd='
    script_line={}
    script_name="${script_line%%|*}"
    script_cmd="${script_line#*|}"
    pkg_manager="'"$pkg_manager"'"
    pkg_dir="'"$pkg_dir_base"'"

    echo "📦 Package Manager: $pkg_manager"
    echo "📁 Directory: $pkg_dir"
    echo ""
    echo "🚀 Script: $script_name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$script_cmd"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Will execute: $pkg_manager run $script_name"
  '

  # Show fzf selector
  local selected
  selected=$(echo "$scripts" | fzf \
    --height 60% \
    --reverse \
    --layout=reverse-list \
    --header "Select script to run (in: $pkg_dir_base)" \
    --preview "$preview_cmd" \
    --preview-window "down,50%,wrap" \
    --bind "esc:abort" \
    --bind "ctrl-/:toggle-preview" \
    --prompt "Script > " \
    --ansi \
    --info=inline \
    --cycle \
    --marker "▶" \
    --pointer "▶"
  )

  # Handle selection
  if [[ -z "$selected" ]]; then
    return 0
  fi

  # Extract script name (using | separator)
  local script_name="${selected%%|*}"

  # Change to package.json directory and run the script
  (
    cd "$pkg_dir_base" || return 1
    echo "🚀 Running: $pkg_manager run $script_name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    $pkg_manager run "$script_name"
  )
}

# ============================================================================
# Export functions based on shell
# ============================================================================

if [[ -n "$BASH_VERSION" ]]; then
  # Running in bash - export functions
  export -f fcd
  export -f revcat
  export -f gls
  export -f gcd
  export -f ghcode
  export -f gget
  export -f gget-search
  export -f ghnew
  export -f grm
  export -f gclean
  export -f gsw
  export -f ghq-help
  export -f ns
elif [[ -n "$ZSH_VERSION" ]]; then
  # Running in zsh - no need to export
  :
fi