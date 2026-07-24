---
name: permission-audit-analysis
description: Analyze private pi-harness Bash permission audit logs, investigate ASK/DENY and judge/hook routing, export unlabeled candidates, and assemble a private human-reviewed staging corpus for later qualification. Use when tuning Bash permission behavior or reviewing frequent permission patterns. Defaults to body-free local aggregation and never infers expected labels.
compatibility: Requires Bun and the pi-harness permission audit extension.
---

# Permission Audit Analysis

Analyze the sensitive local permission audit without treating observations as
safety labels. Resolve all relative paths below against this skill directory;
do not assume the current project is the dotfiles repository.

## Non-negotiable safety boundary

- Start with body-free `summary`; use `top-ask` only after it when requested. Do
  not read raw JSONL files.
- Raw commands, task text, paths, and evidence may contain credentials.
- Except for the exact Phase 2 record explicitly approved for disclosure to the
  current model/provider, never send logs, candidates, inspected records, or
  reviewed corpus to web tools, subagents, workflows, external services, or
  another model.
- User approval and judge output are observations, never `expected` labels.
- Never generate a label without a human-created labels file.
- Never automatically edit permission rules or the checked-in qualification
  corpus. Promotion is a separate implementation task with its own review.
- Every `AskUserQuestion` call must be made alone; wait for its result before
  running a dependent command.
- If the user requests a dry-run, procedure-only plan, read-only review, or says
  not to execute commands/log access, do not call `AskUserQuestion`, read time,
  or begin Phase 1. Return only the unresolved gates, proposed stopping points,
  and resume conditions. Execution permission is resolved before period choice.

Let `<skill-dir>` mean the absolute directory containing this `SKILL.md`.
The analyzer is `<skill-dir>/scripts/analyze.ts`.

When invoking it through a shell, pass every path as one correctly shell-escaped
literal argument. Never interpolate an unquoted path into a command. Reject
paths containing NUL, CR, or LF. The path shown for approval must decode to the
exact argv value passed to the analyzer; do not reinterpret it after approval.
For example, the shell literal `'/private dir/$(not-executed).jsonl'` is one inert
argv value; use correct quote escaping if the path itself contains a quote.
"Expanded" means resolving a leading `~` or the documented default against the
home directory only. Never evaluate `$()`, `${}`, glob, backslash, or other shell
syntax found inside a user path.

## Phase 1: Body-free analysis

A valid body-free resume ticket may resume directly at Phase 4. Mismatch
recovery returns directly to Phase 3 with the ticket's window. Do not rerun
Phase 1 during either path unless the user asks for new analysis or changes the
window.

By default the analyzer includes every retained record (up to the 90-day
retention boundary). If the request says "recent", "lately", or another
relative period, call `AskUserQuestion` alone before analysis and offer:

- all retained records
- the last 7 days
- the last 30 days

Use Other for an exact start date. Interpret a date without a time as
`00:00:00Z` on that UTC date; an offset-bearing timestamp represents its stated
instant. For the last 7 or 30 days, read the current UTC timestamp once and
subtract exactly `N * 24h`; use a rolling duration, not a calendar-day
boundary. Convert the result to one literal ISO-8601 UTC start and pass the same
`--since <timestamp>` to every later analysis/export command in this run. Report the selected window. Do not silently interpret "recent" as the
whole retention period. In the recipes below, replace `<window-args>` with that
literal `--since <timestamp>`, or omit the placeholder entirely when the user
selected all retained records. If the period answer is absent, cancelled, or
invalid, run no command and return to the same period gate; never infer a date or
fall back to all records.

Always begin with:

```bash
bun <skill-dir>/scripts/analyze.ts summary <window-args>
```

Report counts by decision, disposition, route/reason, judge gates/cache,
confirmation status, and parent/child source. The selected record window applies
to records and summary counts; file, skipped-file, and parse diagnostics scan all
retained log files, as identified by `scope.fileDiagnostics`. Report those scan-
scope malformed/truncated and command-hash-mismatch diagnostics, plus only the
count of skipped unsafe files; never report skipped file names or paths. Do not
include command text, task text, cwd, or evidence. Describe causes only as observed route, reason,
gate, or cache classifications.
Never infer command meaning or user intent from a hash.

For frequent ASK patterns:

```bash
bun <skill-dir>/scripts/analyze.ts top-ask --limit 20 <window-args>
```

