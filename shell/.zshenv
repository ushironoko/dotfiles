# gh token from 1Password Environments
[ -p "$HOME/.config/gh/.env" ] && gh() { GH_TOKEN="$(sed -n 's/^GH_TOKEN=//p' "$HOME/.config/gh/.env")" command gh "$@"; }
