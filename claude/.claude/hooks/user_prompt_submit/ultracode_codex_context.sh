#!/usr/bin/env bash
# UserPromptSubmit hook: when the prompt opts into ultracode, deterministically
# inject the cross-model (codex) mandate so workflow authoring cannot miss it.
# Silent (exit 0, no output) on every other prompt and on machines where codex
# is absent or unauthenticated.
set -euo pipefail

INPUT=$(cat)
# Field name differs across harness builds (.prompt / .user_prompt); malformed
# JSON must stay silent (exit 0), matching the documented contract.
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // .user_prompt // empty' 2>/dev/null | tr '[:upper:]' '[:lower:]') || exit 0

case $PROMPT in
  *ultracode*|*"ultra code"*) ;;
  *) exit 0 ;;
esac

# codex is installed via bun; the hook shell may lack that PATH entry.
command -v codex >/dev/null 2>&1 || {
  [ -x "$HOME/.bun/bin/codex" ] && export PATH="$HOME/.bun/bin:$PATH" || exit 0
}

# Auth preflight, cached for 1h so repeated ultracode prompts stay fast.
AUTH_CACHE="${TMPDIR:-/tmp}/codex_auth_ok.$(id -u)"
if [ ! -f "$AUTH_CACHE" ] || [ -n "$(find "$AUTH_CACHE" -mmin +60 2>/dev/null)" ]; then
  codex login status >/dev/null 2>&1 || exit 0
  touch "$AUTH_CACHE"
fi

CTX='Codex CLI is installed and authenticated on this machine. ultracode workflows must include cross-model (non-Claude) stages to counter single-model-family blind spots: (1) every review/verification fan-out includes an agent with agentType "codex-reviewer"; (2) competing implementation phases include an agent with agentType "codex-poc" spawned with isolation "worktree". All codex calls go through ~/.claude/hooks/lib/codex-stage.sh (auth preflight, timeout, --ephemeral; never pass -m). Workflow script templates: ~/.claude/skills/start-work/references/multi-model-workflows.md. If the user explicitly opts out of codex, add the comment "// codex-skip" to the workflow script.'

jq -n --arg ctx "$CTX" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'
