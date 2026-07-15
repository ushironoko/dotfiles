#!/usr/bin/env bash
# Inject the Codex-native ultracode roster when the user opts into that workflow.
set -euo pipefail

INPUT=$(cat)

# pi exports this marker to every subprocess. Its hook bridge already owns the
# ultracode prompt in that path, so do not activate a second, Codex-native
# orchestration layer when pi delegates work to Codex CLI.
[ "${PI_CODING_AGENT:-}" = "true" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0

PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null | tr '[:upper:]' '[:lower:]') || exit 0
case "$PROMPT" in
  *ultracode*|*"ultra code"*) ;;
  *) exit 0 ;;
esac

CONTEXT='Ultracode mode is active. Use Codex native custom agents from ~/.codex/agents: codex-reviewer for read-only plan/design/diff/verification work; codex-poc only in an explicitly supplied isolated linked worktree and never in the main checkout; codex-runner for bounded write work whose files or directory the parent partitions so writers never overlap. Spawn independent agents through the native collaboration tools, wait for them, then synthesize and judge in the parent. These compatibility roles provide fresh contexts but are the same model family as the parent, so never describe their output as cross-model evidence. If the user explicitly requires another model family, use an actually different provider or report that guarantee as unavailable. Keep all PoC/runner changes uncommitted until parent review.'

jq -n --arg context "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $context
  }
}'
