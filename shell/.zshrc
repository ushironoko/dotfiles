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

# Interactive functions (fzf-based)
# Load ghq/fzf functions and fcd from shared file
[ -f "$HOME/ghq/github.com/ushironoko/dotfiles/shell/functions/interactive.sh" ] && \
  source "$HOME/ghq/github.com/ushironoko/dotfiles/shell/functions/interactive.sh"

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

# Load additional zsh configurations if exists
[ -f "$HOME/.zshrc.local" ] && . "$HOME/.zshrc.local"

# Starship prompt
# Initialize starship after mise is activated
eval "$(starship init zsh)"
