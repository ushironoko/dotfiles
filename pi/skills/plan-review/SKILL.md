---
name: plan-review
description: "Analyzes project characteristics for the latest plan file, auto-selects the appropriate review agents, and launches them in parallel through the pi-harness workflow tool. Can be run without arguments."
---

# Plan Review

pi fork of the Claude Code `plan-review` skill. Auto-analyze project
characteristics for the latest plan file, select the appropriate review
agents, and launch them through one staged pi-harness `workflow` call.

## Prerequisites

- A plan file exists (pi has no plan mode; plans are markdown files under
  `./plans` in the main repo, created during planning).
- Review agents are defined in `~/.claude/agents/` — the same agent
  definitions used by the pi-harness `workflow` tool.
- The `workflow` tool is active in a top-level pi session. Child-agent profiles
  disable nested workflows. If `workflow` is unavailable, stop and report the
  limitation. Do not silently fall back to `subagent`.

## Arguments

| Argument   | Required | Description                                                        |
| ---------- | -------- | ------------------------------------------------------------------ |
| agent-name | No       | Only for explicit selection. Omit for auto-selection (recommended) |

## Execution Flow

### Phase 1: Detect the latest plan file

```bash
ls -t ./plans/*.md 2>/dev/null | head -1
```

If no file is found, stop with an error. Read the detected plan file with the
`read` tool. From a worktree, find the plan under the main repo because plans
are commonly ignored by Git.

### Phase 2: Select reviewers

Any agent whose definition exists may be selected manually.
This preserves the previous manual interface. If an agent name is provided,
verify that its definition exists in `~/.claude/agents/`. Use only that agent,
then continue with the manual `single` workflow in Phase 3. Known write-capable agents require
the isolated manual shape documented there.

If the argument is omitted, collect these signals in parallel.

| Signal              | Detection method                           |
| ------------------- | ------------------------------------------ |
| Rust project        | `Cargo.toml` exists, or `*.rs` files exist |
| codex CLI available | `which codex` succeeds                     |
| Refactoring-type    | Plan content contains the keywords below   |
| Test infrastructure | Test files / test configuration exist      |

**Refactoring-type keywords** (checked against the plan body):

- refactor / リファクタリング / 重複 / duplication / DRY / 共通化 / 抽出 / extract

**Test infrastructure detection**:

Treat test infrastructure as present when at least one primary signal exists:

- Test files: `*.test.ts`, `*.spec.ts`, `*.test.tsx`, `*.spec.tsx`,
  `*.test.js`, `*.spec.js`, `*.test.jsx`, `*.spec.jsx`, `*_test.go`,
  `*_test.rs`
- Test configuration: `vitest.config.*`, `jest.config.*`,
  `playwright.config.*`, `.mocharc.*`
- Test directories: `tests/`, `__tests__/`, `test/`

A `package.json` test script is auxiliary evidence only and never triggers the
reviewer by itself.

#### Reviewer matching rules

| Condition                         | Agent to launch  |
| --------------------------------- | ---------------- |
| Rust project                      | `rust-reviewer`  |
| codex CLI available               | `codex-reviewer` |
| Refactoring-type keywords present | `similarity`     |
| Test infrastructure exists        | `tdd-reviewer`   |

- Select every matching reviewer.
- `which codex` defines availability at selection time. Authentication,
  timeout, and rate-limit problems are runtime outcomes and must later be
  reported as coverage gaps.
- A Codex review is cross-model only when the parent uses a different model
  family. Otherwise it is fresh-context review; do not claim cross-model
  coverage from the reviewer name alone.

#### Codex unavailable in automatic mode

A workflow `fanout` stage requires a Codex-family baseline unless the user
explicitly opts out. If specialist reviewers match but `which codex` fails:

1. Call `AskUserQuestion` alone. Ask whether to continue with the selected
   specialist reviewers without Codex, or stop.
2. Do not emit a `workflow` call in the same turn. Always wait for the answer.
3. Only an affirmative answer permits the `plan-review-codex-opt-out` workflow
   in Phase 3 with `codexSkip: true`.
4. On denial, cancellation, or unavailable interactive UI, stop without
   invoking `workflow`.

If no reviewer condition matches, report that no reviewer is applicable and
ask the user to specify one manually.

#### Show the selection result

Before launching, show the selected reviewers and the evidence used:

```text
Project analysis:
  - Rust project: ✓ (Cargo.toml detected)
  - codex CLI: ✓ (available)
  - Refactoring-type: ✗
  - Test infrastructure: ✓ (vitest.config.ts detected)

Reviewers to launch: rust-reviewer, codex-reviewer, tdd-reviewer
```

### Phase 3: Execute the review workflow

Use the following complete prompt as every selected task's `task` value:

