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

  # 4. Assign sequence number
  bit issue list --all --label "session:feat/add-validation"
  → 0 issues found → seq = 1

  # 5. Create parent + task issues
  bit issue create \
    --title "[plan:feat/add-validation#1] Add input validation" \
    --label "session:feat/add-validation" \
    --body "
      ## Session Info
      - branch: feat/add-validation
      - worktree: /Users/user/.worktrees/feat/add-validation
      - main repo: /Users/user/project

      ## Plan
      (full plan file content)
    "
  → parent issue #1

  bit issue create \
    --title "[task:feat/add-validation#1:task_abc] Create validator" \
    --label "session:feat/add-validation" \
    --body "
      parent: #1

      ## Target Files
      - src/utils/validate.ts (create)
      - src/commands/install.ts (modify)

      ## Task Description
      Add input validation for CLI commands
    "
  → task issue #2

  # 6. Check for other sessions
  bit issue list --open
  → #1, #2 [session:feat/add-validation]  ← self only

  ... work ...

  # 7. Complete → TaskUpdate triggers hook → close → remove worktree
  TaskUpdate(task_abc, completed) → TaskCompleted hook → bit issue close #2
  bit issue close #1
  # WorktreeRemove hook runs gwq remove
```

## Example 2: Two parallel sessions (no overlap)

Target Files don't overlap, so both sessions proceed independently.

```
Session A:                                Session B:
  bit issue create                          bit issue create
    "[task:feat/parser#1:t1]                  "[task:feat/tests#1:t2]
     Improve CLI parser"                      Increase test coverage"
    Target: src/cli/parser.ts (modify)        Target: tests/core/*.test.ts (modify)
    → issue #3                                → issue #4
       │                                         │
  bit issue list --open                     bit issue list --open
  → #3 parser (self)                        → #3 parser (Session A)
  → #4 tests (Session B)                    → #4 tests (self)
       │                                         │
  overlap = 0 → proceed                    overlap = 0 → proceed
       │                                         │
  TaskUpdate → close #3                    TaskUpdate → close #4
```

## Example 3: Two parallel sessions (overlap → adjustment)

When Target Files overlap, sessions coordinate. Only `modify` and `delete` ops count for overlap — `create` is unowned.

```
Session A:                                Session B:
  bit issue create                          bit issue create
    "Unify error handling"                    "Improve logging"
    Target:                                   Target:
      src/core/symlink-manager.ts (modify)      src/core/symlink-manager.ts (modify) ← overlap!
      src/core/backup-manager.ts (modify)       src/utils/logger.ts (modify)
    → issue #5                                → issue #6
       │                                         │
  bit issue list --open                     bit issue list --open
  → #5 (self), #6 (Session B)              → #5 (Session A), #6 (self)
       │                                         │
  bit issue view #6                         bit issue view #5
  → symlink-manager.ts overlaps!            → symlink-manager.ts overlaps!
       │                                         │
  overlap: 1 file, remaining: 1            overlap: 1 file, remaining: 1
  → exclude + update body                  → ask user (or exclude)
       │                                         │
       ▼                                         ▼
  User: "A owns symlink-manager.ts"         User: "leave symlink-manager.ts to A"
       │                                         │
  proceed as-is                             bit issue view #6  ← read current body
                                            bit issue update #6 --body "<revised>"
                                            bit issue comment add #6
                                              "Excluded symlink-manager.ts (owned by session A)"
```

## Example 4: Resume session

Resuming a previously started session from a new conversation.

```
Session A (resumed):
  # 1. Find existing session
  bit issue list --open --label "session:feat/add-validation"
  → #1 [plan:feat/add-validation#1] Add input validation
  → #2 [task:feat/add-validation#1:task_abc] Create validator

  # 2. Restore context from parent issue
  bit issue view 1
  → plan content, session info, worktree path

  # 3. Check scope changes via comments
  bit issue comment list 2
  → "Target added: src/utils/schema.ts (modify) - needed for schema validation"

  # 4. Continue work using restored context
  ... work ...

  # 5. Complete
  TaskUpdate(task_abc, completed)
  bit issue close 1
```
