# Codex harness

This is the Codex-native counterpart of `~/.claude/CLAUDE.md`. Communicate with
the user in Japanese unless they request another language.

## Required workflow

- Use the `dig` skill to uncover missing requirements when a plan is genuinely
  underspecified. Inspect the repository first; do not ask for facts that can be
  discovered locally.
- Use `plan-review` before presenting a non-trivial implementation plan.
- Use `start-work` before beginning non-trivial code changes.
- Research current technical guidance when it can have changed. Prefer primary
  and official sources.
- Pin exact dependency versions. Do not introduce ranges or `latest` unless the
  user explicitly requests them.
- Do not commit, push, or create a pull request without the user's explicit
  authorization.

## Claude-skill compatibility

The personal skills under `~/.agents/skills` are shared with Claude Code. When a
skill uses Claude-specific nouns, translate them to Codex as follows:

- `Agent`, `agent()`, or `subagent_type` means spawning the named Codex custom
  agent from `~/.codex/agents`.
- `Workflow` means Codex multi-agent orchestration: spawn bounded independent
  agents, wait for them, and synthesize their results in the parent thread.
- `TaskList`, `TaskCreate`, and `TaskUpdate` use the Codex plan mechanism for
  visible progress, but native plan items have no stable task id. Before
  creating each bit-backed task, allocate a stable compatibility id such as
  `codex-<session-seq>-<task-seq>`, record it in the plan item, and embed the
  same id in the bit issue title. After the parent has verified successful
  completion, update the plan and explicitly run
  `bash ~/.codex/hooks/task_completed/bit_issue_update.sh <compat-id> <subject>`.
  Never infer completion from `SubagentStop` or an `agent_id`.
- For `EnterWorktree`, prefer a native Worktree task or Handoff when the current
  Codex surface supports it. A running local session cannot change its sandbox
  root: the explicit `hooks/worktree/create.sh` adapter only creates and records
  a worktree. After it returns a path, continue writes only from a Codex task
  opened with that worktree as its actual workspace. Prefer native Codex cleanup.
  Before explicit adapter removal, obtain user approval and pass
  `{"worktree_path":"...","confirmed":true}` to
  `bash ~/.codex/hooks/worktree/remove.sh`; it only removes clean,
  harness-created linked worktrees.
- `AskUserQuestion` means asking a concise blocking question through the current
  Codex surface. `PlanExit` means returning the reviewed plan to the user.
- A manual Claude `/compact` instruction means the corresponding Codex compact
  action; never pretend a slash command ran when the current surface cannot run
  it.

Imported agent names `codex-reviewer`, `codex-poc`, and `codex-runner` are
compatibility names for native Codex roles. They provide fresh context and
specialization, but they are not a different model family. Never describe their
output as cross-model evidence. If the user explicitly requires cross-model
review, use an actually different provider or report that this extra guarantee
is unavailable.

## Subagent policy

- Use `codex-reviewer` for read-only plan, design, diff, and verification work.
- Use `codex-poc` only in an explicitly supplied isolated linked worktree. It
  must refuse the main checkout and must not commit or merge.
- Use `codex-runner` for bounded write work whose target files or directory are
  explicitly partitioned by the parent. It must not commit or overlap another
  writer's scope.
- Use `rust-reviewer`, `tdd-reviewer`, `comment-reviewer`, and `similarity` for
  their documented specialist lenses.
- Parallelize independent read-heavy work. For write-heavy work, partition paths
  first and treat the parent's aggregate diff as authoritative.
- Mystery audit/reader workflows may require more agents than the concurrency
  cap. Run them in batches while preserving independent contexts and spoiler
  boundaries.

## TypeScript projects

- If `pnpm-lock.yaml` exists, use pnpm. Otherwise, if `bun.lock` or `bun.lockb`
  exists, use Bun.
- Use ESM and functional composition. Avoid classes, global mutable state, and
  singleton patterns.
- Do not create `.d.ts` files.
- Do not start a development server unless the user explicitly asks for it.

## Pull requests and confidential information

Before `gh pr create`:

1. Run `gh repo view --json nameWithOwner`.
2. Determine whether the checkout is a fork and ensure the target is the user's
   repository rather than an upstream repository.
3. Show the repository and branch to the user and obtain explicit approval.
4. For a fork, pass `-R <owner/repo>` explicitly.

Never put private repository names, organization/client names, internal project
details, or infrastructure identifiers in commit messages, PR descriptions, or
durable instruction files.

## Harness lifecycle gaps

Codex supports the shared pre/post tool, permission, session, prompt, subagent,
and stop hooks. It does not expose Claude's `Notification`, `TaskCompleted`,
`WorktreeCreate`, or `WorktreeRemove` events directly. This harness maps
notification to `Stop` and uses the verified explicit task/worktree commands
above for the remaining lifecycle actions. `SubagentStop` is deliberately not
treated as successful task completion because it also covers interrupted or
failed agents.