```text
Read-only plan review. Do not modify files.
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

Replace `<path>` and `<content>` before invoking the tool. Do not abbreviate or
omit the plan content.

#### Reserved placeholder safety

The workflow engine replaces every reserved `{previous}` placeholder in a task,
including occurrences inside an embedded plan path or content, and provides no
literal escape. Inspect both values before constructing any workflow task:

- If neither the plan path nor content contains that placeholder, embed the raw
  values with the standard prompt above.
- If the plan path or content contains the reserved `{previous}` placeholder,
  base64-encode the exact UTF-8 bytes of both values.
  Do not place the raw plan path or content in any workflow task. Give every
  selected reviewer this alternate prompt, replacing both base64 placeholders
  with actual values:

```text
Read-only plan review. Do not modify files.
Review the following implementation plan. Its exact path and content bytes are
base64-encoded because raw text cannot be transported safely through this
orchestration. Decode both payloads as UTF-8 before reviewing the plan, then
provide feedback on:
1. Technical accuracy
2. Potential problems and risks
3. Improvement suggestions
4. Overlooked considerations

Plan File Path Encoding: base64 (UTF-8)
<base64-path>
Plan Content Encoding: base64 (UTF-8)
<base64-content>
```

The generated alternate task text must not reproduce the reserved placeholder
outside the encoded payloads. Base64 cannot contain braces, so the workflow
substitution cannot alter either value.

#### Automatic mode: one fan-out stage

Launch all selected reviewers with one `workflow` tool call. Use one stage with
`mode: "fanout"`, one explicit `agentType` task per selected reviewer, and no
judge stage. The following validator-backed example shows the maximum automatic
roster; remove tasks whose conditions did not match.

```json
{
  "stages": [
    {
      "name": "plan-review-auto",
      "mode": "fanout",
      "tasks": [
        {
          "agentType": "rust-reviewer",
          "task": "Read-only plan review.\nDo not modify files.\nReview the following plan file.\nBased on your expertise, provide feedback from these angles:\n1. Technical accuracy\n2. Potential problems and risks\n3. Improvement suggestions\n4. Overlooked considerations\n\n---\n\nPlan File: <path>\n\n---\n\n<content>"
        },
        {
          "agentType": "codex-reviewer",
          "task": "Read-only plan review.\nDo not modify files.\nReview the following plan file.\nBased on your expertise, provide feedback from these angles:\n1. Technical accuracy\n2. Potential problems and risks\n3. Improvement suggestions\n4. Overlooked considerations\n\n---\n\nPlan File: <path>\n\n---\n\n<content>"
        },
        {
          "agentType": "similarity",
          "task": "Read-only plan review.\nDo not modify files.\nReview the following plan file.\nBased on your expertise, provide feedback from these angles:\n1. Technical accuracy\n2. Potential problems and risks\n3. Improvement suggestions\n4. Overlooked considerations\n\n---\n\nPlan File: <path>\n\n---\n\n<content>"
        },
        {
          "agentType": "tdd-reviewer",
          "task": "Read-only plan review.\nDo not modify files.\nReview the following plan file.\nBased on your expertise, provide feedback from these angles:\n1. Technical accuracy\n2. Potential problems and risks\n3. Improvement suggestions\n4. Overlooked considerations\n\n---\n\nPlan File: <path>\n\n---\n\n<content>"
        }
      ]
    }
  ]
}
```

Tasks in the fan-out stage run concurrently. The parent waits for the complete
workflow report before synthesis.

#### Automatic mode after explicit Codex opt-out

Use this shape only after the separate `AskUserQuestion` turn received an
affirmative answer. The example shows the maximum specialist roster; remove
only tasks whose conditions did not match.

```json
{
  "stages": [
    {
      "name": "plan-review-codex-opt-out",
      "mode": "fanout",
      "codexSkip": true,
      "tasks": [
        {
          "agentType": "rust-reviewer",
          "task": "Read-only plan review.\nDo not modify files.\nReview the following plan file.\nBased on your expertise, provide feedback from these angles:\n1. Technical accuracy\n2. Potential problems and risks\n3. Improvement suggestions\n4. Overlooked considerations\n\n---\n\nPlan File: <path>\n\n---\n\n<content>"
        },
        {
          "agentType": "similarity",
          "task": "Read-only plan review.\nDo not modify files.\nReview the following plan file.\nBased on your expertise, provide feedback from these angles:\n1. Technical accuracy\n2. Potential problems and risks\n3. Improvement suggestions\n4. Overlooked considerations\n\n---\n\nPlan File: <path>\n\n---\n\n<content>"
        },
        {
          "agentType": "tdd-reviewer",
          "task": "Read-only plan review.\nDo not modify files.\nReview the following plan file.\nBased on your expertise, provide feedback from these angles:\n1. Technical accuracy\n2. Potential problems and risks\n3. Improvement suggestions\n4. Overlooked considerations\n\n---\n\nPlan File: <path>\n\n---\n\n<content>"
        }
      ]
    }
  ]
}
```

#### Manual mode: one single stage

Manual mode accepts one reviewer name and still invokes `workflow`. Use exactly
one task in `mode: "single"`.

```json
{
  "stages": [
    {
      "name": "plan-review-manual",
      "mode": "single",
      "tasks": [
        {
          "agentType": "rust-reviewer",
          "task": "Read-only plan review.\nDo not modify files.\nReview the following plan file.\nBased on your expertise, provide feedback from these angles:\n1. Technical accuracy\n2. Potential problems and risks\n3. Improvement suggestions\n4. Overlooked considerations\n\n---\n\nPlan File: <path>\n\n---\n\n<content>"
        }
      ]
    }
  ]
}
```

Replace `rust-reviewer` with the manually requested agent.

For known write-capable agents, protect the main checkout by adding
`isolation: "worktree"`. It is mandatory for `codex-poc` and also required by
this skill for `codex-runner`. The workflow leaves the created worktree in place
and reports its path; never merge or remove it automatically. The `codex-poc`
shape is validator-backed:

```json
{
  "stages": [
    {
      "name": "plan-review-manual-codex-poc",
      "mode": "single",
      "tasks": [
        {
          "agentType": "codex-poc",
          "isolation": "worktree",
          "task": "Read-only plan review.\nDo not modify files.\nReview the following plan file.\nBased on your expertise, provide feedback from these angles:\n1. Technical accuracy\n2. Potential problems and risks\n3. Improvement suggestions\n4. Overlooked considerations\n\n---\n\nPlan File: <path>\n\n---\n\n<content>"
        }
      ]
    }
  ]
}
```

Use the same isolated shape for `codex-runner`:

```json
{
  "stages": [
    {
      "name": "plan-review-manual-codex-runner",
      "mode": "single",
      "tasks": [
        {
          "agentType": "codex-runner",
          "isolation": "worktree",
          "task": "Read-only plan review.\nDo not modify files.\nReview the following plan file.\nBased on your expertise, provide feedback from these angles:\n1. Technical accuracy\n2. Potential problems and risks\n3. Improvement suggestions\n4. Overlooked considerations\n\n---\n\nPlan File: <path>\n\n---\n\n<content>"
        }
      ]
    }
  ]
}
```

### Phase 4: Aggregate and report

The parent agent must synthesize the workflow report itself.
Do not add a workflow judge stage.

Classify every selected reviewer as one of:

1. **Usable review** — actionable review output was returned.
2. **Task failure** — the workflow marks the task `FAILED`.
3. **reviewer-reported inability** — the task process succeeded, but its output
   says the underlying review could not run (for example missing auth, rate
   limit, timeout, or required tool failure).
4. **Empty or non-actionable success** — the workflow marks the task succeeded,
   but it returns `(no output)` or no usable review feedback.

Do not rely only on workflow status headers. Every non-usable class creates a
reviewer-specific coverage gap. If output was truncated, disclose that as a
coverage limitation. A workflow validation, unknown-agent, or other preflight failure means no review ran. Report the invocation error and stop rather than
presenting a review summary.

Aggregate usable reviews in this form:

```text
=== Plan Review Results ===

