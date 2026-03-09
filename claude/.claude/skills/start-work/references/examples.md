# Worked Examples

Read this file when you need concrete examples of the bit-coordination workflow.

## Example 1: Solo session (basic flow)

Even when no other sessions exist, always create an issue — another session may start later.

```
Session A:
  # 1. Read plan file BEFORE entering worktree
  Read: /Users/user/project/plans/add-validation.md
  → retain plan content

  # 2. EnterWorktree creates worktree (hook runs gwq add -b)
  → moved to /Users/user/.worktrees/feat/add-validation

  # 3. Install dependencies
  bun install

  # 4. Get MAIN_GIT + create issue (include full plan)
  MAIN_GIT="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')/.git"
  GIT_DIR="$MAIN_GIT" bit issue create \
    --title "[task:feat/add-validation:1] Add input validation" \
    --label "session:feat/add-validation" \
    --body "
      ## Session Info
      - branch: feat/add-validation
      - worktree: /Users/user/.worktrees/feat/add-validation
      - main repo: /Users/user/project

      ## Target Files
      - src/utils/validate.ts (create)
      - src/commands/install.ts (modify)

      ## Task Description
      Add input validation for CLI commands

      ## Plan
      (full plan file content)
    "

  # 5. Check for other sessions
  GIT_DIR="$MAIN_GIT" bit issue list --open
  → #1 Add input validation [session:feat/add-validation]  ← self only

  ... work ...

  # On session resume: GIT_DIR="$MAIN_GIT" bit issue view 1 restores full context

  # 6. Complete → close → remove worktree
  GIT_DIR="$MAIN_GIT" bit issue comment add 1 --body "Done: validate.ts created, install.ts updated"
  GIT_DIR="$MAIN_GIT" bit issue close 1
  # WorktreeRemove hook runs gwq remove
```

## Example 2: Two parallel sessions (no overlap)

Target Files don't overlap, so both sessions proceed independently.

```
Session A:                                Session B:
  bit issue create                          bit issue create
    "Improve CLI parser"                      "Increase test coverage"
    Target: src/cli/parser.ts                 Target: tests/core/*.test.ts
    → issue #2                                → issue #3
       │                                         │
  bit issue list --open                     bit issue list --open
  → #2 CLI parser (self)                    → #2 CLI parser (Session A)
  → #3 test coverage (Session B)            → #3 test coverage (self)
       │                                         │
  overlap = 0% → proceed                    overlap = 0% → proceed
       │                                         │
  bit issue close #2                        bit issue close #3
```

## Example 3: Two parallel sessions (overlap → adjustment)

When Target Files overlap, sessions coordinate through user confirmation.

```
Session A:                                Session B:
  bit issue create                          bit issue create
    "Unify error handling"                    "Improve logging"
    Target:                                   Target:
      src/core/symlink-manager.ts               src/core/symlink-manager.ts  ← overlap!
      src/core/backup-manager.ts                src/utils/logger.ts
    → issue #4                                → issue #5
       │                                         │
  bit issue list --open                     bit issue list --open
  → #4 (self), #5 (Session B)              → #4 (Session A), #5 (self)
       │                                         │
  bit issue view #5                         bit issue view #4
  → symlink-manager.ts overlaps!            → symlink-manager.ts overlaps!
       │                                         │
  overlap = 1/2 = 50%                       overlap = 1/2 = 50%
  → ask user                                → ask user
       │                                         │
       ▼                                         ▼
  User: "A owns symlink-manager.ts"         User: "leave symlink-manager.ts to A"
       │                                         │
  proceed as-is                             bit issue comment add #5
                                              "Excluded symlink-manager.ts, logger.ts only"
```
