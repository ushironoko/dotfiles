---
name: start-work
description: "Start implementation work with worktree isolation and cross-session file conflict avoidance. Use this skill when beginning any non-trivial code change: after plan mode, when creating a new branch, implementing features, fixing bugs across multiple files, or refactoring. Also use when the user mentions worktree, bit issue, session coordination, or parallel work."
---

# Overview

Declare work scope and Target Files via bit issue + git worktree so that parallel Claude Code sessions can see each other's file ownership and avoid conflicts.

Every session working in a worktree creates a bit issue listing its Target Files. Since all worktrees share the same `.git`, any worktree can instantly read any other session's issues.

`bit issue` works transparently from any worktree.

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

## 1. Decide: New Session or Resume

```bash
bit issue list --open
```

- **Open session exists for this branch** → go to [Resume Session](#6-resume-session)
- **No existing session** → continue to §2

## 2. Read the Plan File

Worktrees have isolated filesystems. Plan files are `.gitignore`d, so `git show` won't work. Read from the main repo's absolute path.

1. If the plan file path is still in the session context, use it directly
2. Otherwise, find the latest file in the plans directory (default: `./plans`) relative to the main repo

```bash
ls -t <main-repo-path>/plans/*.md 2>/dev/null | head -1
```

If no plan file exists (minor work without plan mode), omit the Plan section from the issue body.

**Important**: Reading the plan file **before entering the worktree** is the most reliable approach. After entering, you can still access it via the main repo's absolute path.

## 3. Work Declaration Protocol

After worktree creation, create a `TaskCreate` task, then embed the returned `task_id` in the bit issue title. This lets the TaskCompleted hook auto-identify and close the issue later.

### Assign a sequence number

Count **all** issues (not just open) with the session label to avoid reuse after close/reopen cycles:

```bash
bit issue list --all --label "session:<branch-name>"
# → N issues found → next seq = N+1
```

### Create parent issue (plan)

Create a single parent issue containing the full plan. This serves as the root for all task issues in this session.

```bash
bit issue create \
  --title "[plan:<branch-name>#<seq>] <plan title in English>" \
  --label "session:<branch-name>" \
  --body "$(cat <<'BODY'
## Session Info

- **branch**: <branch-name>
- **worktree**: <worktree-absolute-path>
- **main repo**: <main-repo-absolute-path>

## Plan

<full plan file content>
BODY
)"
```

Note the returned issue ID — all task issues reference it as their parent.

### Create task issues (one per task, all upfront)

For **each task** in the plan, call `TaskCreate` → get `task_id`, then create a bit issue linked to the parent.

Create **all task issues before starting work**.

```bash
# Repeat for each task in the plan
bit issue create \
  --title "[task:<branch-name>#<seq>:<task_id>] <task summary in English>" \
  --label "session:<branch-name>" \
  --body "$(cat <<'BODY'
parent: #<parent_issue_id>

## Target Files

- path/to/file.ts (modify|create|delete)

## Task Description

<task description>
BODY
)"
```

Including `<branch-name>` and `#<seq>` in the title prevents collision when multiple sessions have the same sequential task_id.

**Why create a parent issue?** It groups all tasks under one plan, making it easy to see the full scope of a session. On resume, reading the parent issue restores the complete plan context.

**Why create all task issues upfront?** Other sessions need to see the full scope of your work across all phases to avoid conflicts. Creating issues only for the current phase causes false "no overlap" results for later phases.

**Why use absolute paths for worktree?** Needed for orphan detection and as the `cd` target on session resume.

## 4. Cross-Session Awareness Protocol

Check other sessions' Target Files at these three points:

1. **After issue create**: Run `bit issue list --open` immediately (race condition mitigation — two sessions creating issues simultaneously may both see "no overlap")
2. **On scope change**: When you need to modify files not in your original Target Files
3. **Before close**: Final check before completing

For each open issue **other than your own**, view it and extract Target Files from the body. Only consider `modify` and `delete` operations for overlap — `create` files are unowned by definition.

```bash
bit issue list --open
bit issue view <other-session-id>
```

## 5. Overlap Detection & Autonomous Adjustment

### Decision Matrix

```
overlapping = my modify/delete files ∩ other modify/delete files
remaining   = my total targets - overlapping files

- 0 overlapping:              proceed
- some overlapping, remaining > 0: exclude overlapping files, update issue body + add comment
- all modify/delete files overlap:  ask user whether to proceed with exclusions or abort
```

### Dynamic Target Files Update

When excluding or adding files, update the issue body to keep Target Files authoritative, then add a comment for audit trail:

- Files owned by another session → exclude from issue body, find alternative approach

```bash
bit issue view <id>                      # read current body
bit issue update <id> --body "<revised body with excluded files removed>"
bit issue comment add <id> --body "Excluded path/to/file.ts (owned by session X)"
```

- Files owned by nobody → add to issue body, record in comment

```bash
bit issue view <id>                      # read current body
bit issue update <id> --body "<revised body with new file added>"
bit issue comment add <id> --body "Target added: path/to/new-file.ts (modify) - reason: ..."
```

## 6. Resume Session

### 1. Find the Session

```bash
bit issue list --open --label "session:<branch-name>"
# or
bit issue list --open
```

### 2. Restore Context

```bash
bit issue view <id>              # plan + target files
bit issue comment list <id>      # scope changes + progress
```

The issue body contains the canonical Target Files and plan. Comments track scope changes and progress.

### 3. Continue

Resume work using the restored context. The issue body is the source of truth for current Target Files.

### 4. Clean Up Orphans

If a session is abandoned with no committed work:

```bash
bit issue comment add <id> --body "Orphan: session abandoned"
bit issue close <id>
```

Use `bit issue list --all` to find both open and closed sessions.

## 7. Completion Protocol

Close task issues **before** removing the worktree. Reversing this order creates orphan issues (issue stays open but its worktree is gone).

### Task issue close

**MUST**: When each task completes, immediately call `TaskUpdate(task_id, completed)`. This is the trigger that fires the TaskCompleted hook and auto-closes the matching bit issue. Without this call, the issue stays open indefinitely.

```
task done → TaskUpdate(task_id, completed) → TaskCompleted hook → bit issue close
```

The hook matches the open issue containing `[task:<branch>:<task_id>]` in its title. It runs async, so it doesn't block the main agent.

Fallback if the hook fails (async, so no error is raised):

```bash
bit issue comment add <id> --body "Done: <summary of changes>"
bit issue close <id>
```

### Parent issue close

After all task issues are closed, close the parent plan issue:

```bash
bit issue close <parent_id>
# WorktreeRemove hook handles gwq remove
```

## 8. Error Handling

| Situation         | Response                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| bit command fails | Notify user: "Coordination disabled — overlap detection is not working." Continue work.           |
| bit not installed | Solo mode — notify user that coordination is skipped.                                             |
| Orphan issue      | Check `gwq list` for worktree existence. If no matching worktree, exclude from overlap detection. |
| Worktree trouble  | `gwq list` (list all), `gwq prune` (clean stale refs), `gwq status` (check changes)               |

## Worked Examples

For concrete workflow examples (solo session, parallel sessions without overlap, parallel sessions with overlap adjustment), read `references/examples.md`.

## Commands Reference

```bash
bit issue create --title "..." --label "..." [--label "..."] --body "..."
bit issue list [--open] [--closed] [--all] [--label <name>] [--parent <id>]
bit issue view <id>
bit issue update <id> [--title "..."] [--body "..."] [--label "..."]
bit issue close <id>                     # idempotent
bit issue reopen <id>                    # idempotent
bit issue comment add <id> --body "..."
bit issue comment list <id>
```
