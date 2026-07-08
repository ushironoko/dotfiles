# The 4 principles you must follow

# 1. User Communications

Utilize `dig` skills for information gathering. Unearth information that users haven't fully articulated, incorporate it into the requirements, and refine it.

# 2. Critical Constraints

## All time requirements

- Regarding technology, always research and apply the latest best practices. Do not rely solely on your own knowledge to make decisions
- Before PlanExit, review the created plan file using the `plan-review` skill before showing it to the user
- Use `start-work` skill for non-trivial changes
- Specify exact versions: `module@5.5.1` (NOT `^5.0.0` or `@latest`)
- Commit to git until explicitly instructed by the user

## TypeScript Projects

- Check for lock files and use the appropriate package manager:
  - If `pnpm-lock.yaml` exists → use `pnpm`
  - If `bun.lock` exists → use `bun`
- Use es modules(Do not cjs)
- Use functional programming, e.g. Use function composition
- Do not use global state and singleton pattern
- Do not use classes
- Do not create `.d.ts` files
- Do not run development server startup commands in any workflow

# 3. Safety Rules for PRs and Commits (CRITICAL — Violations directly lead to data leak incidents)

## Absolute Rules for Creating PRs

- execute gh pr create before performing the following:
  1. Verify the target repository using gh repo view --json nameWithOwner
  2. In the case of a fork, confirm that the PR is directed to the user's own repository and not the upstream repository
  3. Present the target repository name and branch name to the user and obtain explicit approval before execution
- create a PR without user approval
- In a forked repository, explicitly specify the user's repository using gh pr create -R <owner/repo>

## Protection of Confidential Information in Commit Messages and PR Descriptions

These rules also apply to the content, examples, and comments within CLAUDE.md itself

- Do not Include the following in commit messages, PR descriptions, or CLAUDE.md:
  - Private repository names
  - Company names, organization names, team names, or client names
  - Specific project information such as project-specific names, file counts, or build statistics
  - Internal tool names or infrastructure information

# 4. Workflow Principles

- Always use `start-work` skill
- In ultracode workflow scripts, EVERY fan-out subagent defaults to codex (a non-Claude model family): `agentType: 'codex-reviewer'` for read-only review/verification fan-outs, `agentType: 'codex-poc'` (with `isolation: 'worktree'`) for competing implementation PoCs in isolated worktrees, `agentType: 'codex-runner'` for write-capable parallel workers you place yourself (main checkout or a subdirectory, no isolated-worktree requirement — you own their write-scope partitioning). Claude subagents are allowed ONLY as optional additions (+α) that the main (Claude) orchestrator adds at its own discretion — never as the mandatory baseline roster. The main agent itself (Claude) still orchestrates, synthesizes, and judges. All codex calls go through `~/.claude/hooks/lib/codex-stage.sh` (never pass `-m`). Templates: `~/.claude/skills/start-work/references/multi-model-workflows.md`
