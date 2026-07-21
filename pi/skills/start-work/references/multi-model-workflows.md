# Multi-Model Workflow Plans (codex-default, Claude +α)

Plan templates for the pi-harness `workflow` tool, where OpenAI codex (a
non-Claude model family) is the DEFAULT for every fan-out task. Claude tasks
appear ONLY as optional additions (+α) that you — the parent agent — add at
your own discretion; you still orchestrate, synthesize, and judge. Three plan
shapes:

1. **Codex-default review fan-out** — every reviewer is `codex-reviewer`; lens
   diversity comes from codex `prompt` mode. Optional Claude lenses are +α.
2. **Competing codex PoCs** — several `codex-poc` tasks implement the same spec
   with different approaches, each in an engine-provisioned isolated worktree;
   each diff is reviewed and the parent agent judges. An optional Claude PoC
   is +α.
3. **Parallel codex-runner writes** — several `codex-runner` tasks each perform
   a write task in a directory you place them in (the main checkout or a
   subdirectory), with engine-validated disjoint `writeScope`s; the aggregate
   diff is then reviewed. Use this when the work is a set of independent edits
   rather than competing whole-spec PoCs.

## Plan shape

The `workflow` tool takes one declarative JSON plan. It immediately returns an
acceptance result with an invocation ID; the staged result arrives later in an
automatic background-completion message. Never synthesize or judge from the
acceptance text.

```jsonc
// Shape reference (not a runnable plan — "a | b" marks the allowed values)
{
  "stages": [
    {
      "mode": "fanout | single",
      "name": "optional stage name",
      "codexSkip": false,
      "tasks": [
        {
          "agentType": "codex-reviewer | codex-poc | codex-runner | <claude-family>",
          "task": "full task prompt",
          "cwd": "/optional/absolute/working/dir",
          "isolation": "worktree",
          "writeScope": ["path", "..."],
        },
      ],
    },
  ],
}
```

Agent definitions come from `~/.claude/agents/*.md` — `codex-reviewer`,
`codex-poc`, and `codex-runner` are defined there and internally invoke
`~/.claude/hooks/lib/codex-stage.sh`.

## Engine-enforced rules

The plan validator rejects violations — these are contracts, not advice:

- Stages run sequentially. Fan-out tasks within a stage run 4-concurrent.
  Max 8 tasks per stage, max 8 stages.
- A fan-out task without `agentType` defaults to `codex-reviewer`.
- A fan-out stage whose roster contains no codex-family task
  (`codex-reviewer` / `codex-runner` / `codex-poc`) is REJECTED unless the
  stage sets `"codexSkip": true`. That flag is an explicit user opt-out — set
  it only when the USER asked to omit codex. Claude-family tasks are allowed
  only alongside a codex baseline (+α), never as the roster by themselves.
- `agentType: "codex-poc"` REQUIRES `"isolation": "worktree"`. The engine
  auto-provisions a dedicated linked worktree per such task and assigns it as
  that task's cwd — `cwd` cannot be set manually together with `isolation`.
  Created worktrees are reported and left in place; the engine never merges or
  auto-removes them.
- Two or more `codex-runner` tasks in one fan-out stage must EACH declare
  `writeScope`, all in one path style (all relative or all absolute), pairwise
  non-overlapping.
- A failing task degrades its stage (the stage is reported as FAILED) instead
  of aborting the workflow. Synthesis and judging over the reported results
  are the PARENT agent's job: do them yourself after the automatic
  background-completion message arrives. A
  `"mode": "single"` stage is NOT a parent stand-in — it spawns an agent like
  any other task and requires an explicit `agentType` naming an existing
  `~/.claude/agents/*.md` definition (the validator rejects single-mode tasks
  without one).
- A task's `task` string may contain the reserved placeholder `{previous}`.
  At run time the engine replaces every `{previous}` with a digest of ALL
  already-completed stages, in declaration order, including failed tasks and
  any created worktree absolute paths — so a later review stage can read the
  paths a prior implement stage produced WITHOUT a second `workflow` call.
  First-stage tasks expand it to `(no prior stages)`. The digest is fenced as
  untrusted reference data (not instructions) and is size-capped, so with many
  prior tasks the tail may be truncated. `{previous}` is a reserved token with
  no literal escape. Tasks in the same stage never see each other's output —
  only completed prior stages.
- Child pi processes do NOT inherit the parent session's model. An agent
  whose frontmatter has no `model:` key runs on pi's GLOBAL default model —
  which may be a different provider entirely. Any agent whose family matters
  (e.g. a Claude +α lens) must pin `model: <provider>/<model-id>` in its
  frontmatter.

## Ground rules you still own

