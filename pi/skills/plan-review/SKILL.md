---
name: plan-review
description: "Analyzes project characteristics for the latest plan file, auto-selects the appropriate review agents, and launches them in parallel via the subagent tool. Can be run without arguments."
---

# Plan Review

pi fork of the Claude Code `plan-review` skill. Auto-analyze project
characteristics for the latest plan file, select the appropriate review
agents, and launch them in parallel with the pi-harness `subagent` tool.

## Prerequisites

- A plan file exists (pi has no plan mode; plans are markdown files under
  `./plans` in the main repo, created during planning)
- Review agents are defined in `~/.claude/agents/` — the same agent
  definition files Claude Code uses. The `subagent` tool reads them by the
  same names, so `rust-reviewer`, `codex-reviewer`, `similarity`,
  `tdd-reviewer`, etc. are all available unchanged.

## Arguments

| Argument   | Required | Description                                                        |
| ---------- | -------- | ------------------------------------------------------------------ |
| agent-name | No       | Only for explicit selection. Omit for auto-selection (recommended) |

## Execution Flow

### Phase 1: Detect the latest plan file

```bash
ls -t ./plans/*.md 2>/dev/null | head -1
```

If no file is found, stop with an error.
Read the detected plan file's content with the read tool.

### Phase 2: Reviewer selection

If an agent name is given as an argument, use only that agent (backward
compatible).

If the argument is omitted (recommended), decide which reviewers to launch
using the rules below.

#### 2a: Analyze project characteristics

Collect the following signals **in parallel**:

| Signal              | Detection method                           |
| ------------------- | ------------------------------------------ |
| Rust project        | `Cargo.toml` exists, or `*.rs` files exist |
| codex CLI available | `which codex` succeeds                     |
| Refactoring-type    | Plan content contains the keywords below   |
| Test infrastructure | Test files / test configuration exist      |

**Refactoring-type keywords** (checked against the plan body; plans may be
written in Japanese, so both English and Japanese keywords are kept):

- refactor / リファクタリング / 重複 / duplication / DRY / 共通化 / 抽出 / extract

**Test infrastructure detection**:

Judge "test infrastructure exists" when at least one of these **primary
signals** is present:

- Test files exist: `*.test.ts`, `*.spec.ts`, `*.test.tsx`, `*.spec.tsx`, `*.test.js`, `*.spec.js`, `*.test.jsx`, `*.spec.jsx`, `*_test.go`, `*_test.rs`
- Test configuration files exist: `vitest.config.*`, `jest.config.*`, `playwright.config.*`, `.mocharc.*`
- Test directories exist: `tests/`, `__tests__/`, `test/`

**Auxiliary signal** (never triggers on its own; raises confidence when
combined with a primary signal):

- package.json defines a `test` script

#### 2b: Reviewer matching rules

Based on the collected signals, decide which agents to launch:

| Condition                         | Agent to launch  |
| --------------------------------- | ---------------- |
| Rust project                      | `rust-reviewer`  |
| codex CLI available               | `codex-reviewer` |
| Refactoring-type keywords present | `similarity`     |
| Test infrastructure exists        | `tdd-reviewer`   |

- If multiple conditions match, launch **all** of them (in parallel)
- If the codex CLI is available, **always** launch `codex-reviewer`
  regardless of other conditions (secures a cross-model perspective and
  covers blind spots specific to a single model family)
- **If no condition matches**: notify the user that no reviewer is
  applicable and ask for manual specification

#### 2c: Show the selection result

Before launching, show the user the selected reviewers:

```
Project analysis:
  - Rust project: ✓ (Cargo.toml detected)
  - codex CLI: ✓ (available)
  - Refactoring-type: ✗
  - Test infrastructure: ✓ (vitest.config.ts detected)

Reviewers to launch: rust-reviewer, codex-reviewer, tdd-reviewer
```

### Phase 3: Parallel review execution

Launch **all selected agents at once** with a single `subagent` tool call in
parallel mode:

