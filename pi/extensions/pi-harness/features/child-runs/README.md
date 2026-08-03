# Coordination browser

pi-harness exposes child runs, open local `bit issue` records, and project
memory in one resident full-width TUI browser between the chat editor and
statusline. It deliberately uses one `belowEditor` widget and one focus owner
for all sources.

## Behavior

- `subagent` and `workflow` validate and return an invocation ID immediately;
  their child pi processes continue asynchronously while the parent is free to
  do other work.
- The parent model can call `subagent_status` with that invocation ID for a
  one-off, non-blocking inspection. It returns each run's current state, live
  draft when available, and recent sanitized assistant/tool activity. It covers
  both `subagent` and `workflow` invocations, including retained completions.
- The first child invocation mounts the browser in pi's `belowEditor` widget
  slot without stealing focus from the main editor.
- When `bit-task` is enabled, `session_start` refreshes open issues in the
  current Git repository. One or more open issues also mount the browser without
  stealing editor focus. Closed issues are never listed.
- The browser has no aggregate header, source counts, or source section titles.
  One flat scrollable list places child rows first, open issue rows second, and
  project-memory rows last at the same visual level. Issues are sorted by
  `updated_at` descending and stable issue id; memory is sorted by path and
  capped to the same 50-entry bounded index used for startup recall. Child
  status icons use the active theme's semantic status colors (`success`,
  `error`, and the existing warning/dim mappings), and overlong rows end with a
  width-safe ellipsis.
- The browser receives the full terminal content width and remains in normal
  layout flow, so it does not cover chat or editor content.
- Its height is approximately one quarter of the terminal, clamped to 4–10
  lines. The cap preserves useful editor and conversation space on common
  24-row and 40-row terminals; extremely short terminals may still be tight.
- `/subagents` or `Ctrl+Alt+S` shows and focuses the browser with a child row
  preferred. `/bit-issues` or `Ctrl+Alt+I` refreshes and focuses it with an
  issue row preferred. `/project-memory` or `Ctrl+Alt+M` refreshes and focuses
  it with a project-memory row preferred.
- When a cursor-aware editor has focus, Down keeps its native cursor/history
  behavior. If native Down changes neither editor text nor cursor at the bottom
  boundary, focus moves to the browser with its current run selected.
- Down transfer is best-effort: editors without `getText()` and `getCursor()`
  retain native Down handling and use `/subagents` or `Ctrl+Alt+S` for explicit
  focus. Remapped Down is honored when the editor's runtime keybindings manager
  is detectable; otherwise default terminal sequences are used.
- pi currently has a public focus setter but no public focus getter. The one
  private getter seam is capability-isolated. If a pi update removes or changes
  it, the resident list becomes passive, Down is left entirely to the editor,
  and the explicit browser commands open a fresh public `ui.custom` overlay. The
  degradation warns once and never disables child execution or other harness
  features.
- `Esc` returns focus to the main editor while leaving the browser visible.
- `q` hides the browser. Automatic issue refresh does not remount an explicitly
  hidden browser. A new child run or either explicit browser command shows it
  again.
- In the resident list, Up/Down, `j`/`k`, and PageUp/PageDown select across all
  row kinds. Enter or Right opens the selected child, issue, or project-memory
  entry. `x` aborts the selected active child invocation; parallel, chain, and
  workflow siblings in that invocation stop together. Completed children,
  issue rows, and memory rows remain unchanged. `r` refreshes open issues and
  project memory without polling or relay-backed watch behavior.
- Child, issue, and project-memory details use the same focused, zero-margin
  full-terminal overlay, covering the resident panes in both dimensions.
  Project-memory detail is read-only and shows its path, description, content,
  update time, and source-ref provenance. PageUp/PageDown move
  by a viewport, Home/End jump to the ends, and Escape, Left, `b`, or `q` closes
  the overlay and returns to the list. Child details retain live-follow behavior
  and accept the same `x` kill action while the invocation is active. Transcript
  text, issue bodies, and comments use the theme's primary `text` color rather
  than the secondary tool-output color.
- Issue detail is loaded lazily with `bit issue get <id> --format json`, then
  bounded raw output from `bit issue comment list <id>`. It shows metadata,
  labels, body, and comments read-only. Human-readable comment output is not
  parsed into synthetic comment records.
- Completed transcripts open at the beginning. Running transcripts open in
  live-follow mode; scrolling upward pauses follow until End is pressed.
- The normal subagent/workflow tool row remains a compact status summary.

Closing, hiding, or unfocusing the browser never cancels child execution. Only
an explicit `x` on an active child requests termination, records
`user-killed`, and preserves normal persistence and parent completion delivery.
Issue refresh also runs after the agent settles, when the panel gains focus,
on explicit refresh, and immediately before issue detail loading. Project
memory refresh is intentionally narrower because its aggregate may invoke many
bounded Git/bit commands: it runs at session start, on `r`, through the explicit
memory command/shortcut, and after a successful `memory_update`. Refresh is
single-flight and session-generation guarded; failures retain a stale
last-known-good list.

When an invocation completes, pi-harness persists its bounded transcript,
adds one explicitly untrusted aggregate result to the parent context, and
requests an automatic follow-up parent turn. Completion delivery is serialized:
only one result is handed to pi at a time, while later results remain in the
manager-local queue until the preceding notification turn settles.