Enforced by the codex wrapper and by your task prompts, not by the plan
validator:

- All codex invocations go through `~/.claude/hooks/lib/codex-stage.sh`
  (auth preflight, portable timeout, `--ephemeral` for parallel safety, never
  `-m` — `~/.codex/config.toml` owns model selection).
- Reviewer `prompt` commands in non-interactive children must match the
  deterministic permission contract:
  - For a short literal prompt, use
    `printf '%s' '<instruction>' | ~/.claude/hooks/lib/codex-stage.sh prompt --timeout 600`
    from the desired cwd, or add one properly shell-quoted literal
    `--dir '/literal/absolute path'` argument.
  - For a large prompt or artifact, first use the explicitly allowed
    `bun -e`/`node:fs/promises` `mkdtemp` command from `codex-reviewer.md` to
    allocate an exclusive mode-`0700` `/tmp/codex-reviewer-*` directory. Paste
    the printed path literally (never through shell expansion), use the `write`
    tool to create its `prompt.md`, and pipe only the short literal instruction
    `Read /tmp/.../prompt.md completely and follow it exactly.` through the same
    command. Clean up the private directory afterward with the documented
    literal-path `bun -e` removal command.
  - Never use a heredoc, here-string, input redirection, `--dir "$PWD"`, a
    shell variable, or command substitution. Do not replace the wrapper with a
    direct `codex` fallback.
- For codex reviewer lens diversity use `prompt` mode (a focused prompt on
  stdin); `review` mode is a single holistic diff pass and takes no focus, so
  use it at most once per fan-out stage.
- The wrapper refuses (exit 14) to run `poc` workspace-write against anything
  but an isolated worktree — the engine's worktree provisioning satisfies
  this; never try to point a `codex-poc` at the main checkout.
- `codex-runner` write confinement is codex-sandbox-enforced (writable root =
  the `--dir` target), so it depends on `~/.codex/config.toml` not widening
  `writable_roots`. The engine validates that declared `writeScope`s are
  disjoint, but the wrapper does not lock the tree — keep each task prompt
  explicit about touching only its own scope. Changes stay uncommitted; never
  auto-commit or merge. The wrapper's post-run summary is repo-wide, so under
  parallel same-checkout runs only the aggregate review is authoritative
  (per-runner diffstats overlap).
- Never auto-merge a PoC diff; it stays in its worktree for a human decision.
- Degrade gracefully on rate limits: the wrapper retries rate-limited runs
  with backoff (`--retry`, default 1) and exits 15 when exhausted. The engine
  already reports such a task as FAILED without aborting the workflow —
  proceed with whatever results you have and state the coverage gap in the
  synthesis.
- To add a Claude +α task to a fan-out stage, append a task whose `agentType`
  names an existing `~/.claude/agents/*.md` definition with a pinned
  Claude-family `model:` — only when a same-family lens adds value codex
  can't (e.g. a cross-model Claude review of a codex PoC). The codex baseline
  must remain in the roster.
- Cross-model vs fresh-context: a review is _cross-model_ only when the
  reviewer's family differs from the author's (Claude parent + codex reviewers,
  or a Claude lens over a codex PoC). Same-family review (codex parent + codex
  reviewers, or a Claude lens over Claude work) is _fresh-context_ — it catches
  context/anchoring bias, not model-family blind spots. Since a `model:`-less
  agent runs on pi's global default, do not assume cross-model coverage from the
  roster alone; pin `model:` where family matters and label the coverage you
  actually obtained in the synthesis.

## Template A: codex-default review fan-out

Every reviewer is codex; you synthesize after the automatic background-
completion message arrives, not after the immediate acceptance result. Replace
`<REPO>` with the concrete absolute path to the repo or worktree under review
before submitting the plan. Replace the entire `'<REPO>'` token with that path
properly shell-quoted as one literal `--dir` argument; the child must not
substitute `$PWD`, a shell variable, or `$(...)`.

