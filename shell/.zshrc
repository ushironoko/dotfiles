# ~/.zshrc: executed by zsh for interactive shells.

# If not running interactively, don't do anything
[[ -o interactive ]] || return

# History configuration
HISTFILE=~/.zsh_history
HISTSIZE=10000
SAVEHIST=10000
setopt APPEND_HISTORY
setopt SHARE_HISTORY
setopt HIST_IGNORE_DUPS
setopt HIST_IGNORE_ALL_DUPS
setopt HIST_IGNORE_SPACE
setopt HIST_REDUCE_BLANKS

# Directory navigation
setopt AUTO_CD
setopt AUTO_PUSHD
setopt PUSHD_IGNORE_DUPS
setopt PUSHD_SILENT

# Completion
autoload -Uz compinit && compinit
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Z}'
zstyle ':completion:*' list-colors "${(s.:.)LS_COLORS}"
zstyle ':completion:*' menu select


# Color support for ls (macOS)
export CLICOLOR=1
export LSCOLORS=ExGxBxDxCxEgEdxbxgxcxd

# Aliases
alias ls='ls -G'
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'
alias grep='grep --color=auto'
alias fgrep='fgrep --color=auto'
alias egrep='egrep --color=auto'

# Navigation aliases
alias ..="cd .."
alias ...="cd ../.."
alias ....="cd ../../.."
alias .....="cd ../../../.."
alias dev="cd ~/dev"

# Editor and config aliases
alias zrc="code ~/.zshrc"
alias gc="code ~/.gitconfig"
alias c="code"
alias re="exec $SHELL -l"

# Git aliases
alias g="git"

# Docker aliases
alias dc="docker-compose"

# Package manager aliases
alias px="pnpm dlx"
alias p="pnpm"

# Deno aliases
alias dccc="deno run -A jsr:@mizchi/ccdiscord"

# ghq/fzf function aliases (use 'type <name>' or 'which <name>' to see definition)
# These are functions, not aliases, but behave similarly
gls() { ghq list; }
gcd() { local r=$(ghq list | fzf --height 40% --reverse); [ -n "$r" ] && cd "$(ghq root)/$r"; }
ghcd() { local r=$(ghq list | grep github.com | fzf --height 40% --reverse); [ -n "$r" ] && cd "$(ghq root)/$r"; }
ghcode() { local r=$(ghq list | fzf --height 40% --reverse); [ -n "$r" ] && code "$(ghq root)/$r"; }
gget() { [ $# -eq 0 ] && ghq get "https://github.com/$(gh repo list --limit 1000 --json nameWithOwner --jq '.[].nameWithOwner' | fzf --height 40% --reverse --preview "gh repo view {}")" || ghq get "$@"; }
gget-search() { [ $# -eq 0 ] && echo "Usage: gget-search <query>" && return 1; local r=$(gh search repos "$*" --limit 30 --json fullName,description,stargazersCount | jq -r '.[] | [.fullName, .description // ""] | @tsv' | column -t -s $'\t' | fzf --height 40% --reverse --with-nth 1,2 | awk '{print $1}'); [ -n "$r" ] && ghq get "https://github.com/$r"; }
ghnew() { [ $# -eq 0 ] && echo "Usage: ghnew <name> [--public|--private]" && return 1; gh repo create "$@" && ghq get "https://github.com/$(gh api user --jq .login)/$1" && cd "$(ghq root)/github.com/$(gh api user --jq .login)/$1"; }
grm() { local r=$(ghq list | fzf --height 40% --reverse); [ -n "$r" ] && echo "Remove $(ghq root)/$r? [y/N]" && read -r a && [ "$a" = "y" ] && rm -rf "$(ghq root)/$r" && echo "Removed"; }

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
  echo "  gcd         - Change directory to repository (interactive)"
  echo "  ghcd        - Change directory to GitHub repository (interactive)"
  echo "  ghcode      - Open repository in VS Code (interactive)"
  echo "  gget        - Clone repository (no args: your repos, with args: any repo)"
  echo "  gget-search - Search and clone from GitHub"
  echo "  ghnew       - Create new GitHub repo and clone"
  echo "  grm         - Remove repository (interactive)"
  echo "  gclean      - Clean up local branches not on remote (interactive)"
  echo ""
  echo "Use 'type <command>' to see the function definition"
}

# Node Version Manager
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# Rust
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# pnpm
export PNPM_HOME="$HOME/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac

# Bun (managed by mise - path is added via mise shims)
# export BUN_INSTALL="$HOME/.bun"
# export PATH="$BUN_INSTALL/bin:$PATH"

# Homebrew (Apple Silicon)
if [ -f "/opt/homebrew/bin/brew" ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# Homebrew (Intel)
if [ -f "/usr/local/bin/brew" ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

# mise - universal version manager
# Always activate mise to ensure shims are in PATH
eval "$(mise activate zsh)"

# direnv hook
if command -v direnv &> /dev/null; then
  eval "$(direnv hook zsh)"
fi

# VS Code
export PATH="$PATH:/Applications/Visual Studio Code.app/Contents/Resources/app/bin"

# Local bin
export PATH="$HOME/.local/bin:$PATH"


# Load additional zsh configurations if exists
[ -f "$HOME/.zshrc.local" ] && . "$HOME/.zshrc.local"

# Starship prompt
# Initialize starship after mise is activated
eval "$(starship init zsh)"

# Interactive directory navigation with fzf
if [ -f "$HOME/ghq/github.com/ushironoko/dotfiles/scripts/fcd" ]; then
  source "$HOME/ghq/github.com/ushironoko/dotfiles/scripts/fcd"
fi
