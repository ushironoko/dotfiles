# Worked Examples — write-session

Concrete checkpoint walk-throughs. Read on demand from `SKILL.md`.

## Example 1: Routine checkpoint, no scope change

Setup: branch `feat/cache`, parent `#90` open, two task issues `#91` (in_progress) and `#92` (pending). User says "let's checkpoint before I take a break".

```bash
git branch --show-current
# → feat/cache

bit issue list --open --label "session:feat/cache"
# → #90 [plan:feat/cache#1] Add LRU cache layer
# → #91 [task:feat/cache#1:1] Implement eviction policy
# → #92 [task:feat/cache#1:2] Wire cache into request handler
```

Gather state:

```
TaskList:
  task_id 1 — Implement eviction policy — in_progress
  task_id 2 — Wire cache into request handler — pending

git diff --stat (vs origin/main):
  src/cache/lru.ts           | 78 +++++++
  src/cache/eviction.ts      | 42 ++++
  tests/cache/lru.test.ts    | 31 +++

git log --oneline:
  e3a1b2c add LRU base
  c4d5e6f add eviction policy + tests

Decisions distilled from conversation:
  - chose LFU-tiebreaker on eviction (vs strict LRU) for hot-key workloads
```

Plan section in parent body matches plan file → skip body rewrite.

Apply:

```bash
bit issue comment add 91 --body "Progress: LRU base + eviction policy implemented; tests passing."
bit issue comment add 91 --body "Decision: LFU-tiebreaker on eviction — chosen over strict LRU for hot-key workloads."

bit issue comment add 90 --body "$(cat <<'C'
Snapshot 2026-05-08T07:14:00Z:
- 1/2 tasks advanced (#91 in flight, #92 not started).
- 3 files touched (src/cache/lru.ts, src/cache/eviction.ts, tests/cache/lru.test.ts).
- Decisions: LFU-tiebreaker on eviction.
- No blockers.
C
)"
```

Report:

```
Checkpoint complete (parent #90, snapshot 2026-05-08T07:14:00Z):
  #91 +2 comments (Progress, Decision)
  #90 +1 comment (Snapshot)
  No body rewrites, no closes.
```

## Example 2: Plan refined mid-session

Setup: during work, user revised the plan file to drop step 4 and add a new step. Parent body still holds the old plan.

```bash
bit issue view 90
# Body has Session Info + Plan (5 steps).

cat /Users/me/proj/plans/feat-cache.md
# Plan file now has 5 steps but step 4 differs and step 5 is new.
```

Detect mismatch (plan file ≠ parent body's `## Plan`). Rewrite parent body:

```bash
bit issue update 90 --body "$(cat <<'BODY'
## Session Info
- branch: feat/cache
- worktree: /Users/me/wt/feat-cache
- main repo: /Users/me/proj

## Plan
<full updated plan file content>
BODY
)"

bit issue comment add 90 --body "Plan updated: dropped step 4 (premature optimization), added step 5b (metrics hook)."
```

Snapshot comment then references the change:

```bash
bit issue comment add 90 --body "$(cat <<'C'
Snapshot 2026-05-08T09:02:00Z:
- Plan revised (see Plan updated: above).
- Tasks unchanged.
- No new code yet for revised steps.
C
)"
```

## Example 3: Scope change reconciliation

Setup: while working on `#91` (Target Files: `src/cache/lru.ts`, `src/cache/eviction.ts`), the diff shows `src/utils/clock.ts` was modified too. No other open issue claims it.

```bash
bit issue list --open
# → #91 (self), #92 (self), #93 (other session, Target: src/api/routes.ts)

bit issue view 93
# Target Files don't include clock.ts → no overlap.
```

Add `src/utils/clock.ts` to `#91`:

```bash
bit issue view 91   # read-modify-write the body
bit issue update 91 --body "<revised body with clock.ts added under Target Files>"
bit issue comment add 91 --body "Target added: src/utils/clock.ts (modify) — needed deterministic time source for eviction tests."
```

If overlap **had** been detected (another session owned `clock.ts`), follow `start-work` §5 instead — exclude or coordinate with the user. `write-session` does not invent ownership.

## Example 4: Hook-fallback close

Setup: TaskList task_id 1 is `completed`, but bit issue `#91` is still open after the prior `TaskUpdate` (hook silently failed, e.g., async error in a previous session).

First, re-trigger via TaskUpdate to give the hook another chance:

```
TaskUpdate(task_id=1, status=completed)
```

If `#91` is still open after that:

```bash
bit issue comment add 91 --body "Progress: done — closed by write-session fallback (TaskCompleted hook did not fire)."
bit issue close 91
```

Pair the close with the comment so the audit trail explains why a manual close happened. Continue with parent snapshot afterwards.

## Example 5: Idempotent re-run

Setup: user runs write-session twice in five minutes with no intervening work.

First pass writes Progress + Snapshot as in Example 1.

Second pass:

- Plan file unchanged → no body rewrite.
- No new commits, no new touched files, no new decisions in conversation → skip `Progress:`.
- Last `Snapshot:` is < 5 min old and nothing changed → skip the new snapshot.

Report:

```
Nothing to checkpoint — parent #90 already up to date as of 2026-05-08T07:14:00Z.
```

This confirms the skill is idempotent: a checkpoint that finds no delta should produce no writes.

## Example 6: Pre-compaction checkpoint

Setup: agent notices conversation is approaching context limits (e.g., user mentioned compaction or many turns elapsed). Proactively checkpoint before earlier turns get summarized away.

Prioritize capturing the volatile inputs that compaction is likely to lose:

- Decisions taken in earlier turns → `Decision:` comments now, while the reasoning is still in context.
- Active blockers and their root cause analysis → `Blocker:` comments.
- Plan refinements that happened in chat but were never written back to the plan file → reflect in parent `## Plan` rewrite.

After compaction, `restoring-session` (or write-session itself in a future turn) can recover this content from bit issues even though the originating chat turns are gone.
