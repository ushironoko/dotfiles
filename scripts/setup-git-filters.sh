#!/usr/bin/env bash
# setup-git-filters.sh — register the scrub git clean filters for this checkout.
#
# git filter drivers live in .git/config, which is never committed, so this has
# to run once per clone. It is idempotent and wired into `bun run run-all` (the
# pre-commit check) so the filters are guaranteed active before any commit.
#
# What the filters do:
#   codex-scrub  : strip machine-local [projects.*] trust state from
#                  codex/config.toml at `git add` time (codex/scrub-config.awk).
#                  git runs the filter with CWD at the repo top level, so the
#                  awk path is repo-relative.
#   claude-scrub : drop the machine/account-local top-level "remote" key that
#                  Claude Code writes into claude/.claude/settings.json
#                  (claude/scrub-settings.ts).
#   smudge       : identity (cat) — checkout writes the committed content verbatim.
#   required     : true — if a scrubber ever errors, git fails the operation
#                  loudly instead of silently staging unscrubbed content.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

git config filter.codex-scrub.clean "awk -f codex/scrub-config.awk"
git config filter.codex-scrub.smudge "cat"
git config filter.codex-scrub.required true

git config filter.claude-scrub.clean "bun claude/scrub-settings.ts"
git config filter.claude-scrub.smudge "cat"
git config filter.claude-scrub.required true

echo "codex-scrub and claude-scrub git filters configured for $repo_root"