```json
{
  "stages": [
    {
      "mode": "fanout",
      "name": "review",
      "tasks": [
        {
          "agentType": "codex-reviewer",
          "task": "Holistically review the uncommitted changes in <REPO>. Run: ~/.claude/hooks/lib/codex-stage.sh review --uncommitted --dir '<REPO>' (Bash timeout 600000 ms). Report codex's findings faithfully, each with severity (Critical|High|Medium|Low), file:line, problem, and suggestion. Label the report reviewer=codex:holistic."
        },
        {
          "agentType": "codex-reviewer",
          "task": "Review the uncommitted changes in <REPO> for CORRECTNESS BUGS only. Run codex in prompt mode: printf '%s' 'Read the uncommitted diff (git diff) in this repository and report ONLY correctness bugs — logic errors, missing cases, broken invariants, off-by-one — each with file:line.' | ~/.claude/hooks/lib/codex-stage.sh prompt --dir '<REPO>' --timeout 600 (Bash timeout 600000 ms). Label the report reviewer=codex:correctness."
        },
        {
          "agentType": "codex-reviewer",
          "task": "Review the uncommitted changes in <REPO> for CONVENTION VIOLATIONS and risky patterns only. Run codex in prompt mode: printf '%s' 'Read the uncommitted diff (git diff) in this repository and report ONLY convention violations and risky patterns, each with file:line.' | ~/.claude/hooks/lib/codex-stage.sh prompt --dir '<REPO>' --timeout 600 (Bash timeout 600000 ms). Label the report reviewer=codex:conventions."
        }
      ]
    }
  ]
}
```

After the automatic background-completion message arrives, synthesize the
reported results yourself: rank
cross-lens DISAGREEMENTS first (issues one lens found and the others missed),
then agreements by severity. If any reviewer task was reported FAILED (e.g.
rate-limited), state the coverage gap explicitly. Synthesis is the parent's
role — do not delegate it to a plan stage.

To add a Claude +α lens, append one more task to the fan-out roster (the
codex baseline stays). The `agentType` must name an existing
`~/.claude/agents/*.md` definition whose frontmatter PINS a Claude-family
model (child pi processes do not inherit the parent's model; an unpinned
agent runs on the global default provider):

```json
{
  "agentType": "<your-claude-lens-agent>",
  "task": "Review the uncommitted changes in <REPO> through a <domain> lens only. Report each finding with severity and file:line. Label the report reviewer=claude:<lens>."
}
```

## Template B: competing codex PoCs

Each `codex-poc` task gets its own engine-provisioned isolated worktree (do
not set `cwd` on these tasks). Give each PoC a DIFFERENT approach angle.
Replace `<SPEC>` with the implementation spec (goal, constraints, files,
verification).

```json
{
  "stages": [
    {
      "mode": "fanout",
      "name": "implement",
      "tasks": [
        {
          "agentType": "codex-poc",
          "isolation": "worktree",
          "task": "Delegate this spec to codex: <SPEC>. Approach guidance: prefer the smallest, most direct change. Your cwd is an isolated worktree — follow your Execution Flow (codex-stage.sh poc). Report builder=codex:direct, the worktree absolute path (git rev-parse --show-toplevel), a summary, and git diff --stat."
        },
        {
          "agentType": "codex-poc",
          "isolation": "worktree",
          "task": "Delegate this spec to codex: <SPEC>. Approach guidance: prefer the most robust, defensively-validated design. Your cwd is an isolated worktree — follow your Execution Flow (codex-stage.sh poc). Report builder=codex:robust, the worktree absolute path (git rev-parse --show-toplevel), a summary, and git diff --stat."
        }
      ]
    },
    {
      "mode": "fanout",
      "name": "review",
      "tasks": [
        {
          "agentType": "codex-reviewer",
          "task": "The implement stage's PoC reports (with each builder's worktree absolute path) follow:\n{previous}\nReview the PoC labeled builder=codex:direct: find its worktree absolute path in the reports above, then run: ~/.claude/hooks/lib/codex-stage.sh review --uncommitted --dir '<that worktree>' (Bash timeout 600000 ms). Report findings with severity and file:line; note builder=codex:direct."
        },
        {
          "agentType": "codex-reviewer",
          "task": "The implement stage's PoC reports (with each builder's worktree absolute path) follow:\n{previous}\nReview the PoC labeled builder=codex:robust: find its worktree absolute path in the reports above, then run: ~/.claude/hooks/lib/codex-stage.sh review --uncommitted --dir '<that worktree>' (Bash timeout 600000 ms). Report findings with severity and file:line; note builder=codex:robust."
        }
      ]
    }
  ]
}
```

Judge the outcome yourself after the automatic background-completion message
arrives: recommend ONE PoC to adopt
(with required fixes) and say what to graft from the losers. NEVER merge
anything — each diff stays in its worktree for a human decision; list the
worktree absolute paths in the verdict. Judging is the parent's role — do not
delegate it to a plan stage.

The PoC worktree paths are engine-assigned and unknown when you write the plan,
so the review tasks reference them through `{previous}` — the engine splices the
implement stage's reports (including each worktree absolute path) into the
review prompts at run time. The reviewer must copy the selected concrete path
as one properly shell-quoted literal `--dir '/absolute path'` argument, never
through a shell variable or substitution. This keeps the implement→review flow
in a single `workflow` call.

