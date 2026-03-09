---
name: start-work
description: "Start implementation work with worktree isolation and cross-session file conflict avoidance. Use this skill when beginning any non-trivial code change: after plan mode, when creating a new branch, implementing features, fixing bugs across multiple files, or refactoring. Also use when the user mentions worktree, bit issue, session coordination, or parallel work."
---

# Overview

Declare work scope and Target Files via bit issue + git worktree so that parallel Claude Code sessions can see each other's file ownership and avoid conflicts.

Every session working in a worktree creates a bit issue listing its Target Files. Since all worktrees share the same `.git`, any worktree can instantly read any other session's issues.

### Session Lifecycle

```
  EnterWorktree           bit issue create
 ┌──────────┐          ┌──────────────┐
 │ worktree │─────────►│ issue create │
 │  create  │          │ (Target decl)│
 │ (hook)   │          └──────┬───────┘
 └──────────┘                 │
                    issue list (race check)
                              │
                       ┌──────▼───────┐
                  ┌───►│   working    │◄───┐
                  │    └──────┬───────┘    │
                  │           │            │
            scope change   pre-close    overlap
            (re-run §3)    (issue list) → adjust
                  │           │            │
                  └───────────┤            │
                              │
                       ┌──────▼───────┐
                       │ issue close  │
                       └──────┬───────┘
                              │
                       ┌──────▼───────┐
                       │ worktree rm  │
                       │ (hook)       │
                       └──────────────┘
```

## 0. Prerequisites

### GIT_DIR is required for bit commands inside a worktree

In a git worktree, `.git` is a file (pointer to the main `.git` directory), not a directory. The bit CLI expects a `.git` directory, so running bit commands directly inside a worktree fails with `"path exists and is not dir: ./.git"`.

Set `GIT_DIR` to the main repo's `.git` before every bit command:

```bash
MAIN_GIT="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')/.git"
GIT_DIR="$MAIN_GIT" bit issue <subcommand> ...
```

All subsequent sections assume `MAIN_GIT` has been set. It only needs to be computed once per session.

### Worktree lifecycle is managed by hooks

Worktree creation/removal is handled by Claude Code's `EnterWorktree` / `WorktreeRemove` hooks — no need to run gwq commands directly.

| Hook           | Action                                          |
| -------------- | ----------------------------------------------- |
| WorktreeCreate | `gwq add -b <name>` → returns worktree abs path |
| WorktreeRemove | branch lookup → `gwq remove -f -b` full cleanup |

After worktree creation, install dependencies based on the lock file:

```bash
if [ -f "bun.lockb" ]; then bun install
elif [ -f "pnpm-lock.yaml" ]; then pnpm install
fi
```

### CRITICAL: Prohibited commands

These commands communicate via the bit relay server. Running them on a private repo leaks repository content externally. **Never execute them.**

| Prohibited                                         | Reason                        |
| -------------------------------------------------- | ----------------------------- |
| `bit issue claim` / `unclaim` / `claims` / `watch` | relay-based exclusive control |
| `bit issue import` / `bit pr import`               | GitHub API access             |
| `bit relay serve` / `bit relay sync`               | relay publishing              |
| `bit clone relay+*`                                | relay-based clone             |

Also denied in `settings.json` `permissions.deny`.

### Allowed commands (local only)

`bit issue init` / `create` / `list` / `view` / `update` / `close` / `reopen` / `comment add` / `comment list` / `search`

## 1. Read the Plan File

Worktrees have isolated filesystems. Plan files are `.gitignore`d, so `git show` won't work. Read from the main repo's absolute path.

1. If the plan file path is still in the session context, use it directly
2. Otherwise, find the latest file in the plans directory (default: `./plans`) relative to the main repo

```bash
ls -t <main-repo-path>/plans/*.md 2>/dev/null | head -1
```

If no plan file exists (minor work without plan mode), omit the Plan section from the issue body.

**Important**: Reading the plan file **before entering the worktree** is the most reliable approach. After entering, you can still access it via the main repo's absolute path.

## 2. Work Declaration Protocol

After worktree creation, create a `TaskCreate` task, then embed the returned `task_id` in the bit issue title. This lets the TaskCompleted hook auto-identify and close the issue later.

### TaskCreate → bit issue create

1. Call `TaskCreate` tool → get `task_id`
2. Embed `[task:<branch-name>:<task_id>]` in `--title`

Including `<branch-name>` prevents collision when multiple sessions have the same sequential task_id.

```bash
GIT_DIR="$MAIN_GIT" bit issue create \
  --title "[task:<branch-name>:<task_id>] <task summary in English>" \
  --label "session:<branch-name>" \
  --body "$(cat <<'BODY'
## Session Info

- **branch**: <branch-name>
- **worktree**: <worktree-absolute-path>
- **main repo**: <main-repo-absolute-path>

## Target Files

- path/to/file.ts (modify|create|delete)

## Task Description

<task description>

## Plan

<full plan file content>
BODY
)"
```

**Why include the full plan?** It becomes the only context restoration source when resuming a session.

**Why use absolute paths for worktree?** Needed for orphan detection and as the `cd` target on session resume.

## 3. Cross-Session Awareness Protocol

Check other sessions' Target Files at these three points:

1. **After issue create**: Run `bit issue list --open` immediately (race condition mitigation — two sessions creating issues simultaneously may both see "no overlap")
2. **On scope change**: When you need to modify files not in your original Target Files
3. **Before close**: Final check before completing

```bash
GIT_DIR="$MAIN_GIT" bit issue list --open
GIT_DIR="$MAIN_GIT" bit issue view <id>
```

## 4. Overlap Detection & Autonomous Adjustment

### Decision Matrix

```
overlap = |my Target Files ∩ other Target Files| / |my Target Files|

- 0%:      proceed
- <50%:    exclude overlapping files, record in comment
- ≥50%:    ask user (no orchestrator in peer-to-peer model)
```

### Dynamic Target Files Update

- Files owned by another session → avoid modifying, find alternative approach
- Files owned by nobody → add to your Target Files, record in comment

```bash
GIT_DIR="$MAIN_GIT" bit issue comment add <id> --body "Target Files added: path/to/new-file.ts (modify) - reason: ..."
```

## 5. Completion Protocol

Close the issue **before** removing the worktree. Reversing this order creates orphan issues (issue stays open but its worktree is gone).

### Recommended: auto-close via TaskCompleted hook

Call `TaskUpdate(task_id, completed)` → the TaskCompleted hook fires and auto-closes the matching bit issue (finds the open issue with `[task:<branch>:<task_id>]` in its title).

The hook runs async, so it doesn't block the main agent. After the hook fires, the worktree can be removed.

### Fallback: manual close

If the hook fails (async, so no error is raised), close manually:

```bash
GIT_DIR="$MAIN_GIT" bit issue comment add <id> --body "Done: <summary of changes>"
GIT_DIR="$MAIN_GIT" bit issue close <id>
# WorktreeRemove hook handles gwq remove
```

## 6. Error Handling

| Situation         | Response                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| bit command fails | Notify user: "Coordination disabled — overlap detection is not working." Continue work.           |
| bit not installed | Solo mode — notify user that coordination is skipped.                                             |
| Orphan issue      | Check `gwq list` for worktree existence. If no matching worktree, exclude from overlap detection. |
| Worktree trouble  | `gwq list` (list all), `gwq prune` (clean stale refs), `gwq status` (check changes)               |

## Worked Examples

For concrete workflow examples (solo session, parallel sessions without overlap, parallel sessions with overlap adjustment), read `references/examples.md`.
