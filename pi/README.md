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
| `pi/extensions/codex-web`  | `~/.pi/agent/extensions/codex-web`  | dotfiles directory symlink |
| `claude/.claude/skills`    | `~/.agents/skills`                  | existing shared mapping    |
| `pi/skills`                | `~/.pi/agent/skills`                | selective symlink (fork 6) |

## Install

```bash
bun install --frozen-lockfile                           # reproducible local test baseline
bun install -g @earendil-works/pi-coding-agent@0.80.7  # initial known-good global install
bun run src/index.ts install                            # deploys the symlinks
pi                                                      # /login → provider of choice
bun run check:pi-compat                                 # compile + offline real-pi RPC smoke
bun run update:pi                                       # preflight, update, verify, auto-rollback
```

The exact versions in `package.json`/`bun.lock` are the **local development
baseline**, not a global-version allowlist. A newer global pi is accepted when
its public declarations compile the self-contained extensions and its real CLI
passes the isolated RPC probe. `check:pi-version` remains as a backward-
compatible alias for `check:pi-compat`.

Prefer `bun run update:pi` over raw `pi update`. It verifies the current install
before mutation, locks concurrent updates, runs pi's self-update with the
captured Bun installation, and checks the candidate. An incompatible candidate
is automatically reinstalled at the previous version and verified again.
Rollback is best-effort because Bun's registry/cache can be unavailable; a
recovery journal and exact manual command are retained when restoration fails.
The compatibility smoke uses temporary HOME/config/session directories, runs
no model turn/provider request, and never reads user auth or sessions.

Billing note (measured 2026-07-10): Claude Pro/Max OAuth from pi is billed as
**extra usage** (per token, not plan limits). ChatGPT Plus/Pro (Codex) OAuth
is the no-extra-cost alternative for evaluation.

## Extension architecture

The harness stays a single umbrella extension (`extensions/pi-harness/index.ts`)
composing compatibility features in a fixed order — permission-policy first
(safety floor, not toggleable), then hook-bridge and the rest. The narrowly
scoped `codex-web` extension is separate because it owns provider credentials
and network traffic rather than harness lifecycle compatibility. Harness
feature toggles live in `~/.pi/agent/pi-harness.local.json` (machine-local):

```json
{
  "features": {
    "statusline": false,
    "provider-log": false,
    "ask-user-question": true
  },
  "trustedRoots": ["/path/to/repo/you/trust"]
}
```

`trustedRoots` gates every feature that executes repository-defined commands
(formatter, lint/typecheck/test) — fail-closed, symlink-resolved.

Child pi processes spawned by subagent/workflow receive `PI_HARNESS_CHILD=1`
and keep only the safety layer (no recursion, no duplicate notifications).

The safety layer includes a default-on local Ollama fallback for Bash commands
that match no deterministic deny/allow/ask rule. It classifies a bounded JSON
envelope containing the command, raw current-turn task text, and locally
verified cwd/project/worktree context; it never receives expanded skills,
conversation history, repository contents, remotes, environment, or tool
results. One cumulative 250 ms local discovery deadline covers async child-env
sanitization, Git probing, registered-worktree/common-dir validation, and path
canonicalization before each fallback/cache lookup. Ambiguous task correlation
cannot reuse or populate the `ALLOW` cache, and ANSI-C shell words are fixed at
the deterministic ask floor. An unavailable judge asks in interactive sessions
and blocks in child/non-UI sessions; set `permissionJudge.enabled` to `false` for
the previous rule-only behavior. Existing broad explicit grants still bypass
the fallback by design. See
[`LOCAL_PERMISSION_JUDGE.md`](./LOCAL_PERMISSION_JUDGE.md) for setup,
configuration, data boundaries, and qualification steps.

An explicitly invoked `/skill:<name>` may pre-approve parent-session Bash
commands through its `allowed-tools` frontmatter. The permission policy records
the accepted interactive/RPC input before Pi expands it, then requires the
latest processed user message to exactly match that loaded `SKILL.md` and its
arguments. The run snapshots both the skill body and grants, so later
frontmatter edits cannot widen it. Pasted expansions and extension-generated
messages grant nothing. It recalculates grants at every provider context,
including queued prompts, and clears them when the run settles. Deterministic
deny/ask and shell-structure rules still take precedence; child profiles never
inherit grants. A skill's
`git -C` grant is additionally limited to a canonical registered non-bare
worktree that shares the active cwd's canonical Git common directory.

## Codex web tools

`extensions/codex-web` registers `web_search` and `web_fetch` for the current
OpenAI Codex model. Both make a bounded request to the fixed
`https://chatgpt.com/backend-api/codex/responses` endpoint using pi's existing
Codex login. Every outbound query, URL, and page question is shown for explicit
user approval first. The tools never switch models, trust a custom base URL,
fetch from the local network, read files, launch a browser/subprocess, or use
browser cookies.

