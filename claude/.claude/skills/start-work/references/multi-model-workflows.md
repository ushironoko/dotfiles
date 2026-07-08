# Multi-Model Workflow Templates (codex-default, Claude +α)

Templates for ultracode Workflow scripts where OpenAI codex (a non-Claude model
family) is the DEFAULT for every fan-out subagent. Claude subagents appear ONLY
as optional additions (+α) the main (Claude) orchestrator adds at its own
discretion; the main agent still orchestrates, synthesizes, and judges. Three
integration shapes:

1. **Codex-default review fan-out** — every reviewer is `codex-reviewer`; lens
   diversity comes from codex `prompt` mode. Optional Claude lenses are +α.
2. **Competing codex PoCs** — several `codex-poc` agents implement the same spec
   with different approaches, each in its own isolated worktree; each diff is
   reviewed and the main Claude agent judges. An optional Claude PoC is +α.
3. **Parallel codex-runner writes** — several `codex-runner` agents each perform
   a write task in a directory you place them in (the main checkout or a
   subdirectory, no isolated-worktree requirement), scoped to non-overlapping
   paths; the aggregate diff is then reviewed. Use this when the work is a set of
   independent edits rather than competing whole-spec PoCs.

Ground rules baked into these templates:

- All codex invocations go through `~/.claude/hooks/lib/codex-stage.sh`
  (auth preflight, portable timeout, `--ephemeral` for parallel safety,
  never `-m` — `~/.codex/config.toml` owns model selection).
- `codex-poc` must run paired with `isolation: 'worktree'` — the wrapper
  refuses (exit 14) to run workspace-write against a main repository checkout.
  Each parallel `codex-poc` gets its own isolated worktree.
- `codex-runner` is the write-capable fan-out WITHOUT the worktree requirement:
  `codex-stage.sh run --dir <abs>` runs workspace-write in a directory you place
  it in (the main checkout or a subdirectory, which must be a git work tree). The
  wrapper does NOT lock the tree — when you run several in parallel you MUST
  partition their write scope (distinct files/dirs) yourself, or concurrent
  writes to the same path corrupt it. Changes stay uncommitted; never
  auto-commit or merge. Point a runner at a subdirectory to confine its writes —
  that confinement is codex-sandbox-enforced (writable root = the `-C` dir), so
  it depends on `~/.codex/config.toml` not widening `writable_roots`. The
  wrapper's post-run summary is repo-wide, so under parallel same-checkout runs
  only the aggregate review is authoritative (per-runner diffstats overlap).
- For codex reviewer lens diversity use `prompt` mode (a focused prompt on
  stdin); `review` mode is a single holistic diff pass and takes no focus, so
  use it at most once per fan-out.
- Rosters are plain arrays. The codex roster is the mandatory baseline; the
  Claude roster (`CLAUDE_LENSES` / `CLAUDE_POCS`) is empty by default — push an
  entry ONLY as a discretionary +α that adds value codex can't (e.g. a
  cross-model Claude review of a codex PoC).
- Claude stays the orchestrator: synthesis and judge stages are Claude `agent()`
  calls (the aggregator role), not fan-out workers.
- To intentionally omit codex from a workflow, add the comment `// codex-skip`
  to the script — the PreToolUse guard hook treats it as an explicit opt-out.
- Never auto-merge a PoC diff; it stays in its worktree for a human decision.
- Degrade gracefully on rate limits: the wrapper retries rate-limited runs
  with backoff (`--retry`, default 1) and exits 15 when exhausted. A codex
  stage failing with 15 must not abort the workflow — proceed with whatever
  results you have and state the coverage gap in the synthesis.

## Template A: codex-default review fan-out

```js
export const meta = {
  name: "codex-review",
  description:
    "codex-default review of the working tree (holistic + focused codex lenses), optional Claude +α, disagreement-first synthesis",
  phases: [{ title: "Review" }, { title: "Synthesize" }],
};

const REPO = "<absolute path to the repo or worktree under review>";

// DEFAULT roster (mandatory baseline): every reviewer is codex (a non-Claude
// family). Lens diversity comes from codex `prompt` mode (a focused prompt on
// stdin); `review` mode is one holistic diff pass and takes no focus.
const CODEX_LENSES = [
  {
    key: "holistic",
    prompt: `Holistically review the uncommitted changes in ${REPO}. Run: ~/.claude/hooks/lib/codex-stage.sh review --uncommitted --dir ${REPO} (Bash timeout 600000 ms). Map codex's findings into the structured output faithfully; set reviewer='codex:holistic'.`,
  },
  {
    key: "correctness",
    prompt: `Review the uncommitted changes in ${REPO} for CORRECTNESS BUGS only. Run codex in prompt mode: printf '%s' 'Read the uncommitted diff (git diff) in this repository and report ONLY correctness bugs — logic errors, missing cases, broken invariants, off-by-one — each with file:line.' | ~/.claude/hooks/lib/codex-stage.sh prompt --dir ${REPO} --timeout 600 (Bash timeout 600000 ms). Set reviewer='codex:correctness'.`,
  },
  {
    key: "conventions",
    prompt: `Review the uncommitted changes in ${REPO} for CONVENTION VIOLATIONS and risky patterns only. Run codex in prompt mode: printf '%s' 'Read the uncommitted diff (git diff) in this repository and report ONLY convention violations and risky patterns, each with file:line.' | ~/.claude/hooks/lib/codex-stage.sh prompt --dir ${REPO} --timeout 600 (Bash timeout 600000 ms). Set reviewer='codex:conventions'.`,
  },
];

