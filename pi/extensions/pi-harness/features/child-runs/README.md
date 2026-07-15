# Child-session browser

The pi-harness `subagent` and `workflow` tools expose their child runs in a
resident TUI browser.

## Behavior

- The first child invocation mounts a non-capturing overlay on the right.
- The overlay is visible at terminal widths of 120 columns or more and never
  steals focus from the main editor.
- `/subagents` or `Ctrl+Alt+S` shows and focuses the browser.
- `Esc` returns focus to the main session while leaving the overlay visible.
- `q` hides the overlay. A new child run, `/subagents`, or the shortcut shows
  it again.
- Arrow keys select runs and scroll transcripts. Enter opens a run, Left or
  `b` returns to the list, and End resumes live-follow mode.
- On narrow terminals the normal subagent/workflow tool row remains the live
  status fallback.

Closing, hiding, or unfocusing the browser never cancels child execution.

## Retention and privacy

Children still run with `--no-session`; browser entries are view-only and
cannot be resumed or forked as native pi sessions.

The parent tool-result details persist a versioned, bounded transcript so
completed runs remain inspectable after resuming the parent session. The
persisted browser payload contains only:

- child identity, task/stage metadata, status, and timestamps;
- finalized assistant text;
- local tool ordinals, tool names, and success/failure status;
- synthetic truncation markers.

It does **not** retain live drafts, thinking blocks, tool arguments,
tool-result bodies, stderr, images, signatures, provider/response IDs, raw
tool-call IDs, working directories, or `{previous}`-expanded prompts.

Limits:

- 16 KiB per finalized assistant item;
- 256 items and 64 KiB per run;
- 512 KiB per invocation, divided fairly across runs;
- the newest 32 invocations / 2 MiB when replaying browser history.

Malformed or oversized child-stream diagnostics are live-only and never echo
raw source data.

## Interactive smoke check

1. Start pi in a terminal at least 120 columns wide.
2. Launch a parallel `subagent` call or a multi-task `workflow`.
3. Confirm the right overlay appears without taking editor focus.
4. Press `Ctrl+Alt+S`, select a running child, and verify live updates.
5. Press `Esc` and confirm normal editor input continues.
6. Press `q`, then run `/subagents` and confirm the same browser reappears.
7. Resume the parent session and confirm completed transcripts are restored.
