# gh token from 1Password Environments
if [ -p "$HOME/.config/gh/.env" ]; then
  _with_gh_token() { GH_TOKEN="$(sed -n 's/^GH_TOKEN=//p' "$HOME/.config/gh/.env")" command "$@"; }
  gh() { _with_gh_token gh "$@"; }
  or() { _with_gh_token or "$@"; }
fi

# Claude Code only enables kitty images for terminals it names, and Rex answers kitty graphics under its own name.
if [ "$TERM_PROGRAM" = "rex" ] && [ -z "$TMUX" ] && [ -z "$ZELLIJ" ]; then
  export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1
fi
