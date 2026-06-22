# Authoring report HTML for SVG conversion

You author the HTML; satoru turns it into the SVG. The quality of the SVG is the
quality of your HTML. Aim for a clean, information-dense, graphical layout — not a wall
of text. litehtml (satoru's layout engine) supports the common subset of HTML/CSS:
flexbox, grid, borders, border-radius, gradients, tables, web fonts.

## Rules that matter for satoru

- **No `<!DOCTYPE html>`.** Start at `<html>` (see the gotcha in `satoru-render.md`).
- **Set an explicit `font-family`.** For Japanese use a CJK web font, e.g.
  `'Noto Sans JP'`; satoru fetches it from Google Fonts at render time (network
  required — see `satoru-render.md`).
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
  encodes the value; a gradient fill reads as a designed chart.
- **Tables:** plain `<table>` with `border-collapse`, zebra rows, a header band.
- **Sections:** a heading + subtitle, generous padding, a divider or card grouping.
- **Donut/ring:** `conic-gradient` background on a circle with a centered hole.

## Verified template (renders cleanly, Japanese + graphics)

This exact HTML was rendered to SVG and PNG and verified visually. Adapt the content;
keep the structure.

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
      body {
        font-family: "Noto Sans JP", sans-serif;
        background: #0f172a;
        color: #e2e8f0;
        padding: 32px;
      }
      h1 {
        font-size: 24px;
        color: #38bdf8;
        margin-bottom: 4px;
      }
      .sub {
        font-size: 13px;
        color: #94a3b8;
        margin-bottom: 24px;
      }
      .cards {
        display: flex;
        gap: 16px;
        margin-bottom: 24px;
      }
      .card {
        flex: 1;
        background: #1e293b;
        border-radius: 10px;
        padding: 16px;
        border: 1px solid #334155;
      }
      .card .label {
        font-size: 12px;
        color: #94a3b8;
      }
      .card .value {
        font-size: 28px;
        font-weight: 700;
        color: #f1f5f9;
        margin-top: 4px;
      }
      .bar-row {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 10px;
      }
      .bar-name {
        width: 90px;
        font-size: 13px;
      }
      .bar-track {
        flex: 1;
        background: #1e293b;
        border-radius: 6px;
        height: 18px;
        overflow: hidden;
      }
      .bar-fill {
        height: 100%;
        background: linear-gradient(90deg, #38bdf8, #818cf8);
      }
    </style>
  </head>
  <body>
    <h1>四半期レポート — 売上サマリー</h1>
    <div class="sub">2026年Q2 / 単位: 百万円</div>
    <div class="cards">
      <div class="card">
        <div class="label">総売上</div>
        <div class="value">¥1,240</div>
      </div>
      <div class="card">
        <div class="label">前年同期比</div>
        <div class="value">+18%</div>
      </div>
      <div class="card">
        <div class="label">新規顧客</div>
        <div class="value">342社</div>
      </div>
    </div>
    <div class="bar-row">
      <div class="bar-name">東日本</div>
      <div class="bar-track">
        <div class="bar-fill" style="width: 82%"></div>
      </div>
    </div>
    <div class="bar-row">
      <div class="bar-name">西日本</div>
      <div class="bar-track">
        <div class="bar-fill" style="width: 64%"></div>
      </div>
    </div>
    <div class="bar-row">
      <div class="bar-name">海外</div>
      <div class="bar-track">
        <div class="bar-fill" style="width: 38%"></div>
      </div>
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

- Dark backgrounds (`#0f172a`) with a bright accent read as a polished dashboard;
  light themes (`#ffffff` / `#f8fafc`) read as a document. Pick to fit the report.
- Keep a single accent color and a neutral text ramp; avoid more than ~4 colors.
- Encode quantities visually (bar widths, ring fills), not just as numbers.
- Leave breathing room: 16–32px padding, consistent gaps. Cramped layouts look generic.
- For long reports, stack sections with clear headings rather than forcing one screen.
