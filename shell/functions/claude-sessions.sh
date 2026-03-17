#!/usr/bin/env zsh

# Claude Code Session History Display
# Shows recent session IDs when entering a directory with Claude Code history
# Triggered via zsh chpwd hook

_claude_sessions_chpwd() {
  # Only in interactive terminals
  [[ ! -t 2 ]] && return

  # Require jq
  command -v jq &>/dev/null || return

  # Encode current directory path to Claude project dir format (/ and . → -)
  local project_dir="${PWD//\//-}"
  project_dir="${project_dir//./-}"
  local claude_path="$HOME/.claude/projects/$project_dir"

  # Skip if no Claude project data exists
  [[ ! -d "$claude_path" ]] && return

  # Get 3 most recent session files
  local -a files
  files=(${(f)"$(command ls -t "$claude_path"/*.jsonl 2>/dev/null | head -3)"})
  [[ ${#files[@]} -eq 0 ]] && return

  local -a sids
  local sid
  for f in "${files[@]}"; do
    sid=$(head -1 "$f" | command jq -r '.sessionId // empty' 2>/dev/null)
    [[ -n "$sid" ]] && sids+=("$sid")
  done

  [[ ${#sids[@]} -eq 0 ]] && return

  printf '%s' "claude --permission-mode auto --resume ${sids[1]}" | pbcopy

  local idx=1
  for s in "${sids[@]}"; do
    printf '\e[2m%d. %s\e[0m\n' "$idx" "$s" >&2
    ((idx++))
  done
}

# Register as chpwd hook and run once on shell startup (zsh only)
if [[ -n "$ZSH_VERSION" ]]; then
  autoload -Uz add-zsh-hook
  add-zsh-hook chpwd _claude_sessions_chpwd
  _claude_sessions_chpwd
fi
