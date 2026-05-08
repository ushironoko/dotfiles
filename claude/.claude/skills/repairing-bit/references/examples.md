# Worked Examples — repairing-bit

Concrete restoration walk-throughs. Read on demand from `SKILL.md`.

## Example 1: Single-parent active session restore

Setup: branch `feat/payments`, prior session interrupted with parent issue and 3 task issues (1 already closed, 2 open).

```bash
git branch --show-current
# → feat/payments

bit issue list --open --label "session:feat/payments"
# → #42 [plan:feat/payments#1] Add Stripe checkout flow
# → #44 [task:feat/payments#1:t_abc] Wire up webhook handler
# → #45 [task:feat/payments#1:t_def] Add idempotency keys

bit issue view 42
# Plan body extracted: 5-step plan, worktree at /Users/me/wt/payments
```

For each open task issue:

```bash
bit issue view 44
# Body:
# parent: #42
# ## Target Files
# - src/webhook/stripe.ts (modify)
# - src/webhook/types.ts  (create)
# ## Task Description
# Implement webhook signature verification and event dispatch.

bit issue view 45
# Body:
# parent: #42
# ## Target Files
# - src/webhook/idempotency.ts (create)
# - src/webhook/stripe.ts (modify)
# ## Task Description
# Persist idempotency keys to prevent duplicate event processing.
```

Report to user:

```
Restored session: feat/payments (parent #42, seq 1)
  Plan: Add Stripe checkout flow
  Worktree: /Users/me/wt/payments
  Open tasks: 2 (1 already completed)

  [#44] Wire up webhook handler
    targets: src/webhook/stripe.ts (modify), src/webhook/types.ts (create)
  [#45] Add idempotency keys
    targets: src/webhook/idempotency.ts (create), src/webhook/stripe.ts (modify)
```

Restore via `TaskCreate`:

```
TaskCreate(subject="Wire up webhook handler", description="...")  → returns task_id "1"
TaskCreate(subject="Add idempotency keys",    description="...")  → returns task_id "2"
```

Re-link bit issues to the new task ids:

```bash
bit issue update 44 --title "[task:feat/payments#1:1] Wire up webhook handler"
bit issue comment add 44 --body "Re-linked: task_id t_abc → 1 on session restore"

bit issue update 45 --title "[task:feat/payments#1:2] Add idempotency keys"
bit issue comment add 45 --body "Re-linked: task_id t_def → 2 on session restore"
```

## Example 2: No active parent — recent history report only

Setup: branch `main`, no open `[plan:...]` issues.

```bash
bit issue list --open
# → No issues

bit issue list --closed --limit 5
# → #38 [plan:fix/race-cond#1]   Fix metrics race
# → #37 [task:fix/race-cond#1:5] Add mutex around counter
# → #36 [task:fix/race-cond#1:4] Add regression test
```

Inspect each:

```bash
bit issue view 38
bit issue comment list 38
# Last comment: "Done: shipped in PR #112"
```

Report:

```
No active session for branch `main`.
Recent activity (last 5 closed):
  #38 [plan:fix/race-cond#1] Fix metrics race — closed, shipped in PR #112
  #37 task: Add mutex around counter — closed
  #36 task: Add regression test — closed
No tasks restored. Run /start-work for new work.
```

Stop. Do not fabricate tasks.

## Example 3: Orphan task issue (parent missing or closed)

Setup: open task issue `#51` whose `parent: #50` was closed manually.

```bash
bit issue list --open
# → #51 [task:exp/cleanup#2:t_xyz] Remove dead config flag

bit issue view 51
# parent: #50
bit issue view 50
# (closed)
```

Report:

```
Found 1 orphan task issue:
  [#51] Remove dead config flag (parent #50 is closed)

Options:
  1. Restore as standalone task (will not auto-close on TaskCompleted hook unless re-linked).
  2. Reopen parent #50 if work is resumable.
  3. Close #51 if obsolete.

Awaiting user direction.
```

Pause for user input before any side effect.

## Example 4: Multiple parents on same branch

Setup: two open `[plan:feat/auth#...]` issues exist (seq 2 and seq 3).

```bash
bit issue list --open --label "session:feat/auth"
# → #60 [plan:feat/auth#2] Refactor token store
# → #71 [plan:feat/auth#3] Add OAuth provider
```

Report:

```
Multiple open sessions on `feat/auth`:
  [#60] seq 2 — Refactor token store (worktree: /Users/me/wt/auth-2)
  [#71] seq 3 — Add OAuth provider   (worktree: /Users/me/wt/auth-3)

Which session should I restore? (60 / 71)
```

Wait for user choice. Restore only the chosen one's task tree.

## Example 5: Malformed parent body

Setup: parent issue body is missing the `## Plan` section (e.g., manual edit gone wrong).

```bash
bit issue view 80
# Body has Session Info but no Plan section.
```

Report what is recoverable:

```
Restored session: feat/cache#1 (parent #80)
  Worktree: /Users/me/wt/cache
  ⚠ Plan section missing from parent body — only Session Info recovered.

Open tasks: 1
  [#81] Wire LRU eviction
    targets: src/cache/lru.ts (create)

Proceeding with task restore. Plan context unavailable; refer to git log if needed.
```

Continue with task restoration but flag the gap.