```
subagent {
  tasks: [
    { agent: "rust-reviewer",  task: "<review prompt>" },
    { agent: "codex-reviewer", task: "<review prompt>" },
    { agent: "tdd-reviewer",   task: "<review prompt>" }
  ]
}
```

Parallel mode accepts up to 8 tasks and runs up to 4 concurrently. When
exactly one reviewer is selected, single mode `{agent, task}` is fine.

Prompt to pass to each agent:

```
Review the following plan file.
Based on your expertise, provide feedback from these angles:
1. Technical accuracy
2. Potential problems and risks
3. Improvement suggestions
4. Overlooked considerations

---

Plan File: <path>

---

<content>
```

**Important**: do NOT issue one `subagent` call per reviewer — pass all
reviewers in a single parallel-mode `tasks` array so they run concurrently.

The tool returns an **acceptance** result with an invocation ID immediately.
Do not mistake that acceptance text for reviewer output and do not aggregate
yet. Tell the user the review invocation was started if useful, then wait for
the automatic background-completion message. That message triggers a parent
turn containing the aggregate reviewer results.

### Phase 4: Aggregate and report

Only after the background-completion message arrives, aggregate all reviewers'
results in this format:

```
=== Plan Review Results ===

--- rust-reviewer ---
[feedback from rust-reviewer]

--- codex-reviewer ---
[feedback from codex-reviewer]

=== Overall Summary ===
Cross-cutting summary of all reviewers' findings, most important first.
```

## Reviewer List

| Agent name     | Auto-selection condition                                            | Specialty                                                           |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| rust-reviewer  | Cargo.toml / .rs files exist                                        | Rust code performance and maintainability                           |
| codex-reviewer | codex CLI available                                                 | General architecture and design review                              |
| similarity     | Refactoring-type keywords in the plan                               | Code duplication analysis and refactoring proposals                 |
| tdd-reviewer   | Test files / test config / test directories exist (primary signals) | TDD compliance, Testing Trophy, mock minimization, test duplication |

## Usage Examples

### Auto-selection mode (recommended)

```
> /plan-review

Latest plan file detected: ./plans/kind-cuddling-dragon.md

Project analysis:
  - Rust project: ✓ (Cargo.toml detected)
  - codex CLI: ✓ (available)
  - Refactoring-type: ✗
  - Test infrastructure: ✓ (vitest.config.ts detected)

Reviewers to launch: rust-reviewer, codex-reviewer, tdd-reviewer
Reviewing... (3 agents accepted in one background subagent invocation)

[automatic background-completion message arrives]

=== Plan Review Results ===

--- rust-reviewer ---
[feedback]

--- codex-reviewer ---
[feedback]

--- tdd-reviewer ---
[feedback]

=== Overall Summary ===
[cross-cutting summary]
```

### Manual mode (backward compatible)

```
> /plan-review rust-reviewer

Latest plan file detected: ./plans/kind-cuddling-dragon.md
Agent: rust-reviewer (manually specified)

Reviewing... (background invocation accepted)

[automatic background-completion message arrives]

=== Plan Review Results ===

--- rust-reviewer ---
[feedback]
```

## Error Handling

| Situation                          | Response                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| No plan file found                 | Notify that the plans directory has no files                                               |
| Auto-selection matched no reviewer | Show available agents and ask for manual specification                                     |
| Manually specified agent not found | Show available agents (from `~/.claude/agents/`) and stop with error                       |
| Some agents failed                 | On completion, report successful results and state the failures clearly                    |
| Invocation only accepted           | Wait for its automatic background-completion message; do not aggregate the acceptance text |

## Notes

- The plans directory is `./plans` (relative to the main repo root). Plan
  files are typically `.gitignore`d — from a worktree, read them via the
  main repo's absolute path.
- **Auto-detect the latest file** (no path from the user needed)
- In auto-selection mode, run both signal collection and reviews **in parallel**
- Manual mode behaves as before (backward compatibility preserved)
- When adding a new reviewer, update both the Reviewer List table and the
  Phase 2b matching rules
