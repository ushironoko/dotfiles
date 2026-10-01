# Figures with arrows: authoring and the visual fix loop

Box-and-arrow figures (flows, dependencies, pipelines) are the part of a report most
likely to be wrong in a way the source does not show: an arrow that starts at the wrong
box, a tip that points backwards, a line hidden behind an unrelated box, two lines that
merge so a reader cannot tell which goes where. `scripts/figure-check.ts` measures the
rendered figure and produces images to look at, so these are found and fixed before the
SVG ships. The loop is adapted from mizchi/explainer (`figure-check.mjs` /
`figure-arrows.mjs`, MIT) and uses vlmkit for page-level gates.

## When to draw one

Draw a figure only when the content has 4+ elements with relations, a time order, or
containment. One sentence, one value, or one function body does not need a figure.

## What satoru can and cannot render (verified with satoru-render 1.0.13 and 1.0.15)

Inside an inline `<svg>`, satoru renders strokes and filled shapes only. It **drops**
`<text>`, `<marker>` (so `marker-end` arrowheads vanish), and `<foreignObject>`. The
command still exits 0. Therefore:

- Boxes and every piece of text are **HTML elements**, absolutely positioned.
- Lines and arrowheads are **SVG**, and each arrowhead is an explicit filled `<path>`.

## Authoring contract

```html
<div
  class="figure"
  data-figure
  data-flow="right"
  style="position:relative;width:600px;height:120px"
>
  <svg
    width="600"
    height="120"
    viewBox="0 0 600 120"
    style="position:absolute;left:0;top:0"
  >
    <g data-edge="cli->core">
      <path d="M130,60 L240,60" stroke="#3d3b37" fill="none" />
      <path d="M240,60 l-9,-5 l0,10 z" fill="#3d3b37" />
    </g>
  </svg>
  <div class="node" data-node="cli" style="left:10px;top:40px">
    <code>cli</code>
  </div>
  <div class="node" data-node="core" style="left:240px;top:40px">
    <code>core</code>
  </div>
  <div class="note" style="left:150px;top:36px">呼び出し</div>
</div>
```

- `data-figure` on the container; one container per figure. `data-flow`
  (`down|up|right|left`) declares the reading direction so backward edges are reported.
- `data-node="<id>"` on each box. Ids are ASCII; the visible label is the element text.
- `data-edge="<from>-><to>"` on a `<g>` holding exactly one stroked line (`fill="none"`)
  drawn **from `from` to `to`**, plus one filled arrowhead path at the `to` end.
- Start and end each line on the edge of its box (within 12px). Put the SVG first in the
  container so HTML boxes sit above it.
- Keep the figure width ≤ the report content width (`-w` minus body padding).
- Follow `design-format.md`: one neutral stroke color, no color-coded edges; label edges
  with HTML text placed beside the line, never on it.

## The loop (render → measure → look → fix), at most 5 rounds

```bash
bun ~/.claude/skills/html-to-svg/scripts/figure-check.ts "$TMPDIR/report.html" -w 760
```

Run it with the sandbox disabled (Chromium and satoru fetch Google Fonts). Options:
`--width <px>` (match the satoru `-w`), `--out <dir>` (default
`$TMPDIR/figure-check/<name>`), `--json <file>`, `--skip-vlmkit`.

1. **Machine checks — get every ✗ to 0.**

   | Mark | Kind         | Meaning                                                                          |
   | ---- | ------------ | -------------------------------------------------------------------------------- |
   | ✗    | `detached`   | line does not start at `from` / end at `to`, or runs backwards                   |
   | ✗    | `arrowhead`  | no tip, tip at the start side, or tip away from the line's end                   |
   | ✗    | `shared`     | two lines run together ≥ 40px; the fork reads as a different arrow               |
   | ✗    | `through`    | a line passes through a box that is not its endpoint                             |
   | ✗    | `over-label` | a line passes through a free-standing label                                      |
   | △    | `cross`      | lines cross — accept only if unavoidable                                         |
   | △    | `detour`     | a line is far longer than the distance between its ends                          |
   | △    | `against`    | an edge runs against `data-flow` — confirm it is an intended back-edge           |
   | ✗    | vlmkit       | `check integrity` (text collision, clipping, overflow) and `check a11y contrast` |

2. **Look — open every `look at:` image with Read.**
   - `<name>.png` is the satoru render, i.e. what ships. Check reading order (entry at
     top or left), labels pointing at the right thing, cramped or empty regions, and
     that nothing satoru dropped (text, tips) is missing.
   - `<name>.figureN.edges.png` highlights one edge per tile in red. For each tile ask:
     reading only the red line, can I tell where it starts and where it points, and does
     that match the tile title `from → to`? Does it seem to switch onto another line at a
     fork or merge? Tiles outlined in red were flagged by a ✗ or △.
3. **Fix** the coordinates in the HTML: move boxes, reroute lines with elbows
   (`M x,y L x,y2 L x2,y2`), shorten labels, or change the layout direction. If a ✗
   cannot be removed by moving things, restructure the figure (split it, fewer nodes,
   vertical flow).
4. Re-run. After 5 rounds without a clean result, replace the figure with a table or a
   list.

A clean machine verdict is not the end: always do step 2 at least once.

## Dependencies

```bash
bun install -g playwright@1.63.0 @mizchi/vlmkit@0.23.0
~/.bun/bin/playwright install chromium
```

The script loads `playwright` from bun's global install
(`$BUN_INSTALL/install/global`, default `~/.bun/install/global`) and calls `vlmkit` and
`satoru-render` from PATH. vlmkit needs Node 24+.
