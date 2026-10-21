# gh token from 1Password Environments
if [ -p "$HOME/.config/gh/.env" ]; then
  _with_gh_token() { GH_TOKEN="$(sed -n 's/^GH_TOKEN=//p' "$HOME/.config/gh/.env")" command "$@"; }
  gh() { _with_gh_token gh "$@"; }
  or() { _with_gh_token or "$@"; }
fi