`top-ask` is optional when the user only requested candidate export; do not run
it merely as an export prerequisite. For pattern analysis, a successful
`summary` is a prerequisite for `top-ask`. Its command entries contain `sha256`,
total/release/block counts, confirmation counts, and reason-code counts; no command body is present. Use those returned
hashes and reason breakdowns when discussing candidates. If either command
fails, do not present a complete trend report. Never retry an analyzer command
automatically: stop and report the failure. A user-requested later attempt uses
the same literal `--since`; if the window changes, rerun both commands from
`summary`.

## Phase 2: Optional sensitive inspection

A command hash can match records with different task, cwd, or evidence. Locate
body-free record identities first:

```bash
bun <skill-dir>/scripts/analyze.ts locate \
  --hash <exact-sha256> \
  <window-args>
```

`locate` returns only matching decision IDs, timestamps, body-free record
digests, and the match count. If multiple records match, call `AskUserQuestion`
alone and require the user to select one exact decision ID or keep analysis
body-free. Do not select a record automatically. An Other/free-text answer is
valid only when it exactly equals an ID returned by `locate`. For one match, use
its ID only as the proposed target; disclosure still requires the next
confirmation.

`inspect` requires the selected `--decision-id` and `--show-sensitive`, and
prints that one raw record into the agent context. Resolve the actual current
provider/model from session metadata; if it cannot be identified, do not
inspect. Before inspection, call `AskUserQuestion` alone. State the exact hash,
decision ID, record digest, match count, actual provider/model, and that command,
task, paths, and evidence may be disclosed to that provider. Offer:

- Inspect this exact decision in the agent context
- Keep analysis body-free

Explicit approval creates a narrow exception only for that exact decision and
current provider/model; do not forward its output elsewhere. Re-resolve the
provider/model immediately before inspection; if it differs from the approved
identity, stop and repeat disclosure approval. Only after approval run:

```bash
bun <skill-dir>/scripts/analyze.ts inspect \
  --hash <exact-sha256> \
  --decision-id <exact-decision-uuid> \
  --record-sha256 <digest-from-locate> \
  --match-count <count-from-locate> \
  --show-sensitive \
  <window-args>
```

The analyzer blocks if the record digest or match count changed after `locate`.
On change, failure, cancellation, no answer, or invalid selection, disclose
nothing and stop body-free. A later retry starts from `locate`, re-identifies the
provider/model, and repeats approval. Never inspect another decision ID or hash
without separate approval. Do not quote unrelated raw fields in the response.

## Phase 3: Export unlabeled candidates

Candidate export keeps raw data out of tool output but writes a sensitive local
file. Call `AskUserQuestion` alone to approve export and its exact expanded,
new private absolute destination; wait for the answer before `candidates`.
User-supplied destinations require the same confirmation. Unless the user
supplied another private absolute destination, obtain one UTC filename stamp
with the separate body-free command `date -u +%Y%m%dT%H%M%SZ` and propose the
fully expanded absolute path:

```text
<home>/.pi/agent/pi-harness/exports/permission-candidates-<UTC timestamp>.jsonl
```

Do not show `~` in the approval question; show the exact expanded path. The
analyzer uses exclusive creation. If it reports a collision, do not overwrite or
silently change the path. For a generated default, propose a new literal
suffix; for a user-supplied destination, ask the user for a new path or propose
one. In both cases show the full replacement and ask for approval again. Then
run:

```bash
bun <skill-dir>/scripts/analyze.ts candidates \
  --output <absolute-new-candidates.jsonl> \
  --include-sensitive \
  <window-args>
```

For corpus creation alone, omit `top-ask` unless the user separately requested
pattern analysis. The default export contains observed ASK records only. To
change this, require a user request and pass `--decision allow|ask|deny|all`.
Candidate records are unlabeled and must not contain `expected`.

Capture the body-free `candidateSha256` returned by the analyzer. Give the user
a resume ticket containing only the selected window, exact candidate path,
record count, creation time, and this digest. Do not read the candidate to
recompute it in the agent context. The ticket contains no raw candidate body.
The user may present it to a later local pi session solely to resume Phase 4;
do not send it to web tools, subagents, workflows, issues, or other external
services. Enter `STOP_WAITING_FOR_HUMAN_LABELS` after reporting this ticket. Do
not continue to Phase 4 until the human supplies the labels path.

