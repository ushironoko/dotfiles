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
- pi currently has a public focus setter but no public focus getter. The one
  private getter seam is capability-isolated. If a pi update removes or changes
  it, the resident list becomes passive, Down is left entirely to the editor,
  and `/subagents` / `Ctrl+Alt+S` opens a fresh public `ui.custom` overlay. The
  degradation warns once and never disables child execution or other harness
  features.
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
8. With the private focus capability disabled in a test runtime, confirm Down
   remains native and `/subagents` opens/closes the public overlay fallback.
9. Resume the parent session and confirm completed transcripts open from the
   beginning and remain scrollable within the documented retention bounds.
