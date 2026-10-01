---
name: html-to-svg
description: Turn a report into a portable SVG by authoring a structured/graphical HTML layout and rendering it to SVG with satoru-render. Use when the user asks to compile, summarize, or visualize a report, or wants graphical output that stays viewable in environments that cannot render HTML (chat, PDF viewers, image-only tools, git diffs). Proactively offer SVG output whenever you produce a report that benefits from layout, charts, tables, or styling.
---

# html-to-svg

Author a report as HTML (structure + graphics, your judgment), then render it to a
single self-contained SVG with [`satoru-render`](https://github.com/SoraKumo001/satoru).
The SVG embeds every glyph as a vector path, so the result is portable: it renders
identically anywhere an SVG can be shown, with no font or HTML engine required to view it.

## When to use

- The user asks to "compile / summarize / write up a report" and the content benefits
  from layout: tables, bar/progress charts, timelines, sections.
- The user wants a graphic that survives environments without an HTML renderer.
- Proactively: when you are about to output a structured report, offer to also produce
  an SVG version. Confirm before doing extra work if the user only asked for text.

Do **not** use it for plain prose, code, or anything that reads fine as Markdown.

## Prerequisite

`satoru-render` (a WASM HTML→SVG/PNG/PDF engine, no browser/Puppeteer) must be on PATH.
Install once, pinned:

```bash
bun install -g satoru-render@1.0.13
```

Check with `which satoru-render`; install it if missing. It is npm-distributed, so per
project convention it is installed with `bun install -g`, not mise/ubi.

Reports with box-and-arrow figures also need the figure checker's dependencies
(`references/figures.md` → Dependencies):

```bash
bun install -g playwright@1.63.0 @mizchi/vlmkit@0.23.0
~/.bun/bin/playwright install chromium
```

## Workflow

1. **Author the HTML.** Design a structured, graphical layout for the report content.
   Use inline `<style>` and CSS-only graphics (flexbox/grid, bars, tables).
   **Follow the design format in `references/design-format.md`** — structure-first and
   low-chroma: structure, hierarchy, and reading flow carry the meaning, not color
   (no saturated primaries; no color-only labels). `references/html-authoring.md` has a
   render-verified template that already implements it — start from that template.
   - Omit `<!DOCTYPE html>` — start at `<html>` (see the gotcha below).
   - Set `font-family: 'IBM Plex Sans JP', sans-serif;` (the standard font for this
     format; covers Latin + Japanese) — satoru fetches it from Google Fonts at render
     time. Write the HTML to a temp file, e.g. `$TMPDIR/report.html`.
   - Box-and-arrow figures follow the contract in `references/figures.md`: boxes and
     text as positioned HTML (`data-node`), lines and filled arrowheads as SVG
     (`data-edge`). satoru drops SVG `<text>`, `<marker>`, and `<foreignObject>`.

2. **Render to SVG.** Output extension `.svg` selects the format automatically:

   ```bash
   satoru-render "$TMPDIR/report.html" -o report.svg -w 760 --no-jsdom
   ```

   - `-w` sets width; omit `-h` so height auto-fits the content.
   - `--no-jsdom` is correct for static HTML (faster, no extra dependency).

3. **Verify.** Confirm the SVG was written and is non-trivial. If the report contains
   non-ASCII text, check the glyphs actually rendered — see the network caveat below.

4. **Fix figures (only when the report has a `data-figure`).** Run
   `bun ~/.claude/skills/html-to-svg/scripts/figure-check.ts "$TMPDIR/report.html" -w 760`
   with the sandbox disabled, clear every ✗, then open each `look at:` image with Read
   and check every arrow's start, end, and direction by eye. Edit the HTML and repeat
   (max 5 rounds), then re-render step 2. Details: `references/figures.md`.

5. **Deliver.** Surface the file with `SendUserFile`. Offer to clean up the temp HTML.

## Critical caveat: fonts are fetched over the network at render time

satoru resolves non-system fonts (including the format's **IBM Plex Sans JP**) from
Google Fonts **during conversion**. Claude Code's default Bash sandbox blocks those hosts, so Japanese
and other web-font text **silently disappears** from the output (structure renders, text
is blank) while the command still exits 0.

When the report has non-ASCII or web-font text, run the conversion with network egress to
`fonts.googleapis.com` and `fonts.gstatic.com` (and `cdn.jsdelivr.net` if you use emoji) —
i.e. run the `satoru-render` Bash call with the sandbox disabled. If glyphs are missing,
this is almost always the cause. Details and the local-font workaround are in
`references/satoru-render.md`.

## References

- `references/design-format.md` — the default design format: the eight rules (whitespace,
  structure, plain language, no color-coded labels, low-chroma palette, paragraph writing
  in ordered sections, gloss every symbolic label, no headline tallies), the palette ramps, typography scale,
  and the patterns that follow them.
- `references/satoru-render.md` — full CLI/API reference, all flags, the font/network
  requirement, the DOCTYPE gotcha, and other output formats.
- `references/figures.md` — box-and-arrow figure contract (HTML boxes + SVG lines),
  what satoru drops inside SVG, and the figure-check loop (arrow checks, per-edge
  highlight sheets, vlmkit gates).
- `references/html-authoring.md` — a render-verified report HTML template (implementing
  the design format) and authoring guidance (CSS-only charts, Japanese fonts, layout
  patterns).
