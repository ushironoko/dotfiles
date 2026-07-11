---
name: write-session
description: "Persist mid-session progress (plan refinements, task progress notes, scope changes, decisions, blockers) to the bit issues created by start-work. Use as a checkpoint before context compaction, after meaningful progress (multiple tasks done, plan refined, scope shifted), before pausing work, or when the user mentions 'save session', 'snapshot', 'checkpoint', 'update bit issue', or 'persist progress'."
---

# Overview

pi fork of the Claude Code `write-session` skill. Mid-session companion to
`start-work` and `restoring-session`.

- `start-work` → opens session state into bit issues (plan + Target Files + tasks).
- `write-session` → updates that state with progress made since.
- `restoring-session` → reads it back into a new conversation.

Without `write-session`, bit issues stay frozen at session start. Restoring a
long session then yields a stale plan and no progress trace, and parallel
sessions running overlap detection see stale Target Files.

`write-session` is a save point: it inspects the session task state (the bit
task issues plus your working memory of each task's status — pi has no
built-in task list), git state, plan file, and the decisions distilled from
the conversation, then writes the deltas back to the relevant bit issues.

## When to invoke

- User explicitly asks: "save", "snapshot", "checkpoint", "update bit issue", "persist progress".
- Before context compaction (proactively, when context is filling and prior turns risk being summarized).
- After meaningful progress: ≥1 task completed, plan refined, scope changed (new files modified, files dropped).
- Before going idle (end of work session, switching tasks).

Do **not** invoke for:

- Fresh work with no prior `start-work` session → use `start-work` instead.
- Pure context recovery → use `restoring-session`.
- Trivial edits (single-file, no decisions) — comment churn isn't worth it.

## Issue title contract (must match `start-work`)

| Kind   | Title prefix                                   |
| ------ | ---------------------------------------------- |
| Parent | `[plan:<branch-name>#<seq>] <title>`           |
| Task   | `[task:<branch-name>#<seq>:<task_id>] <title>` |

Both labelled `session:<branch-name>`. `write-session` reads, never invents
new titles or seqs. Task ids are the sequential integers you (or a prior
session) assigned and embedded in the titles.

## Comment prefix conventions

Use these prefixes so future skills (and `restoring-session`) can parse
comment intent. They extend the prefixes already used by `start-work`
(`Excluded`, `Target added`). You may also encounter `Re-linked:` comments on
issues touched by Claude Code sessions — bit issues are shared across
harnesses — but pi's `restoring-session` never produces them (pi task ids are
adopted, not remapped).

| Prefix           | Where          | Purpose                                          |
| ---------------- | -------------- | ------------------------------------------------ |
| `Snapshot <ts>:` | parent         | Periodic full state checkpoint with key points   |
| `Plan updated:`  | parent         | Flag that parent body Plan section was rewritten |
| `Progress:`      | task           | What advanced on this task since last comment    |
| `Decision:`      | task or parent | Non-obvious choice with rationale (one line)     |
| `Blocker:`       | task           | What is currently blocking the task              |
| `Resolved:`      | task           | Counterpart to `Blocker:` once cleared           |

Keep each comment ≤ ~5 lines. Snapshots may be slightly longer but never
paste raw transcripts or full diffs — use `git diff --stat` summaries and
decision bullets only.

## Execution flow

### Phase 1: Verify bit + locate active session

```bash
command -v bit >/dev/null 2>&1 || { echo "bit unavailable"; exit 0; }
git branch --show-current
bit issue list --open --label "session:<branch-name>"
```

Find the parent issue (`[plan:<branch>#<seq>]`) and its task issues (`[task:<branch>#<seq>:<task_id>]`).

| Situation                          | Action                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `bit` missing                      | Report "coordination disabled", stop. No persistence possible.                     |
| No open parent for branch          | Suggest the `start-work` skill (or `restoring-session` if user expects one). Stop. |
| Multiple open parents on branch    | Ask which session to checkpoint. Do nothing until answered.                        |
| Single open parent, ≥0 task issues | Proceed.                                                                           |

### Phase 2: Gather state