// OPTIONAL +α: Claude lenses the main agent MAY add at its discretion. Empty by
// default — push an entry ONLY when a same-family lens adds value codex can't.
const CLAUDE_LENSES = []; // e.g. [{ key: "domain", prompt: "..." }]

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    reviewer: { type: "string", description: "codex:<lens> or claude:<lens>" },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            description: "Critical | High | Medium | Low",
          },
          location: { type: "string" },
          problem: { type: "string" },
          suggestion: { type: "string" },
        },
        required: ["severity", "problem"],
      },
    },
  },
  required: ["reviewer", "summary", "findings"],
};

phase("Review");
const reviews = (
  await parallel([
    // Mandatory baseline: codex reviewers.
    ...CODEX_LENSES.map(
      (l) => () =>
        agent(l.prompt, {
          label: `codex:${l.key}`,
          phase: "Review",
          agentType: "codex-reviewer",
          schema: REVIEW_SCHEMA,
        }),
    ),
    // Optional +α: Claude lenses (empty unless the main agent added any).
    ...CLAUDE_LENSES.map(
      (l) => () =>
        agent(l.prompt, {
          label: `claude:${l.key}`,
          phase: "Review",
          schema: REVIEW_SCHEMA,
        }),
    ),
  ])
).filter(Boolean);

// Synthesis is the ORCHESTRATOR role (main Claude), not a fan-out worker.
phase("Synthesize");
const synthesis = await agent(
  `Synthesize these reviews. Rank cross-lens DISAGREEMENTS first (issues one lens found and the others missed), then agreements by severity. Reviews: ${JSON.stringify(reviews)}`,
  { label: "synthesize", phase: "Synthesize" },
);

return { reviews, synthesis };
```

## Template B: competing codex PoCs

```js
export const meta = {
  name: "competing-poc",
  description:
    "Several codex PoCs implement the same spec with different approaches in isolated worktrees; each diff is reviewed; the main Claude agent judges. Optional Claude PoC +α.",
  phases: [{ title: "Implement" }, { title: "Review" }, { title: "Judge" }],
};

const SPEC = `<implementation spec: goal, constraints, files, verification>`;

// DEFAULT roster (mandatory baseline): competing codex PoCs, each with a
// DIFFERENT approach, each in its own isolated worktree.
const CODEX_POCS = [
  { key: "direct", angle: "Prefer the smallest, most direct change." },
  {
    key: "robust",
    angle: "Prefer the most robust, defensively-validated design.",
  },
];

// OPTIONAL +α: a Claude PoC the main agent MAY add at its discretion. Empty by
// default — add one only when a same-family attempt is worth comparing.
const CLAUDE_POCS = []; // e.g. [{ key: "claude", angle: "..." }]

const POC_SCHEMA = {
  type: "object",
  properties: {
    builder: { type: "string", description: "codex:<key> or claude:<key>" },
    worktree: {
      type: "string",
      description: "absolute path of the isolated worktree holding the diff",
    },
    summary: { type: "string" },
    diffstat: { type: "string" },
  },
  required: ["builder", "worktree", "summary", "diffstat"],
};
const REVIEW_SCHEMA = {
  // identical to Template A — inlined so this template is runnable when lifted alone
  type: "object",
  properties: {
    reviewer: { type: "string", description: "codex:<lens> or claude:<lens>" },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            description: "Critical | High | Medium | Low",
          },
          location: { type: "string" },
          problem: { type: "string" },
          suggestion: { type: "string" },
        },
        required: ["severity", "problem"],
      },
    },
  },
  required: ["reviewer", "summary", "findings"],
};

phase("Implement");
const pocs = (
  await parallel([
    // Mandatory baseline: codex PoCs, one isolated worktree each.
    ...CODEX_POCS.map(
      (p) => () =>
        agent(
          `Delegate this spec to codex: ${SPEC}\nApproach guidance: ${p.angle}\nYour cwd is an isolated worktree — follow your Execution Flow (codex-stage.sh poc). Report builder='codex:${p.key}', the worktree absolute path (git rev-parse --show-toplevel), and git diff --stat.`,
          {
            label: `poc:codex:${p.key}`,
            phase: "Implement",
            agentType: "codex-poc",
            isolation: "worktree",
            schema: POC_SCHEMA,
          },
        ),
    ),
    // Optional +α: Claude PoC (empty unless the main agent added any).
    ...CLAUDE_POCS.map(
      (p) => () =>
        agent(
          `Implement this spec in your isolated worktree (your cwd): ${SPEC}\nApproach guidance: ${p.angle}\nReport builder='claude:${p.key}', the worktree absolute path (git rev-parse --show-toplevel), and git diff --stat.`,
          {
            label: `poc:claude:${p.key}`,
            phase: "Implement",
            isolation: "worktree",
            schema: POC_SCHEMA,
          },
        ),
    ),
  ])
).filter(Boolean);

