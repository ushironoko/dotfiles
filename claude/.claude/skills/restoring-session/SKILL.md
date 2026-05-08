---
name: restoring-session
description: Restore session state (plan, target files, in-flight tasks) from bit issues created by the start-work skill. Use when resuming work after Claude Code restart, when the in-memory task list is empty but bit issues exist for the current branch, or when the user mentions "restore session", "repair session", "pick up where I left off", or references a prior bit-issue-tracked session.
---

# Overview

Reverse companion of the `start-work` skill. `start-work` writes session state (plan, target files, tasks) into bit issues; `restoring-session` reads them back and rehydrates the in-memory `TaskList`.

Use when the conversation has lost task context (new session, compacted history) but the underlying bit issues still describe ongoing work.

## When to invoke

- User asks to "resume", "restore", "repair", or "continue" a session.
- A new conversation starts and you suspect prior task issues exist (e.g., user references work from earlier).
- After context compaction, before resuming any non-trivial change.

Do **not** invoke when no prior session work exists — `start-work` is the right skill for fresh work.

## Issue title contract (must match `start-work`)

| Kind   | Title prefix                                   |
| ------ | ---------------------------------------------- |
| Parent | `[plan:<branch-name>#<seq>] <title>`           |
| Task   | `[task:<branch-name>#<seq>:<task_id>] <title>` |

Both labelled with `session:<branch-name>`.

## Execution flow

### Phase 1: Verify bit CLI

```bash
command -v bit >/dev/null 2>&1 && bit --version
```

If absent: report to user, stop. No restoration possible.

### Phase 2: Determine current branch and list open issues

```bash
git branch --show-current
bit issue list --open
```

Optionally narrow with `--label "session:<branch-name>"` if the branch is known.

### Phase 3: Locate the active parent issue

Scan open issues for titles starting with `[plan:<branch-name>#`. Two outcomes:

**(a) Active parent found** → proceed to Phase 4.

**(b) No active parent** → branch has no in-flight session. Inspect recent activity to characterize state:

```bash
bit issue list --closed --limit 10
```

Then view: the **most recent `[plan:...]` closed issue** (1 issue) plus **every closed task issue that references it as parent** (filter by title prefix `[task:<that-branch>#<that-seq>:`). For each selected issue run `bit issue view <id>` and `bit issue comment list <id>`. Skip plans/tasks from other branches/seqs unless the user explicitly asks.

Summarize: what was completed, when it was closed (use the latest comment timestamp if no explicit close date is exposed), any open follow-ups mentioned in comments. Then stop — do not fabricate tasks. Report to the user.

### Phase 4: Load parent issue

```bash
bit issue view <parent_id>
```

Extract from the body:

- Branch name, worktree path, main repo path (Session Info section).
- Plan content (Plan section).

Note `<branch-name>#<seq>` for filtering task issues.

### Phase 5: Load sub-issues (open task issues)

Filter open issues whose titles start with `[task:<branch-name>#<seq>:`. For each:

```bash
bit issue view <task_id>
bit issue comment list <task_id>
```

Extract from each body:

- Parent reference (`parent: #<id>`) — sanity check it matches.
- Target Files list with operation (modify | create | delete).
- Task Description.

Comments may record scope adjustments (Target Files added/excluded). Apply the latest body as authoritative; comments are audit trail only.

### Phase 6: Report status to user

Before assembling the report, count closed task issues belonging to the same `<branch-name>#<seq>` as the parent:

```bash
bit issue list --closed --label "session:<branch-name>"
```

Then filter the result to titles starting with `[task:<branch-name>#<seq>:` — that count is what the report needs. (`--label` narrowing is valid for both `--open` and `--closed` lists.)

Render a compact summary **before** restoring tasks. Include:

- Branch + worktree path.
- Parent issue id and plan title.
- Count of open task issues, count of closed task issues for the same `<branch-name>#<seq>` (computed above).
- Per-open-task: task title, target files, brief description.

Ask the user to confirm if any reconstructed task looks wrong. In auto mode, proceed without confirmation but still show the summary.

### Phase 7: Restore tasks via TaskCreate

For each open task issue (Phase 5), call `TaskCreate` with:

- `subject`: extracted from the issue title (the part after `[task:...:<task_id>]`).
- `description`: assembled from the issue body — Target Files block + Task Description.

**Important — preserve the issue↔task linkage**: the task id returned by `TaskCreate` is **new** and will not match the original `<task_id>` embedded in the bit issue title. Without re-linking, the `TaskCompleted` hook will fail to auto-close the bit issue when the restored task completes.

Re-link by updating the bit issue title to embed the new task id:

```bash
bit issue update <task_id_issue> \
  --title "[task:<branch-name>#<seq>:<NEW_task_id>] <task summary>"
```

Add an audit comment so the rename is traceable:

```bash
bit issue comment add <task_id_issue> \
  --body "Re-linked: task_id <OLD> → <NEW> on session restore"
```

### Phase 8: Hand off to start-work conventions

Once tasks are restored, work continues under the `start-work` Cross-Session Awareness Protocol (overlap detection, scope-change updates, completion protocol). `restoring-session` does not own the rest of the lifecycle.

## Error handling

| Situation                                     | Response                                                                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bit` CLI missing                             | Report and stop. No restoration possible.                                                                                                                                                     |
| `bit issue list` returns "No issues"          | Report "no prior session" and stop.                                                                                                                                                           |
| Open parent without matching open task issues | Report parent plan only; let user decide whether to recreate tasks.                                                                                                                           |
| Open task issue with no matching parent       | Orphan — follow `references/examples.md` Example 3: report parent state, list options (standalone restore / parent reopen / close), pause for user input. No side effects until user replies. |
| Parent body malformed (missing Plan section)  | Restore what is parseable; flag the missing fields in the report.                                                                                                                             |
| Multiple open parents on the same branch      | List all with seq numbers; ask the user which session to restore.                                                                                                                             |
| Worktree path in parent body does not exist   | Report the mismatch; do not auto-`cd`. User decides whether to recreate the worktree.                                                                                                         |

## Prohibited (relay/network)

Same restrictions as `start-work` — never run: `bit issue claim` / `unclaim` / `claims` / `watch` / `import`, `bit pr import`, `bit relay serve` / `sync`, `bit clone relay+*`. Restoration is a read-mostly local operation.

## Worked examples

See `references/examples.md` for concrete restoration walk-throughs:

- Single-parent active session restore
- No-active-parent (recent-history-only) report
- Orphan task issue handling
- Re-link audit trail on `TaskCreate` id remap