An optional Claude PoC is +α: append to the implement roster a Claude-family
task with `"isolation": "worktree"` — the codex PoCs remain the mandatory
baseline. A Claude review of a codex PoC is likewise a discretionary +α in the
review stage (cross-model coverage).

## Template C: parallel codex-runner writes

Independent write tasks in the SAME checkout; you place each runner (`cwd`)
and declare its `writeScope`. With two or more runners in one stage, every
runner must declare `writeScope`, all in one path style (here: all relative),
pairwise non-overlapping — the engine rejects the plan otherwise. Replace
`<REPO>` with the absolute path to the repo or worktree the runners write
into.

```json
{
  "stages": [
    {
      "mode": "fanout",
      "name": "write",
      "tasks": [
        {
          "agentType": "codex-runner",
          "cwd": "<REPO>/packages/a",
          "writeScope": ["packages/a"],
          "task": "Delegate this write task to codex, scoped to <REPO>/packages/a (--dir). Touch ONLY files under packages/a; do not write outside it. Spec: <what to create/modify under packages/a, and how to verify>. Run: ~/.claude/hooks/lib/codex-stage.sh run --dir '<REPO>/packages/a' --timeout 600 (task on stdin; Bash timeout 600000 ms). Report codex's summary, git diff --stat, and status (complete or incomplete)."
        },
        {
          "agentType": "codex-runner",
          "cwd": "<REPO>/packages/b",
          "writeScope": ["packages/b"],
          "task": "Delegate this write task to codex, scoped to <REPO>/packages/b (--dir). Touch ONLY files under packages/b; do not write outside it. Spec: <what to create/modify under packages/b, and how to verify>. Run: ~/.claude/hooks/lib/codex-stage.sh run --dir '<REPO>/packages/b' --timeout 600 (task on stdin; Bash timeout 600000 ms). Report codex's summary, git diff --stat, and status (complete or incomplete)."
        }
      ]
    },
    {
      "mode": "fanout",
      "name": "review",
      "tasks": [
        {
          "agentType": "codex-reviewer",
          "task": "Review the aggregate uncommitted changes in <REPO>. Run: ~/.claude/hooks/lib/codex-stage.sh review --uncommitted --dir '<REPO>' (Bash timeout 600000 ms). This aggregate review is the authoritative view of the parallel writes (per-runner diffstats overlap). Report findings with severity and file:line."
        }
      ]
    }
  ]
}
```

Stages are barriers, so the review stage starts only after ALL writes finished
— exactly what an aggregate review needs. Point each runner's `cwd` / `--dir`
at its own subdirectory when possible: that confinement is
codex-sandbox-enforced (writable root = the `--dir` target). Nothing is
committed — you decide what to keep from the aggregate diff.

## Wrapper quick reference

Permission-safe reviewer prompt input:

```bash
# Desired cwd is already active: omit --dir so both pipeline segments are explicit allows.
printf '%s' 'Review the uncommitted diff for correctness bugs only.' |
  ~/.claude/hooks/lib/codex-stage.sh prompt --timeout 600

# A different cwd: replace the example with one shell-quoted literal absolute path.
printf '%s' 'Review the uncommitted diff for correctness bugs only.' |
  ~/.claude/hooks/lib/codex-stage.sh prompt --dir '/literal/absolute path' --timeout 600
```

For a large artifact, first allocate the private directory with the documented
`mkdtemp` command, write its `prompt.md`, and change the literal instruction to
`Read /tmp/codex-reviewer-a1B2C3/prompt.md completely and follow it exactly.`
The `codex-reviewer` agent definition contains the matching literal-path cleanup
command.

```bash
~/.claude/hooks/lib/codex-stage.sh review [--uncommitted | --base <branch> | --commit <sha>] --dir <abs> [--timeout <sec>]
~/.claude/hooks/lib/codex-stage.sh prompt [--dir <abs>] [--timeout <sec>]   # prompt on stdin, read-only
~/.claude/hooks/lib/codex-stage.sh poc --worktree <abs> [--timeout <sec>] [--network]   # spec on stdin, workspace-write, isolated worktree only
~/.claude/hooks/lib/codex-stage.sh run --dir <abs> [--timeout <sec>] [--network]   # task on stdin, workspace-write, main checkout or subdir allowed (no --out)
```

All modes also accept `--retry <n>` / `--retry-wait <sec>` (rate-limit backoff;
defaults 1 / 30).

Exit codes: 0 ok / 11 codex missing / 12 unauthenticated (`codex login`) /
13 usage (also `run`'s non-git-work-tree target) / 14 not an isolated worktree
(`poc`) / 15 rate limited (retryable) / 124 timed out. Any other non-zero code
is codex's own, passed through.