## Phase 4: Human-only staging corpus review

Do not read the candidate file into the agent context. Ask the user to review it
outside pi in a local editor and create a labels JSON file containing only:

```json
[
  {
    "decisionId": "<candidate decision UUID>",
    "expected": "allow"
  },
  {
    "decisionId": "<candidate decision UUID>",
    "expected": "ask"
  }
]
```

Omit skipped candidates. See
[references/corpus-review.md](references/corpus-review.md) for labeling rules.

After the user says the labels file is ready, require its absolute path. If it
was not supplied, call `AskUserQuestion` alone to obtain it. The model and
general-purpose `Read` tool must not read candidate or labels content. Only the
approved local analyzer may read them for validation and joining; pass their
approved paths to it. Unless the user supplied another private reviewed-corpus
destination, obtain a
UTC filename stamp with `date -u +%Y%m%dT%H%M%SZ` and propose:

```text
<home>/.pi/agent/pi-harness/exports/permission-reviewed-<UTC timestamp>.jsonl
```

Call `AskUserQuestion` alone to confirm both:

1. a human reviewed every listed label against the raw candidate context;
2. the exact expanded destination is a new private reviewed-corpus file.

If exclusive creation reports a collision, choose a new literal path and repeat
this confirmation; never overwrite or silently redirect the output.

Only after confirmation run, using the digest from the export resume ticket:

```bash
bun <skill-dir>/scripts/analyze.ts review \
  --candidate-file <absolute-candidates.jsonl> \
  --candidate-sha256 <exported-candidate-sha256> \
  --labels <absolute-labels.json> \
  --output <absolute-new-reviewed.jsonl> \
  --confirm-human-labels
```

The analyzer verifies the candidate bytes still match the human-reviewed export
digest. On mismatch, stop without output: do not recompute or replace the ticket
digest. A changed candidate requires a new export and a new offline human
review before retrying. The analyzer rejects duplicate/unknown labels,
pre-labeled candidates, non-private candidate files, duplicate decision IDs,
command/hash mismatches, oversized artifacts, unsafe output directories, and
existing outputs. It copies only explicit `allow|ask` labels and marks them
`labelSource: "human-review"`.

Path-only acceptance rules are: audit log directories, labels parents, and
output parents are current-user `0700` real directories; audit, candidate, and
labels inputs are current-user regular `0600` files with one link; and outputs
are newly created `0600` regular files. Symlink inputs, existing outputs, changed
inode identities, and labels changed during reading are rejected.

No analyzer command or approval question is retried automatically. Each failure
stops; a later user correction or explicit retry begins one new attempt.

On labels format/ID/permission failure, no reviewed output is created. The human
must correct and re-check labels outside pi, then repeat the human/output
confirmation; the candidate ticket remains valid only if its digest still
matches. An output I/O failure may leave an unusable private path: never treat it
as a corpus or overwrite it; approve a different new output path. On candidate
digest mismatch, invalidate the old ticket and the previously approved reviewed
output path. Follow the full sequence with the same selected window: Phase 3
export to a different new candidate path, new ticket, offline review into a new
labels file, confirmation of a different new reviewed output path, then review.

## Phase 5: Report and promotion boundary

Never fabricate analyzer values, hashes, causes, or trends. Report only values
returned by commands that actually completed. If analysis was not run or was
blocked waiting for approval, state that no result is available and report the
stopping point.

Report only:

- analyzed file/record/diagnostic counts;
- body-free aggregate findings;
- candidate/reviewed corpus paths and counts;
- skipped or blocked operations.

Do not print corpus bodies. Call the reviewed JSONL a human-reviewed staging
corpus for manual promotion, not a checked-in qualification corpus or active
release gate. Until Phase 4 succeeds, report that both the reviewed staging
corpus and checked-in qualification corpus remain ungenerated.

If the user asks to promote samples into the checked-in qualification corpus:

1. start a separate `start-work` task;
2. have the human select and sanitize fixtures locally outside pi, then
   explicitly approve only those sanitized fixtures for the new task;
3. manually translate only the approved sanitized fixtures while preserving
   task/run/project context needed by qualification;
4. add focused tests;
5. run `bun run qualify:pi-permission-judge --summary`;
6. reject any change that introduces a false ALLOW.

Never convert a reviewed sample directly into a deterministic ALLOW rule.
