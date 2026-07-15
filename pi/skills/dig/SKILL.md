---
name: dig
description: "Iteratively asks the user for information missing from the current plan and enriches the plan before implementation. Use before /plan-review."
---

# Dig

pi fork of the Claude Code `dig` skill. Read the current plan file, identify
information that is still missing before implementation can start, and ask
the user about it repeatedly. pi has no AskUserQuestion tool — ask in plain
conversation. Reflect each answer into the plan, re-analyze the updated
plan, and ask again if gaps remain. Repeat this cycle until the information
is sufficient.

## Prerequisites

- A plan file exists (pi has no plan mode; plans are markdown files under
  `./plans` in the main repo, created during planning)

## Execution Flow

### Phase 1: Detect the latest plan file

```bash
ls -t ./plans/*.md 2>/dev/null | head -1
```

If no file is found, stop with an error.
Read the detected plan file's content with the read tool.

### Phase 2: Analyze missing information

Analyze the plan from the following angles and list what is missing before
implementation can begin:

#### Analysis angles

1. **Technical design decisions**
   - Are library/framework choices explicit?
   - Are data structure and algorithm choices clear?
   - Is the API design (endpoints, request/response shapes) concrete?

2. **Clarity of business requirements**
   - Is edge-case behavior defined?
   - Is user-facing behavior on errors decided?
   - Are input constraints and validation requirements clear?
   - Are success/failure criteria defined?

3. **Consistency with existing code**
   - Is compatibility with existing APIs and type definitions considered?
   - Is it consistent with naming rules and coding conventions?
   - Are dependencies on existing modules clear?

4. **Implementation concreteness**
   - Is each step broken down to an implementable granularity?
   - Are the files to create/modify identified?
   - Is the test strategy (what to test, and how) clear?

### Phase 3: Question cycle

When missing information is found, repeat this cycle:

```
┌─→ Identify missing information
│   ↓
│   Ask the user in plain conversation (bundle 1–3 related questions per round)
│   ↓
│   Receive the user's answers
│   ↓
│   Reflect the answers into the plan file (update with the edit tool)
│   ↓
│   Re-read and re-analyze the updated plan
│   ↓
└── Repeat if gaps remain
```

#### Question rules

- **1–3 related questions per round** (too many questions at once is a burden)
- **Ask concretely**: not "How should the design work?" but "For the return
  type, are you assuming Result<T, E> or Option<T>?" — present options or
  concrete examples. Since pi has no structured question tool, write the
  options as a short numbered list the user can answer briefly.
- **Use codebase knowledge**: read the related code before asking, so you
  understand existing implementation patterns. Never ask for information
  already readable from the code.
- **Ask in priority order**: implementation blockers first

#### Termination conditions

End the question cycle when either holds:

1. All analysis angles have sufficient information
2. The user signals they are done ("enough", "OK", "that's fine", etc.)

### Phase 4: Completion report and automatic review

After the question cycle ends, report:

```
=== Dig Complete ===

Updated plan file: <path>

Added information:
- [bullet list of the key decisions added]

Running /plan-review automatically...
```

After the report, invoke the `plan-review` skill automatically and follow
it. No further user action is needed.

## Error Handling

| Situation               | Response                                             |
| ----------------------- | ---------------------------------------------------- |
| No plan file found      | Notify that the plans directory has no files         |
| Plan file update failed | Report the error and ask the user to update manually |

## Notes

- The plans directory is `./plans` (relative to the main repo root). Plan
  files are typically `.gitignore`d — from a worktree, read them via the
  main repo's absolute path.
- Auto-detect the latest file (no path from the user needed)
- Using this before `/plan-review` improves review quality
- Reading related code before asking avoids questions the codebase can
  already answer
