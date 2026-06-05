# Multi-Model Workflow Templates (codex cross-model stages)

Templates for weaving OpenAI codex (a non-Claude model family) into ultracode
Workflow scripts. Two integration shapes:

1. **Cross-model review** — every review/verification fan-out includes an
   `agentType: 'codex-reviewer'` stage alongside Claude lenses.
2. **Dual-PoC cross-review** — Claude and codex each implement the same spec in
   isolated worktrees, then each diff is reviewed by the OTHER model family.

Ground rules baked into these templates:

- All codex invocations go through `~/.claude/hooks/lib/codex-stage.sh`
  (auth preflight, portable timeout, `--ephemeral` for parallel safety,
  never `-m` — `~/.codex/config.toml` owns model selection).
- `codex-poc` must run paired with `isolation: 'worktree'` — the wrapper
  refuses (exit 14) to run workspace-write against a main repository checkout.
- Rosters are plain arrays: adding a future model family (gemini etc.) is a
  one-line push once its agent definition exists.
- To intentionally omit codex from a workflow, add the comment `// codex-skip`
  to the script — the PreToolUse guard hook treats it as an explicit opt-out.
- Never auto-merge a PoC diff; it stays in its worktree for a human decision.
- Degrade gracefully on rate limits: the wrapper retries rate-limited runs
  with backoff (`--retry`, default 1) and exits 15 when exhausted. A codex
  stage failing with 15 must not abort the workflow — proceed with the
  Claude-only results and state the coverage gap in the synthesis.

## Template A: cross-model review fan-out

```js
export const meta = {
  name: "cross-model-review",
  description:
    "Claude lenses + codex cross-model review of the working tree, disagreement-first synthesis",
  phases: [{ title: "Review" }, { title: "Synthesize" }],
};

const REPO = "<absolute path to the repo or worktree under review>";

// Rosters — push another agentType here when a new model-family CLI lands.
const CLAUDE_LENSES = [
  {
    key: "correctness",
    prompt: `Review the uncommitted changes in ${REPO} for correctness bugs. Read the diff with git -C ${REPO} diff. Report findings with file:line.`,
  },
  {
    key: "conventions",
    prompt: `Review the uncommitted changes in ${REPO} for convention violations and risky patterns. Report findings with file:line.`,
  },
];
const CROSS_MODEL = ["codex-reviewer"];

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    reviewer: { type: "string", description: "claude:<lens> or codex" },
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
    ...CLAUDE_LENSES.map(
      (l) => () =>
        agent(l.prompt, {
          label: `claude:${l.key}`,
          phase: "Review",
          schema: REVIEW_SCHEMA,
        }),
    ),
    ...CROSS_MODEL.map(
      (t) => () =>
        agent(
          `Review the uncommitted changes in ${REPO}. Run: ~/.claude/hooks/lib/codex-stage.sh review --uncommitted --dir ${REPO} (Bash timeout 600000 ms). Map codex's findings into the structured output faithfully; set reviewer='codex'.`,
          {
            label: `crossmodel:${t}`,
            phase: "Review",
            agentType: t,
            schema: REVIEW_SCHEMA,
          },
        ),
    ),
  ])
).filter(Boolean);

phase("Synthesize");
const synthesis = await agent(
  `Synthesize these reviews. Rank cross-model DISAGREEMENTS first (issues one model family found and the other missed), then agreements by severity. Reviews: ${JSON.stringify(reviews)}`,
  { label: "synthesize", phase: "Synthesize" },
);

return { reviews, synthesis };
```

## Template B: dual-PoC cross-review

```js
export const meta = {
  name: "dual-poc",
  description:
    "Claude and codex implement the same spec in isolated worktrees; each diff is reviewed by the other model family; judge recommends one",
  phases: [
    { title: "Implement" },
    { title: "Cross-review" },
    { title: "Judge" },
  ],
};

const SPEC = `<implementation spec: goal, constraints, files, verification>`;

const POC_SCHEMA = {
  type: "object",
  properties: {
    builder: { type: "string", description: "claude or codex" },
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
  /* same as Template A */
};

phase("Implement");
const pocs = (
  await parallel([
    () =>
      agent(
        `Implement this spec in your isolated worktree (your cwd): ${SPEC}\nReport builder='claude', the worktree absolute path (git rev-parse --show-toplevel), and git diff --stat.`,
        {
          label: "poc:claude",
          phase: "Implement",
          isolation: "worktree",
          schema: POC_SCHEMA,
        },
      ),
    () =>
      agent(
        `Delegate this spec to codex: ${SPEC}\nYour cwd is an isolated worktree — follow your Execution Flow (codex-stage.sh poc). Report builder='codex'.`,
        {
          label: "poc:codex",
          phase: "Implement",
          agentType: "codex-poc",
          isolation: "worktree",
          schema: POC_SCHEMA,
        },
      ),
  ])
).filter(Boolean);

phase("Cross-review"); // each diff is reviewed by the OTHER model family
const crossReviews = (
  await parallel(
    pocs.map(
      (p) => () =>
        p.builder === "claude"
          ? agent(
              `Review the uncommitted changes in ${p.worktree}. Run: ~/.claude/hooks/lib/codex-stage.sh review --uncommitted --dir ${p.worktree}. Set reviewer='codex'.`,
              {
                label: "codex-reviews-claude",
                phase: "Cross-review",
                agentType: "codex-reviewer",
                schema: REVIEW_SCHEMA,
              },
            )
          : agent(
              `Review the uncommitted changes in ${p.worktree} (git -C ${p.worktree} diff) for correctness, safety, and fit. Set reviewer='claude'.`,
              {
                label: "claude-reviews-codex",
                phase: "Cross-review",
                schema: REVIEW_SCHEMA,
              },
            ),
    ),
  )
).filter(Boolean);

phase("Judge");
const verdict = await agent(
  `Two PoCs implemented the same spec; each was reviewed by the other model family. Recommend ONE to adopt (with required fixes) and say what to graft from the loser. NEVER merge anything yourself. PoCs: ${JSON.stringify(pocs)} Cross-reviews: ${JSON.stringify(crossReviews)}`,
  { label: "judge", phase: "Judge" },
);

return { pocs, crossReviews, verdict };
```

## Wrapper quick reference

```bash
~/.claude/hooks/lib/codex-stage.sh review [--uncommitted | --base <branch> | --commit <sha>] --dir <abs> [--timeout <sec>]
~/.claude/hooks/lib/codex-stage.sh prompt [--dir <abs>] [--timeout <sec>]   # prompt on stdin, read-only
~/.claude/hooks/lib/codex-stage.sh poc --worktree <abs> [--timeout <sec>] [--network]   # spec on stdin, workspace-write
```

All modes also accept `--retry <n>` / `--retry-wait <sec>` (rate-limit backoff;
defaults 1 / 30).

Exit codes: 0 ok / 11 codex missing / 12 unauthenticated (`codex login`) /
13 usage / 14 not an isolated worktree / 15 rate limited (retryable) /
124 timed out.
