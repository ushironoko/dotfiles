# Child-session browser

The pi-harness `subagent` and `workflow` tools expose their child runs in a
resident full-width TUI browser between the chat editor and statusline.

## Behavior

- `subagent` and `workflow` validate and return an invocation ID immediately;
  their child pi processes continue asynchronously while the parent is free to
  do other work.
- The first child invocation mounts the browser in pi's `belowEditor` widget
  slot without stealing focus from the main editor.
- The browser receives the full terminal content width and remains in normal
  layout flow, so it does not cover chat or editor content.
- Its height is approximately one quarter of the terminal, clamped to 4–10
  lines. The cap preserves useful editor and conversation space on common
  24-row and 40-row terminals; extremely short terminals may still be tight.
- `/subagents` or `Ctrl+Alt+S` shows and focuses the browser.
- When a cursor-aware editor has focus, Down keeps its native cursor/history
  behavior. If native Down changes neither editor text nor cursor at the bottom
  boundary, focus moves to the browser with its current run selected.
- Down transfer is best-effort: editors without `getText()` and `getCursor()`
  retain native Down handling and use `/subagents` or `Ctrl+Alt+S` for explicit
  focus. Remapped Down is honored when the editor's runtime keybindings manager
  is detectable; otherwise default terminal sequences are used.
- `Esc` returns focus to the main editor while leaving the browser visible.
- `q` hides the browser. A new child run, `/subagents`, or the shortcut shows
  it again.
- In the resident list, arrow keys only select runs. Enter opens the selected
  run in a focused, near-full-screen overlay; raw Enter sequences are accepted
  even when the editor keybinding adapter cannot classify them.
- In the detail overlay, arrow keys only scroll that fixed transcript.
  PageUp/PageDown move by a viewport, Home/End jump to the beginning/live end,
  and Escape, Left, `b`, or `q` closes the overlay and returns to the list.
- Completed transcripts open at the beginning. Running transcripts open in
  live-follow mode; scrolling upward pauses follow until End is pressed.
- The normal subagent/workflow tool row remains a compact status summary.

Closing, hiding, or unfocusing the browser never cancels child execution.

When an invocation completes, pi-harness persists its bounded transcript,
adds one explicitly untrusted aggregate result to the parent context, and
requests an automatic follow-up parent turn. Completion delivery is serialized:
only one result is handed to pi at a time, while later results remain in the
manager-local queue until the preceding notification turn settles.

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

A dedicated parent custom entry persists a versioned, bounded transcript so
completed background runs remain inspectable after resuming the parent
session. Legacy synchronous tool-result transcript entries remain readable. The
persisted browser payload contains only:

- child identity, task/stage metadata, status, and timestamps;
- engine-created worktree paths that are intentionally left in place;
- finalized assistant text;
- local tool ordinals, tool names, and success/failure status;
- synthetic truncation markers.

It does **not** retain live drafts, thinking blocks, tool arguments,
tool-result bodies, stderr, images, signatures, provider/response IDs, raw
tool-call IDs, arbitrary task working directories, or `{previous}`-expanded
prompts.

Limits:

- four child pi processes across all concurrent `subagent` and `workflow` invocations;
- eight retained background invocations, including manager-local completions and the single active notification turn;
- 16 KiB per finalized assistant item;
- 256 items and 64 KiB per run;
- 512 KiB per invocation, divided fairly across runs;
- the newest 32 completed invocations / 2 MiB in both live and replayed
  browser history; active invocations are retained until completion.

Malformed or oversized child-stream diagnostics are live-only and never echo
raw source data.

## Interactive smoke check

1. Start pi and launch a parallel `subagent` call or a multi-task `workflow`.
2. Confirm the full-width list appears below the editor and above the
   statusline without taking editor focus.
3. In a multi-line draft, press Down and confirm native cursor movement still
   works; at the bottom boundary, press Down again and confirm list focus.
4. Select a running child, press Enter, and confirm its near-full-screen detail
   overlay opens with live updates.
5. Press Up/PageUp and confirm the transcript scrolls while the selected run
   remains fixed; press End and confirm live-follow resumes.
6. Press Escape and confirm focus returns to the resident list, then Escape
   again and confirm normal editor input continues.
7. Press `q` in the list, then run `/subagents` and confirm it reappears.
8. Resume the parent session and confirm completed transcripts open from the
   beginning and remain scrollable within the documented retention bounds.