Collect, in parallel where independent:

1. **Session task state** — the task issues for this session are the authoritative roster (pi has no task-list tool). Map your working memory of each task's status (done / in progress / not started) to its bit issue via the `task_id` embedded in the task issue title.
2. **Parent body** — `bit issue view <parent_id>`; remember the existing `## Plan` section.
3. **Plan file** — if its absolute path is still in conversation context, read it. Otherwise skip (do not guess paths or fabricate plan content).
4. **Git state** — `git diff --stat` (vs base or HEAD as relevant), `git log --oneline <parent_creation>..HEAD` for commits since session start.
5. **Cross-session view** — `bit issue list --open` (race + scope-change check, same as `start-work` §4).
6. **Agent memory** — distill from the current conversation: completed milestones, key decisions and their reasons, current blockers. Do not transcribe — extract.

### Phase 3: Compute the delta

For each axis, decide whether to write and what:

**Plan section (parent body):**

- If plan file unavailable → skip.
- If plan file content matches parent body's `## Plan` → skip.
- Else → rewrite parent body preserving `## Session Info`, replace `## Plan` with current file content. Plan a `Plan updated: <one-line reason>` comment.

**Per task — progress comment:**

- Task is in progress and has unrecorded movement (commits, edited Target Files, decisions made) → plan a `Progress:` comment summarizing what advanced.
- Task is not started and untouched → no comment.
- Task is done:
  - If matching bit issue is already closed → no action (the `task_completed` tool already closed it at completion time).
  - If matching bit issue is still open → call the `task_completed` tool with `{task_id, task_subject}`. It is synchronous and close-verified (fail-closed; verification is skipped only when the `bit` executable is missing), so a failure is visible in the tool response — only fall back to direct `bit issue close` when the tool reports failure. Always pair the close with a `Progress: done — <one line>` comment.

**Per task — Target Files (scope change):**

- For each task issue, intersect its declared Target Files (modify/delete only) with files in `git diff --stat` actually touched.
- Files modified that aren't in any open issue's Target Files → run the `start-work` §5 decision matrix (overlap detection, owner check). Update bodies + add `Target added:` / `Excluded ` comments accordingly.
- Files declared but never touched and not planned for this task → leave alone (may be future work in this task).

**Decisions / blockers (extracted from conversation):**

