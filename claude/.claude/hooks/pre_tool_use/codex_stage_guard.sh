#!/usr/bin/env bash
# PreToolUse hook (matcher: Workflow): advisory guard that checks the
# about-to-run workflow script for a cross-model codex stage and injects a
# reminder when none is present. ADVISORY ONLY — it never emits a
# permissionDecision and never blocks; the marker grep is best-effort
# (a roster variable defined elsewhere can produce a false nudge).
# Silent when codex is absent/unauthenticated or the script has a codex stage.
set -euo pipefail

INPUT=$(cat)

# Malformed JSON must stay silent (exit 0), matching the documented contract.
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
[ "$TOOL" = "Workflow" ] || exit 0

SCRIPT=$(printf '%s' "$INPUT" | jq -r '.tool_input.script // empty' 2>/dev/null) || exit 0
if [ -z "$SCRIPT" ]; then
  SCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.scriptPath // empty' 2>/dev/null) || exit 0
  # Named/saved workflows ({name}) and unreadable paths: stay silent.
  [ -n "$SCRIPT_PATH" ] && [ -r "$SCRIPT_PATH" ] || exit 0
  SCRIPT=$(cat "$SCRIPT_PATH")
fi

# Markers that count as a codex stage; codex-skip is the explicit opt-out.
printf '%s' "$SCRIPT" | grep -qiE 'codex-reviewer|codex-poc|codex-stage|codex exec|codex-skip' && exit 0

# codex is installed via bun; the hook shell may lack that PATH entry.
command -v codex >/dev/null 2>&1 || {
  [ -x "$HOME/.bun/bin/codex" ] && export PATH="$HOME/.bun/bin:$PATH" || exit 0
}

AUTH_CACHE="${TMPDIR:-/tmp}/codex_auth_ok.$(id -u)"
if [ ! -f "$AUTH_CACHE" ] || [ -n "$(find "$AUTH_CACHE" -mmin +60 2>/dev/null)" ]; then
  codex login status >/dev/null 2>&1 || exit 0
  touch "$AUTH_CACHE"
fi

CTX='This workflow script contains no cross-model (codex) stage. ultracode workflows should include at least one: agentType "codex-reviewer" in review/verification fan-outs, agentType "codex-poc" (with isolation "worktree") for competing implementation PoCs, or a Bash stage calling ~/.claude/hooks/lib/codex-stage.sh for diff review. Templates: ~/.claude/skills/start-work/references/multi-model-workflows.md. If codex was intentionally omitted (trivial or non-review workflow, or the user opted out), proceed and add the comment "// codex-skip" to the script next time.'

jq -n --arg ctx "$CTX" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $ctx
  }
}'
