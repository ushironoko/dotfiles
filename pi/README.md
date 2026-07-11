# pi harness

Side-by-side port of the Claude Code / Codex harness to
[earendil-works/pi](https://github.com/earendil-works/pi), deployed as child
links only (never replacing `~/.pi/agent`, which stays machine-local:
auth.json, settings.json, sessions).

Plan and review record: `plans/eventual-questing-deer.md`, bit issue
`[plan:feat/pi-harness#1]`. Phase 0 measurements (event payloads, billing,
child-process behavior): `tests/fixtures/pi-harness/raw/`.

## Layout

| Repo path                  | Deployed to                         | Mechanism                  |
| -------------------------- | ----------------------------------- | -------------------------- |
| `pi/extensions/pi-harness` | `~/.pi/agent/extensions/pi-harness` | dotfiles directory symlink |
| `claude/.claude/skills`    | `~/.agents/skills`                  | existing shared mapping    |
| `pi/skills`                | `~/.pi/agent/skills`                | selective symlink (fork 6) |

## Install

```bash
bun install -g @earendil-works/pi-coding-agent@0.80.6   # keep in sync with package.json pin
bun run src/index.ts install                            # deploys the symlinks
pi                                                      # /login → provider of choice
bun run check:pi-version                                # host smoke: pin matches binary
```

Billing note (measured 2026-07-10): Claude Pro/Max OAuth from pi is billed as
**extra usage** (per token, not plan limits). ChatGPT Plus/Pro (Codex) OAuth
is the no-extra-cost alternative for evaluation.

## Extension architecture

Single umbrella extension (`extensions/pi-harness/index.ts`) composing
features in a fixed order — permission-policy first (safety floor, not
toggleable), then hook-bridge and the rest. Feature toggles live in
`~/.pi/agent/pi-harness.local.json` (machine-local):

```json
{
  "features": { "statusline": false, "provider-log": false },
  "trustedRoots": ["/path/to/repo/you/trust"]
}
```

`trustedRoots` gates every feature that executes repository-defined commands
(formatter, lint/typecheck/test) — fail-closed, symlink-resolved.

Child pi processes spawned by subagent/workflow receive `PI_HARNESS_CHILD=1`
and keep only the safety layer (no recursion, no duplicate notifications).

## Claude hook lifecycle mapping

| Claude Code                          | pi-harness                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| PreToolUse (Bash matcher)            | `tool_call` via hook-bridge                                                  |
| PreToolUse (Workflow matcher)        | `tool_call` — plan serialized into `script` so codex_stage_guard can grep it |
| PostToolUse (Write\|Edit\|MultiEdit) | `tool_result` via hook-bridge (trust-gated)                                  |
| UserPromptSubmit                     | `before_agent_start` message injection                                       |
| SessionStart / Stop                  | `session_start` / `agent_settled`                                            |
| Task tool (subagents)                | `subagent` tool (single / parallel / chain)                                  |
| Workflow tool (ultracode)            | `workflow` tool (declarative JSON plan)                                      |
| TaskCompleted                        | `task_completed` tool (bit-task, codex-side hook)                            |
| WorktreeCreate / WorktreeRemove      | `worktree_create` / `worktree_remove` tools                                  |
| Notification (asuku)                 | asuku-notify feature (`agent_settled`, detached)                             |
| permissions.deny                     | permission-policy rules (fail-closed)                                        |
| statusLine                           | statusline feature (`setWidget`)                                             |
| logproxy                             | provider-log feature (opt-in, reduced scope)                                 |

Known gaps vs Claude Code: no auto mode (server-side classifier is Claude
Code-only; rule-based policy approximates it), no LSP plugins, provider-log
is a request/status logger (not full logproxy).

## workflow tool (ultracode equivalent)

Declarative JSON plan; the engine enforces the multi-model ground rules in
code (`features/workflow/plan.ts` is authoritative; the codex_stage_guard
hook is advisory):

- Fan-out stages without `codexSkip: true` must keep a codex-family baseline
  (`codex-reviewer` / `codex-runner` / `codex-poc`); missing `agentType`
  defaults to `codex-reviewer`. Claude tasks ride along as +α only.
- `codex-poc` requires `isolation: "worktree"`; the engine provisions a
  validated linked worktree per task (bit-task creator, S1 postconditions)
  and leaves it in place — no auto merge, no auto remove.
- Parallel `codex-runner` tasks must declare disjoint `writeScope`s.
- A failing task degrades the stage (reported as FAILED) instead of aborting
  the workflow — synthesis/judging stays with the parent agent.

Templates: `pi/skills/start-work/references/multi-model-workflows.md`.

## Skills (fork 6)

`start-work` / `write-session` / `restoring-session` / `plan-review` / `dig`
/ `smart-compact` are forked into `pi/skills/` with pi vocabulary
(worktree_create / task_completed / subagent / workflow tools instead of
Claude hooks and Task tools). The remaining shared skills arrive via
`~/.agents/skills` unchanged.

Collision behavior (pi 0.80.6, docs/skills.md): discovery scans
`~/.pi/agent/skills` before `~/.agents/skills` and keeps the **first** skill
on a name collision, so the forks shadow the Claude versions for pi. pi may
log a duplicate-name warning at startup — expected.

## provider-log scope (V10, measured 2026-07-11)

`before_provider_request` fires and carries the payload (model captured on
the openai-codex provider). `after_provider_response` **did not fire on the
openai-codex transport** — pi docs: providers that abstract HTTP responses
may not expose status/headers. Anthropic-transport verification pending
(blocked on extra-usage balance). Records store sha256 + metadata only; log
dir `~/.pi/agent/pi-harness/logs` (0700/0600, daily rotation, 14-day
retention).

## Smoke checklist

Automated coverage lives in `tests/pi-harness/` + `tests/hooks/pi-harness/`
(`bun test`). Host-dependent checks:

- [x] `bun run check:pi-version` passes
- [x] pi startup shows no pi-harness load errors
- [x] Phase 2: `npx prettier` blocked; `bit issue claim` blocked; "ultracode"
      prompt injects the codex mandate (verified 2026-07-10)
- [x] Phase 3: subagent tool runs a `~/.claude/agents` definition with
      `PI_HARNESS_CHILD=1` (nonce smoke, 2026-07-11)
- [x] Phase 4: workflow 2-task fan-out completes with degradation reporting;
      poc worktree auto-provisioned via gwq; workflow→codex-stage.sh
      roundtrip returns (2026-07-11)
- [x] Phase 5: statusline runner launches only for trusted roots (cache JSON
      written); provider-log stays off until opted in, JSONL 0700/0600 when
      on; asuku binary spawn path verified
- [x] Phase 6: pi-vocabulary `start-work` walks worktree_create → bit issue
      creation → task_completed close-verified on a real repo (2026-07-11);
      fork shadows the shared skill on name collision (V7 settled)
- [ ] TUI-only: status widget renders in an interactive pi session
      (`session_start`); asuku toast visually confirmed
- [ ] Anthropic-transport provider-log response records (once extra-usage
      balance exists)
