# Authoring report HTML for SVG conversion

You author the HTML; satoru turns it into the SVG. The quality of the SVG is the
quality of your HTML. Aim for a clean, information-dense, graphical layout — not a wall
of text. litehtml (satoru's layout engine) supports the common subset of HTML/CSS:
flexbox, grid, borders, border-radius, gradients, tables, web fonts.

**Follow the design format in `design-format.md` for every report** — a structure-first,
low-chroma style where structure and reading flow (not color) carry the meaning. The
template below already implements it; start from that template.

## Rules that matter for satoru

- **No `<!DOCTYPE html>`.** Start at `<html>` (see the gotcha in `satoru-render.md`).
- **Set the `font-family` to `'IBM Plex Sans JP'`** (the standard font for this format;
  see `design-format.md`). It covers Latin + Japanese and satoru fetches it from Google
  Fonts at render time (network required — see `satoru-render.md`). For code use
  `'IBM Plex Mono'` with `'IBM Plex Sans JP'` as the fallback.
- **Give `body` an explicit background.** Otherwise it is white. Pick light or dark
  intentionally.
- **Inline everything.** One `<style>` block; no external CSS/JS files. JS does not run
  with `--no-jsdom`, so charts must be pure CSS/HTML (or pre-computed inline SVG).
- **Size with `width`, let height auto-fit.** Design for the `-w` you will pass
  (e.g. 760). Avoid `100vh` and viewport units; lay out top-to-bottom and let content
  set the height.
- **Use CSS, not images, for graphics.** Bars, rings, badges, tables render crisply as
  vectors. Remote `<img>` needs network and adds fragility.

## Layout patterns

- **KPI cards:** a flex row of equal-width cards, each a label + a big value.
- **Bar / progress chart:** a track `<div>` with a filled `<div>` whose `width: N%`
  encodes the value; a single muted accent fill, with the number printed alongside.
- **Tables:** plain `<table>` with `border-collapse`, a hairline header underline and
  hairline row separators (no zebra fills); numbers right-aligned in monospace.
- **Sections:** a heading + subtitle, generous padding, a hairline divider between groups.
- **Status list:** a glyph (`● ◐ ○`) + identifier + plain note, with a legend — state is
  shown by glyph and word, never by color (see `design-format.md`, rule 4).

## Verified template (renders cleanly, Japanese + graphics)

This exact HTML was rendered to SVG and PNG and verified visually. It implements the
design format in `design-format.md`: a low-chroma ink ramp with a single muted slate
accent, hairline dividers, typographic hierarchy, code identifiers in monospace, and
status shown by glyph + word rather than color. Adapt the content; keep the structure.

```html
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      :root {
        --bg: #faf8f5;
        --surface: #ffffff;
        --hairline: #e4e0d8;
        --ink-strong: #1b1a18;
        --ink: #3d3b37;
        --ink-muted: #6f6b64;
        --accent: #5b6770;
        --mono: "IBM Plex Mono", "IBM Plex Sans JP", monospace;
      }
      body {
        font-family: "IBM Plex Sans JP", sans-serif;
        background: var(--bg);
        color: var(--ink);
        padding: 40px 44px;
        font-size: 13px;
        line-height: 1.6;
      }
      .eyebrow {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--ink-muted);
        margin-bottom: 6px;
      }
      h1 {
        font-size: 23px;
        font-weight: 700;
        color: var(--ink-strong);
        letter-spacing: 0.01em;
      }
      .sub {
        font-size: 13px;
        color: var(--ink-muted);
        margin-top: 4px;
      }
      .rule {
        height: 1px;
        background: var(--hairline);
        margin: 28px 0;
      }
      h2 {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--ink-muted);
        margin-bottom: 16px;
      }
      .kpis {
        display: flex;
      }
      .kpi {
        flex: 1;
        padding: 0 20px;
        border-left: 1px solid var(--hairline);
      }
      .kpi:first-child {
        padding-left: 0;
        border-left: none;
      }
      .kpi .label {
        font-size: 12px;
        color: var(--ink-muted);
      }
      .kpi .value {
        font-size: 28px;
        font-weight: 700;
        color: var(--ink-strong);
        margin-top: 6px;
      }
      .kpi .delta {
        font-size: 12px;
        color: var(--ink-muted);
        margin-top: 4px;
      }
      .bars {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .bar-row {
        display: grid;
        grid-template-columns: 96px 1fr 56px;
        align-items: center;
        gap: 16px;
      }
      .bar-name {
        font-size: 13px;
        color: var(--ink);
      }
      .bar-track {
        height: 8px;
        background: var(--surface);
        border: 1px solid var(--hairline);
        overflow: hidden;
      }
      .bar-fill {
        height: 100%;
        background: var(--accent);
      }
      .bar-val {
        font-family: var(--mono);
        font-size: 13px;
        color: var(--ink);
        text-align: right;
      }
      .status {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .status-row {
        display: grid;
        grid-template-columns: 18px 150px 1fr;
        align-items: baseline;
        gap: 12px;
      }
      .mark {
        font-size: 13px;
        color: var(--ink-strong);
      }
      .status-name {
        font-family: var(--mono);
        font-size: 13px;
        color: var(--ink-strong);
      }
      .status-note {
        font-size: 13px;
        color: var(--ink-muted);
      }
      .legend {
        margin-top: 16px;
        font-size: 12px;
        color: var(--ink-muted);
      }
    </style>
  </head>
  <body>
    <div class="eyebrow">四半期レポート</div>
    <h1>売上サマリー</h1>
    <div class="sub">2026年Q2 / 単位: 百万円</div>

    <div class="rule"></div>

    <h2>主要指標</h2>
    <div class="kpis">
      <div class="kpi">
        <div class="label">総売上</div>
        <div class="value">¥1,240</div>
        <div class="delta">前年同期比 +18%</div>
      </div>
      <div class="kpi">
        <div class="label">新規顧客</div>
        <div class="value">342</div>
        <div class="delta">前年同期比 +27%</div>
      </div>
      <div class="kpi">
        <div class="label">解約率</div>
        <div class="value">2.1%</div>
        <div class="delta">前年同期比 −0.4pt</div>
      </div>
    </div>

    <div class="rule"></div>

    <h2>地域別売上</h2>
    <div class="bars">
      <div class="bar-row">
        <div class="bar-name">東日本</div>
        <div class="bar-track">
          <div class="bar-fill" style="width: 82%"></div>
        </div>
        <div class="bar-val">¥508</div>
      </div>
      <div class="bar-row">
        <div class="bar-name">西日本</div>
        <div class="bar-track">
          <div class="bar-fill" style="width: 64%"></div>
        </div>
        <div class="bar-val">¥397</div>
      </div>
      <div class="bar-row">
        <div class="bar-name">海外</div>
        <div class="bar-track">
          <div class="bar-fill" style="width: 38%"></div>
        </div>
        <div class="bar-val">¥235</div>
      </div>
    </div>

    <div class="rule"></div>

    <h2>施策の状況</h2>
    <div class="status">
      <div class="status-row">
        <div class="mark">●</div>
        <div class="status-name">price_revision</div>
        <div class="status-note">完了 — 全プランに適用済み</div>
      </div>
      <div class="status-row">
        <div class="mark">◐</div>
        <div class="status-name">onboarding_v2</div>
        <div class="status-note">進行中 — 解約率の改善を計測中</div>
      </div>
      <div class="status-row">
        <div class="mark">○</div>
        <div class="status-name">overseas_expansion</div>
        <div class="status-note">未着手 — Q3に着手予定</div>
      </div>
    </div>
    <div class="legend">
      ● 完了 &nbsp; ◐ 進行中 &nbsp; ○ 未着手 —
      状態は記号と文言で示し、色には依存しない
    </div>
  </body>
</html>
```

Render it:

```bash
satoru-render "$TMPDIR/report.html" -o report.svg -w 760 --no-jsdom
```

(Run with the sandbox disabled when the report contains Japanese / web-font text, so
the Google Fonts fetch succeeds — otherwise the text drops out. See `satoru-render.md`.)

## Design notes

These restate the design format (`design-format.md`) as quick reminders:

- Pick light (reads as a document) or dark (reads as a console) from the ramps in
  `design-format.md`. Keep one neutral ink ramp plus a single muted accent — no
  saturated primaries, and never green/red/yellow/blue to mark meaning.
- Carry meaning with structure, hierarchy, and top-to-bottom flow, not color. Encode
  status with a glyph + word (`● ◐ ○`), not a colored dot alone.
- Encode quantities by length (bar widths, ring fills) and print the number too; a
  single neutral fill, never one color per series.
- Build hierarchy from size/weight/letter-spacing/case. Put code identifiers in
  monospace. Keep running text short — restructure anything past ~2 lines into a list.
- Leave breathing room on one spacing scale (`4/8/16/24/32/40px`); gaps signal grouping.
  Cramped layouts look generic.
- For long reports, stack sections separated by hairline rules rather than forcing one
  screen.
- Where explanation is needed, write paragraphs led by their conclusion (topic sentence
  first) and order sections so understanding builds in stages — premise, then dependent
  detail, then result.
- Define every symbolic label (`A-1`, codes, acronyms) in a footnote/glossary block at
  the bottom; render the token the same way (monospace) in the body and the note.
