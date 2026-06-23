# Design format: structure-first, low-chroma reporting

This is the **default design format** for every SVG this skill produces. The reader
must understand the report from its structure, hierarchy, and reading flow — not from
color. Color is decoration; it never carries meaning. Apply all six rules below unless
the user explicitly asks for a different style.

## The six rules

### 1. Whitespace controls information density

- Use one spacing scale and nothing else: `4, 8, 16, 24, 32, 40px`. No arbitrary values.
- Gaps encode grouping. Bind related items with small gaps; separate unrelated groups
  with large gaps. The eye reads grouping from spacing before it reads any content.
- Section padding ≥ 24px. Never let content touch the container edge.
- Do not fill the canvas. Empty space is part of the layout, not waste.

### 2. Structure over prose

- Break content into labeled sections, key–value pairs, tables, and short rows.
- One idea per line. Prefer five short rows to one paragraph.
- Lead every section with a short heading that names what it contains.
- Keep running text to ≤ 2 lines per item. If it grows past that, restructure it into
  a list or a table.

### 3. Plain language, code vocabulary

- Name things exactly as the code names them: function / file / field / flag
  identifiers verbatim, wrapped in a monospace span (`<code>`).
- No metaphor, no analogy, no "imagine that…". State the fact directly.
- Prefer "`parseConfig` throws when `path` is missing" over "the config step can stumble".

### 4. No color-coded labeling

- Never encode a category or status in color alone. A reader who cannot separate the
  hues must still receive every distinction.
- Encode status / category with a **text label**, a **glyph prefix** (`● ◐ ○ — ▲ ✓ ×`),
  **position / order**, or a **bordered band** — combined with reading order.
- Top-to-bottom flow carries priority: most important first, supporting detail below.

### 5. Low-chroma palette

- No saturated primaries. Do **not** use green / red / yellow / blue to mark meaning.
- Build from a neutral ink ramp plus **at most one** muted, desaturated accent
  (slate / clay / sand), used only for emphasis — a heading rule, a single value, a bar
  fill — never to categorize.
- In charts, length (bar width, ring fill) carries the value with a single neutral fill.
  Color never distinguishes one series from another; use labels, order, or separate rows.

### 6. Paragraph writing, ordered sections

- When a point needs explanation, write it as a paragraph led by its conclusion: the
  first sentence states the point, the sentences after it support that one point. A
  reader who reads only the leading sentence of each paragraph still gets the report.
- One paragraph holds one topic. Do not merge two points into one paragraph.
- Order sections so understanding builds in stages: premise / context first, then the
  detail that depends on it, then the result. Each section assumes only what came above
  it — never something defined further down.
- This rule governs the explanatory prose; rule 2 still governs each row. They compose:
  factor lists and tables out of the text, and write the remaining explanation as
  topic-sentence-first paragraphs in a deliberate order.

## Palette

Two ramps. Pick light (reads as a document) or dark (reads as a console). Use the ink
ramp for all text; reserve the single accent for one emphasis per view.

### Light

| Token          | Value     | Use                                  |
| -------------- | --------- | ------------------------------------ |
| `--bg`         | `#faf8f5` | page background (warm off-white)     |
| `--surface`    | `#ffffff` | tracks, inset panels                 |
| `--hairline`   | `#e4e0d8` | dividers, borders                    |
| `--ink-strong` | `#1b1a18` | headings, values, key identifiers    |
| `--ink`        | `#3d3b37` | body text                            |
| `--ink-muted`  | `#6f6b64` | labels, captions, secondary notes    |
| `--accent`     | `#5b6770` | one emphasis only (rule, bar, value) |

### Dark

| Token          | Value     |
| -------------- | --------- |
| `--bg`         | `#1a1b1d` |
| `--surface`    | `#232427` |
| `--hairline`   | `#33353a` |
| `--ink-strong` | `#ececea` |
| `--ink`        | `#c2c0bb` |
| `--ink-muted`  | `#8b8985` |
| `--accent`     | `#8a98a4` |

Alternative muted accents if slate does not fit the content: clay `#7d6b58`,
sand `#9a8c6f`, moss `#6b7064`. Pick one and use it sparingly.

## Typography

- One sans family (`'Noto Sans JP'`). Add one monospace family for code identifiers.
- Build hierarchy from **size + weight + letter-spacing + case**, never from color:
  - Eyebrow / section label: `11–12px`, weight `600–700`, `letter-spacing: 0.1–0.14em`,
    `text-transform: uppercase`, `--ink-muted`.
  - Title: `22–24px`, weight `700`, `--ink-strong`.
  - Body: `13–14px`, weight `400`, `--ink`.
  - Big value (KPI): `26–30px`, weight `700`, `--ink-strong`.
- Separate sections with a `1px` hairline rule plus generous margin, not with colored
  blocks.

## Patterns that follow the rules

- **KPI row:** equal columns separated by a left hairline (`border-left`), each a small
  muted label, a large strong value, and a small muted delta line. No colored cards.
- **Bar chart:** `grid-template-columns: <name> 1fr <value>`. A hairline-bordered track
  holds a single-accent fill whose `width: N%` is the value; the numeric value sits in a
  monospace column at the right. Length and the printed number both carry the data.
- **Status list:** `grid-template-columns: <glyph> <name> <note>`. A glyph (`● ◐ ○`)
  marks state, the identifier sits in monospace, the note is plain muted text. Add a one
  line legend mapping each glyph to its word. Color is not used to distinguish states.
- **Table:** `border-collapse`, a hairline header underline, hairline row separators, no
  zebra fills. Align numbers right in a monospace column.

A complete, render-verified HTML implementing every pattern above is in
`html-authoring.md` ("Verified template"). Start from it.
