#!/usr/bin/env bash
# setup-git-filters.sh — register the codex-scrub git clean filter for this checkout.
#
# git filter drivers live in .git/config, which is never committed, so this has
# to run once per clone. It is idempotent and wired into `bun run run-all` (the
# pre-commit check) so the filter is guaranteed active before any commit.
#
# What the filter does:
#   clean    : strip machine-local [projects.*] trust state from
#              codex/config.toml at `git add` time (codex/scrub-config.awk).
#              git runs the filter with CWD at the repo top level, so the awk
#              path is repo-relative.
#   smudge   : identity (cat) — checkout writes the committed content verbatim.
#   required : true — if the awk ever errors, git fails the operation loudly
#              instead of silently staging unscrubbed content.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

git config filter.codex-scrub.clean "awk -f codex/scrub-config.awk"
git config filter.codex-scrub.smudge "cat"
git config filter.codex-scrub.required true

echo "codex-scrub git filter configured for $repo_root"