Whenever that background delivery runtime is available, pi-harness also
appends parent system-prompt guidance before every agent run. It permits a
one-off `subagent_status` inspection when current progress is useful, while
still forbidding `sleep`, shell polling, repeated status checks, or other
blocking waits: the parent may continue independent work, but otherwise must
return control to pi until the automatic completion message starts the next
turn. The guidance is omitted for the legacy synchronous fallback, where the
tool call itself waits and returns the final result.

A permission-policy block in a no-UI child emits a diagnostic signal bound to a
random per-spawn token and makes that child run fail even if the model responds
with a normal final message and pi exits zero. The signal is filtered from child
stderr, transcripts, and persistence; marker-like text in ordinary tool output
is ignored. Only the `permission-blocked` classification is retained, and
parent-session permission messages keep their existing text.

Background child runs require persistent TUI or RPC mode. Print (`-p`) and JSON
modes reject `subagent` and `workflow` before side effects because the parent
process would exit before completion delivery. A `/tree` request aborts and
persists active invocations on the old branch before navigation, without
sending their result to the destination branch. If a completion-triggered
parent turn has already been handed to pi, that navigation attempt is cancelled
because pi exposes no queue-retraction API; retry `/tree` after the turn settles.
Unsent manager-local completions are discarded at the first request. If a
later extension cancels navigation after pi-harness has prepared the boundary,
background admission stays conservatively paused until session reload/resume
because pi exposes no post-cancellation event. Session replacement and shutdown
likewise abort active process groups.

## Retention and privacy

Children still run with `--no-session`; browser entries are view-only and
cannot be resumed or forked as native pi sessions.

Bit issue and project-memory rows and detail are also view-only. pi-harness
never updates, closes, reopens, or comments on an issue from the TUI. Memory
updates remain available only through the parent `memory_update` tool. Issue
bodies, comments, and memory content remain registry-local TUI state: they are
not sent to the LLM, appended to pi session JSONL, or copied into child
transcript persistence. Every untrusted title, body, label, author, comment,
memory description, and memory content line is terminal-control sanitized and
Unicode-width bounded before rendering.

The adapter resolves an absolute Git common directory first, then directly
spawns only `bit issue list --open --all --limit 101 --format json`, `bit issue
get`, and `bit issue comment list` with a scrubbed child environment and the
verified `GIT_DIR`. List/detail/comment output, stderr, time, and cancellation
are bounded. Relay, import, sync, claim, and watch commands are never used.

A dedicated parent custom entry persists a versioned, bounded transcript so
completed background runs remain inspectable after resuming the parent
session. Legacy synchronous tool-result transcript entries remain readable. The
persisted browser payload contains only:

- child identity, task/stage metadata, status, and timestamps;
- engine-created worktree paths that are intentionally left in place;
- finalized assistant text;
- local tool ordinals, tool names, and success/failure status;
- synthetic truncation markers.

It does **not** persist live drafts, thinking blocks, tool arguments,
tool-result bodies, stderr, images, signatures, provider/response IDs, raw
tool-call IDs, arbitrary task working directories, or `{previous}`-expanded
prompts. `subagent_status` may expose the current in-memory live draft, but it
uses the same terminal-control sanitization, never exposes tool arguments or
results, and wraps child text in an explicit untrusted JSON envelope. Like any
tool result, that bounded snapshot enters the parent model context and parent
session history; it is not additionally copied into child-run transcript
persistence.

Limits:

- four child pi processes across all concurrent `subagent` and `workflow` invocations;
- eight retained background invocations, including manager-local completions and the single active notification turn;
- 16 KiB per finalized assistant item;
- 256 items and 64 KiB per run;
- 512 KiB per persisted invocation, divided fairly across runs;
- 32 KiB per `subagent_status` response, with a fair per-run progress budget;
- the newest 32 completed invocations / 2 MiB in both live and replayed
  browser history; active invocations are retained until completion.

Malformed or oversized child-stream diagnostics are live-only and never echo
raw source data.

## Interactive smoke check

1. Start pi in a Git repository with an open local bit issue, or launch a
   parallel `subagent` call / multi-task `workflow`.
2. Confirm one full-width combined list appears below the editor and above the
   statusline without taking editor focus.
3. In a multi-line draft, press Down and confirm native cursor movement still
   works; at the bottom boundary, press Down again and confirm list focus.
4. Select a running child, press Enter, and confirm its full-terminal detail
   overlay covers the panes behind it and opens with live updates.
5. Press Up/PageUp and confirm the transcript scrolls while the selected run
   remains fixed; press End and confirm live-follow resumes.
6. Press Escape and confirm focus returns to the resident list, then Escape
   again and confirm normal editor input continues.
7. Select an issue, press Enter, and confirm its body and comments appear
   without entering chat/session history. Use `r` to refresh closed/open state.
8. Press `q`, trigger an automatic refresh, and confirm the browser stays
   hidden; then run `/subagents` or `/bit-issues` and confirm it reappears.
9. With the private focus capability disabled in a test runtime, confirm Down
   remains native and `/subagents` opens/closes the public overlay fallback.
10. Start a disposable child invocation, select one of its rows, press `x`, and
    confirm every active sibling in that invocation changes to `user-killed`
    after SIGTERM/SIGKILL cleanup while a completion reaches the parent.
11. Resume the parent session and confirm completed transcripts open from the
    beginning and remain scrollable within the documented retention bounds.