- Each non-obvious decision since last write → one `Decision: <choice> — <reason>` comment, placed as follows (rules cascade — apply the first matching one and stop):
  1. If a `Plan updated:` comment will already convey this decision's rationale (i.e. it caused or motivated the plan-section rewrite) → **skip the separate `Decision:` comment**. `Plan updated:` is the canonical record; do not duplicate.
  2. Else if the decision affects ≥ 2 task issues, or sets a project/session-wide rule, or chooses among architectural alternatives that downstream tasks will rely on → comment on the **parent issue**. Do not also post duplicates on individual task issues.
  3. Else (decision is local to one task — e.g. a library/algorithm choice for that task's implementation) → comment on **that task's issue**. If multiple tasks are touched but only one is in progress, treat the decision as local to the in-progress task (rule 3, not rule 2).
- Each active blocker → `Blocker: <what is stuck>` on its task. If a previously logged blocker is now resolved, add `Resolved: <prior blocker>` on the same task.

**Parent snapshot:**

- Append one `Snapshot YYYY-MM-DDTHH:MM:SSZ` comment to the parent summarizing: tasks completed since last snapshot, files touched (`git diff --stat` top 3 by line count, or one summary stat line), key decisions (≤3 bullets), open blockers. Use UTC timestamp.
- **When to emit**: emit by default. Skip **only when all three** of the following hold:
  1. No `Progress:` / `Decision:` / `Blocker:` / `Resolved:` comments were planned this run on any task issue.
  2. No parent body rewrite (Plan section change) happened this run.
  3. The most recent existing `Snapshot:` on the parent is **< 30 min old** (compare its embedded timestamp to current UTC time).
- This is the operational definition of "no-op run". Default behavior is **emit**; only the three-condition skip is exempt. If in doubt, emit — a redundant snapshot is cheaper than a missing one.

### Phase 4: Show the plan, then apply

Render a compact summary of intended writes (what will be commented on which
issue, what bodies will be rewritten). In **auto mode**, show the summary and
proceed without confirmation. In normal mode, ask before applying.

Apply order:

1. Task body updates (scope changes via `bit issue update`).
2. Task comments (`Progress:`, `Decision:`, `Blocker:`, `Resolved:`).
3. `task_completed {task_id, task_subject}` for each done-but-open task — the tool closes and verifies synchronously.
4. Parent body update (if plan section changed) + `Plan updated:` comment.
5. Parent `Snapshot <ts>:` comment last, so it reflects everything written above.

Always `bit issue view <id>` immediately before any `bit issue update` — body
is read-modify-write and you must not clobber concurrent edits from another
session.

### Phase 5: Report

One-line per write, grouped by issue. Include parent snapshot timestamp so the
user can correlate later. Then stop — do not continue making code changes
implicitly. The user resumes regular work afterwards.

## What NOT to write

- Raw conversation transcripts. Distill to bullets.
- Full git diffs. Use `--stat` summaries; reference files, not contents.
- Secrets (API keys, credentials, .env contents). If a Target File is sensitive, refer to it by path only.
- Private repo names, company / org / client names, internal tool names — same confidentiality rules as apply to commit messages and PR descriptions in the global agent instructions.
- Updates to parent `## Session Info`. That section is invariant for the session; if worktree path changed, something is wrong — report it instead of silently rewriting.
- New issues. `write-session` only updates and comments. Creating new task issues mid-session is `start-work` §3 territory (re-run that, don't reinvent here).

## Idempotency

Running `write-session` twice in a row with no intervening change should
produce a near-empty second pass: no body updates, no progress comments
(nothing advanced), and **no snapshot** (per Phase 3's three-condition skip).
Achieve this by:

- Comparing parent body's `## Plan` to plan file before rewriting.
- Only emitting `Progress:` when there is observable movement (new commits, new touched files, new decisions logged).
- Skipping `Snapshot:` only when **all three** Phase 3 "When to emit" skip conditions hold (no per-task writes planned, no parent body rewrite, prior snapshot < 30 min old). This is the only state where two consecutive `write-session` runs both produce zero writes.

## Error handling

| Situation                                                 | Response                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bit` CLI missing                                         | Report and stop. No persistence possible.                                                                                                                                                                                                            |
| No open parent on branch                                  | Suggest the `start-work` skill (or `restoring-session` if user expects an existing one). Stop.                                                                                                                                                       |
| Multiple open parents                                     | List with seq numbers, ask which to checkpoint. No writes until answered.                                                                                                                                                                            |
| Plan file path unknown / file missing                     | Skip plan-section rewrite. Note "Plan section not updated — plan file path not available" in the snapshot.                                                                                                                                           |
| Parent body's `## Session Info` worktree mismatches `pwd` | Do not rewrite. Report the mismatch; user investigates (could be a misrouted skill invocation).                                                                                                                                                      |
| `git` command fails (e.g. shallow clone)                  | Skip diff/log inputs; persist what is available; note the gap in the snapshot.                                                                                                                                                                       |
| `bit issue update` rejected (concurrent edit)             | Re-`view`, recompute the merged body, retry once. If still failing, surface the conflict to the user.                                                                                                                                                |
| `task_completed` reports failure (close not verified)     | Fall back to direct `bit issue close` with a `Progress: done — closed by write-session fallback` comment. If `bit` was missing at completion time, verification was skipped — retry `task_completed` now that you have confirmed `bit` is available. |

## Prohibited (relay/network)

Same as `start-work` and `restoring-session`. Never run: `bit issue claim` /
`unclaim` / `claims` / `watch` / `import`, `bit pr import`, `bit relay serve` /
`sync`, `bit clone relay+*`. `write-session` is local-only.

## Worked examples

For concrete write-session walk-throughs (routine checkpoint, plan-section
rewrite, scope-change reconciliation, `task_completed` fallback close), read
`references/examples.md`.