// Each PoC diff reviewed by codex (default). The main agent MAY add a Claude
// review here as +α for cross-model coverage of a codex PoC — a discretionary
// addition, not the baseline.
phase("Review");
const reviews = (
  await parallel(
    pocs.map(
      (p) => () =>
        agent(
          `Review the uncommitted changes in ${p.worktree}. Run: ~/.claude/hooks/lib/codex-stage.sh review --uncommitted --dir ${p.worktree} (Bash timeout 600000 ms). Set reviewer='codex' and note which PoC this is (builder=${p.builder}).`,
          {
            label: `review:${p.builder}`,
            phase: "Review",
            agentType: "codex-reviewer",
            schema: REVIEW_SCHEMA,
          },
        ),
    ),
  )
).filter(Boolean);

// Judge is the ORCHESTRATOR role (main Claude) — this is where the cross-model
// perspective enters, since the fan-out workers were all codex.
phase("Judge");
const verdict = await agent(
  `Competing PoCs implemented the same spec with different approaches; each diff was reviewed. As the main (Claude) orchestrator, recommend ONE PoC to adopt (with required fixes) and say what to graft from the losers. NEVER merge anything yourself — each diff stays in its worktree for a human decision. PoCs: ${JSON.stringify(pocs)} Reviews: ${JSON.stringify(reviews)}`,
  { label: "judge", phase: "Judge" },
);

return { pocs, reviews, verdict };
```

## Template C: parallel codex-runner writes

```js
export const meta = {
  name: "codex-runner-fanout",
  description:
    "Fan out independent write tasks to parallel codex-runner workers (each scoped to its own files/dir in the same checkout), then codex-review the aggregate diff",
  phases: [{ title: "Write" }, { title: "Review" }],
};

const REPO = "<absolute path to the repo or worktree the runners write into>";

// Independent sub-tasks. CRITICAL: `scope` paths must NOT overlap between tasks —
// parallel codex-runner writes to the same path corrupt the tree (the wrapper
// does not lock). Point each runner at its own subdirectory when possible.
const TASKS = [
  {
    key: "module-a",
    dir: `${REPO}/packages/a`,
    scope: "packages/a/**",
    spec: "<what to create/modify under packages/a, and how to verify>",
  },
  {
    key: "module-b",
    dir: `${REPO}/packages/b`,
    scope: "packages/b/**",
    spec: "<what to create/modify under packages/b, and how to verify>",
  },
];

const RUN_SCHEMA = {
  type: "object",
  properties: {
    dir: { type: "string" },
    summary: { type: "string" },
    diffstat: { type: "string" },
    status: { type: "string", description: "complete | incomplete" },
  },
  required: ["dir", "summary", "status"],
};
const REVIEW_SCHEMA = {
  // identical to Template A — inlined so this template is runnable when lifted alone
  type: "object",
  properties: {
    reviewer: { type: "string", description: "codex:<lens> or claude:<lens>" },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            description: "Critical | High | Medium | Low",
          },
          location: { type: "string" },
          problem: { type: "string" },
          suggestion: { type: "string" },
        },
        required: ["severity", "problem"],
      },
    },
  },
  required: ["reviewer", "summary", "findings"],
};

// Barrier is correct here: the aggregate review needs ALL writes finished first.
phase("Write");
const runs = (
  await parallel(
    TASKS.map(
      (t) => () =>
        agent(
          `Delegate this write task to codex, scoped to ${t.dir} (--dir). Touch ONLY ${t.scope}; do not write outside it. Spec: ${t.spec}\nRun: ~/.claude/hooks/lib/codex-stage.sh run --dir ${t.dir} --timeout 600 (task on stdin; Bash timeout 600000 ms). Report dir='${t.dir}', codex's summary, git diff --stat, and status ('complete' or 'incomplete').`,
          {
            label: `run:${t.key}`,
            phase: "Write",
            agentType: "codex-runner",
            schema: RUN_SCHEMA,
          },
        ),
    ),
  )
).filter(Boolean);

// codex-reviewer is read-only, so pointing it at the shared checkout is safe.
phase("Review");
const review = await agent(
  `Review the uncommitted changes in ${REPO}. Run: ~/.claude/hooks/lib/codex-stage.sh review --uncommitted --dir ${REPO} (Bash timeout 600000 ms). Set reviewer='codex'. Runner reports for context: ${JSON.stringify(runs)}`,
  {
    label: "review:aggregate",
    phase: "Review",
    agentType: "codex-reviewer",
    schema: REVIEW_SCHEMA,
  },
);

// Nothing is committed — the main agent decides what to keep.
return { runs, review };
```

## Wrapper quick reference

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
