# Child-session browser

The pi-harness `subagent` and `workflow` tools expose their child runs in a
resident full-width TUI browser between the chat editor and statusline.

## Behavior

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
- Arrow keys select runs and scroll transcripts. Enter opens a run, Left or
  `b` returns to the list, and End resumes live-follow mode.
- The normal subagent/workflow tool row remains a compact status summary.

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
- the newest 32 completed invocations / 2 MiB in both live and replayed
  browser history; active invocations are retained until completion.

Malformed or oversized child-stream diagnostics are live-only and never echo
raw source data.

## Interactive smoke check

1. Start pi and launch a parallel `subagent` call or a multi-task `workflow`.
2. Confirm the full-width browser appears below the editor and above the
   statusline without taking editor focus.
3. In a multi-line draft, press Down and confirm native cursor movement still
   works; at the bottom boundary, press Down again and confirm browser focus.
4. Select a running child and verify live updates.
5. Press `Esc` and confirm normal editor input continues.
6. Press `q`, then run `/subagents` and confirm the same browser reappears.
7. Resume the parent session and confirm completed transcripts are restored.