`web_fetch` accepts one public HTTPS URL with a DNS hostname. It rejects URL
credentials, fragments, literal IPs, local/special-use hostnames, common
secret-bearing query parameters, and recognizable credential values. Retrieval
stays inside OpenAI's hosted `web_search` tool. Both tools require a completed
native search plus validated answer citations; `web_fetch` additionally
requires an exact citation for the requested HTTPS URL. They bound
stream/input/output sizes, event counts, and timeouts, retain no raw provider
events, and mark returned page text as untrusted evidence. Avoid
putting private data or signed URLs in either tool: queries and accepted URLs
are sent to OpenAI and consume Codex subscription limits.

The extension deliberately has no config file. Leave model choice with the
current pi session; switch to an OpenAI Codex model before calling the tools.

## Tool parameter schemas (tskm AOT)

Tool parameter schemas are authored in tskm under `pi/schemas/` and compiled
ahead-of-time to committed plain JSON Schema objects
(`features/*/parameters.generated.ts`). The extension imports those generated
objects relatively and has **no schema-library runtime dependency** (tskm is a
devDependency only; the direct typebox dependency was removed — typebox now
survives only transitively via pi). This keeps the extension self-contained
(`check:pi-imports`).

Workflow after editing any `pi/schemas/*.ts`:

```bash
bun run gen:pi-schemas     # regenerate the committed *.generated.ts
bun run check:pi-schemas   # drift gate: in-memory regen must match committed
```

`bun test` alone does NOT catch a source edit that forgot regeneration — the
`check:pi-schemas` drift gate (wired into `run-all`, before the mutating
`format`) is load-bearing for that. The drift gate only asserts
_regeneratability_; the _semantic_ contract (descriptions, required sets,
`maxItems`, object openness) is pinned separately by
`tests/pi-harness/schema-contract.test.ts` (equivalence to the pre-migration
typebox baseline + acceptance/rejection through pi's real `validateToolArguments`).

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
| AskUserQuestion                      | exact-name `AskUserQuestion` compatibility tool                              |
| Notification (asuku)                 | asuku-notify feature (`agent_settled`, detached)                             |
| permissions.deny / auto fallback     | permission-policy rules + local Ollama judge (fail-closed)                   |
| statusLine                           | statusline feature (Claude-equivalent custom footer)                         |
| logproxy                             | provider-log feature (opt-in, reduced scope)                                 |

Known gaps vs Claude Code: no Claude server-side auto mode (the local Ollama
judge plus deterministic rules approximates it), no LSP plugins, provider-log
is a request/status logger (not full logproxy).

## AskUserQuestion compatibility

The parent pi session registers an exact-name `AskUserQuestion` tool so shared
Claude-oriented skills can run unchanged with Codex or other pi models. It
accepts 1–4 single- or multi-select questions, 2–4 options per question,
optional `preview` text, and an automatic Other/notes path. Successful results
use Claude's question-keyed `answers` and `annotations` shape, including
selected previews and notes.

The adapter uses pi's `ui.select` / `ui.input`, so it works in TUI and RPC UI
modes without a runtime TUI dependency. Cancellation and abort fail the tool;
print/JSON modes report that interactive UI is unavailable. The feature is
default-on but can be disabled with `features.ask-user-question`; child pi
processes always disable it because they have no user-facing dialog. Call it
alone and wait for the answer before generating answer-dependent tool calls —
sequential execution cannot rewrite sibling calls already emitted by a model.

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

- [x] `bun run check:pi-baseline` passes (local lock/install integrity)
- [x] `bun run check:pi-compat` passes (global declarations + isolated RPC)
- [x] pi startup shows no pi-harness load errors
- [x] Phase 2: `npx prettier` blocked; `bit issue claim` blocked; "ultracode"
      prompt injects the codex mandate (verified 2026-07-10)
- [x] Phase 3: subagent tool runs a `~/.claude/agents` definition with
      `PI_HARNESS_CHILD=1` (nonce smoke, 2026-07-11)
- [x] Phase 4: workflow 2-task fan-out completes with degradation reporting;
      poc worktree auto-provisioned via gwq; workflow→codex-stage.sh
      roundtrip returns (2026-07-11)
- [x] Phase 5: statusline runner launches only for trusted roots (cache JSON
      written); custom footer mirrors Claude's repo/directory/branch/diff,
      checks, model, and remaining-context fields; provider-log stays off until
      opted in, JSONL 0700/0600 when on; asuku binary spawn path verified
- [x] Phase 6: pi-vocabulary `start-work` walks worktree_create → bit issue
      creation → task_completed close-verified on a real repo (2026-07-11);
      fork shadows the shared skill on name collision (V7 settled)
- [ ] TUI-only: Claude-equivalent custom footer renders in an interactive pi
      session (`session_start`); resident child browser Down/focus behavior and
      asuku toast visually confirmed after a pi update
- [ ] Anthropic-transport provider-log response records (once extra-usage
      balance exists)