--- rust-reviewer ---
[feedback from rust-reviewer]

--- codex-reviewer ---
[feedback from codex-reviewer]

=== Coverage Gaps ===
- [failed, unavailable, or truncated reviewer coverage]

=== Overall Summary ===
[Cross-cutting findings, with shared and high-severity issues first]
```

## Reviewer List

| Agent name     | Auto-selection condition                                            | Specialty                                                           |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| rust-reviewer  | Cargo.toml / .rs files exist                                        | Rust code performance and maintainability                           |
| codex-reviewer | codex CLI available                                                 | General architecture and design review                              |
| similarity     | Refactoring-type keywords in the plan                               | Code duplication analysis and refactoring proposals                 |
| tdd-reviewer   | Test files / test config / test directories exist (primary signals) | TDD compliance, Testing Trophy, mock minimization, test duplication |

## Error Handling

| Situation                                        | Response                                                        |
| ------------------------------------------------ | --------------------------------------------------------------- |
| No plan file found                               | Report that `plans/` has no files                               |
| `workflow` unavailable                           | Stop; never fall back to `subagent`                             |
| Auto-selection matched no reviewer               | Show available agents and ask for manual specification          |
| Codex missing but specialists matched            | Ask separately; set `codexSkip` only after explicit approval    |
| Manual agent definition not found                | Show available agents and stop                                  |
| Workflow validation or preflight failed          | Report that no review ran and stop                              |
| Task failed, reported inability, or empty output | Keep usable reviews and report a reviewer-specific coverage gap |
| Workflow output truncated                        | Synthesize available text and disclose the coverage limitation  |

## Notes

- Auto-detect the latest plan file; no path argument is needed.
- Collect project signals in parallel, then run reviewers in one workflow
  fan-out stage.
- Workflow runs at most four tasks concurrently; the current automatic roster
  contains at most four reviewers.
- Manual mode remains one reviewer for backward compatibility.
- When adding a reviewer, update the matching table, Reviewer List, and the
  automatic workflow example together.
