# satoru-render reference

`satoru-render` (package `satoru-render`, repo
[SoraKumo001/satoru](https://github.com/SoraKumo001/satoru)) is a high-fidelity
HTML/CSS → SVG/PNG/PDF converter that runs entirely in WebAssembly (Skia + litehtml).
No browser, no Puppeteer. Verified against `satoru-render@1.0.13`.

## Install

```bash
bun install -g satoru-render@1.0.13   # bin: satoru-render
```

## CLI

```bash
satoru-render <input.html | url> [options]
```

The input is a positional file path or URL. Output format is taken from the `-o`
extension unless `-f` is given.

| Flag                                                                           | Meaning                                                              | Default                      |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------- |
| `-o, --output <path>`                                                          | output file; extension selects format (`.svg` `.png` `.webp` `.pdf`) | `<input>.png` / `output.png` |
| `-w, --width <px>`                                                             | canvas width                                                         | `800`                        |
| `-h, --height <px>`                                                            | canvas height; **omit to auto-fit content height**                   | auto                         |
| `-f, --format <fmt>`                                                           | force format (`svg` `png` `webp` `pdf`)                              | from `-o`, else `png`        |
| `--no-jsdom`                                                                   | skip JSDOM hydration; pass raw HTML straight to the engine           | jsdom on                     |
| `--media <screen\|print>`                                                      | CSS media type                                                       | `screen`                     |
| `--verbose`                                                                    | log resolution/render steps to stderr                                | off                          |
| `--json-report <path>`                                                         | write a diagnostics report (resources, fonts)                        | —                            |
| `--timeout <ms>`                                                               | resource-fetch timeout                                               | —                            |
| `--allowed-hosts` / `--blocked-hosts` / `--allowed-protocols`                  | resource fetch allow/deny lists (comma-separated)                    | —                            |
| `--max-resource-bytes` / `--max-total-resource-bytes` / `--max-resource-count` | resource limits                                                      | —                            |

The CLI injects `body { background-color: white; }` as a base style; your own
`body` background overrides it.

### Canonical command for a static report

```bash
satoru-render "$TMPDIR/report.html" -o report.svg -w 760 --no-jsdom
```

Width 760 is a good default for a single-column report; bump to 1000–1200 for wide
dashboards. Height is omitted so the SVG grows to fit the content (verified: `-w 760`
on the sample produced `height="349"` automatically).

## SVG output is portable by construction

For SVG, satoru converts every glyph to a vector `<path>` and deduplicates repeated
glyphs with `<defs>`/`<use>`. Consequences:

- The viewer needs **no fonts and no HTML engine** — any SVG renderer shows it
  identically. This is the whole point of choosing SVG for portability.
- Text is **not selectable/searchable** in the output (it is paths, not `<text>`).
  If the user needs selectable text, that is a tradeoff to call out.

## Critical: fonts are fetched from the network at render time

This bites Japanese and any non-system-font report. satoru resolves web fonts from
Google Fonts **while rendering**:

- `font-family: 'IBM Plex Sans JP'` → fetches CSS from `fonts.googleapis.com`, then the
  woff2 files from `fonts.gstatic.com`.
- Emoji fall back to a font from `cdn.jsdelivr.net`.

If those hosts are unreachable (Claude Code's default Bash sandbox blocks them), the
fetch fails, the affected glyphs are **dropped from the output**, and the command
still **exits 0** with only a warning on stderr. The structure renders; the text is
blank. Verified: the same HTML produced full Japanese text online (~29 KB PNG) vs. a
text-less skeleton offline (~4 KB PNG).

**Fix:** run the conversion with network egress allowed to `fonts.googleapis.com` and
`fonts.gstatic.com` (plus `cdn.jsdelivr.net` for emoji) — in Claude Code, run the
`satoru-render` Bash call with the sandbox disabled. Detecting a failure: a
suspiciously small output, or `--verbose` showing `Failed to resolve resource:
https://fonts.googleapis.com/...`.

**Offline / no-network alternative:** point the CSS at a font file on disk via
`@font-face` with a `file://` (or relative, with the file next to the HTML) `src`, and
use only that family. Then no network fetch happens. Stick with Google Fonts unless the
environment is truly offline — it is simpler and the visual result is the same.

## Gotcha: omit `<!DOCTYPE html>` with `--no-jsdom`

With `--no-jsdom` the raw HTML string goes straight to litehtml, which renders a
leading `<!DOCTYPE html>` as **visible text** at the top of the output. Start the
document at `<html>` instead. (With jsdom hydration the doctype is normalized away, but
jsdom is an optional dependency and, when absent, the CLI silently falls back to the
raw path — so do not rely on it; just drop the doctype.)

## Other formats (out of scope here, for reference)

The same command yields PNG/WebP/PDF by changing the `-o` extension or `-f`. This skill
targets SVG for portability; use the others only on explicit request.

## Programmatic API (if a script is ever needed)

```js
import { Satoru } from "satoru-render";
import { writeFileSync } from "node:fs";

const satoru = await Satoru.create();
const svg = await satoru.render({
  value: htmlString, // or: url: "https://..."
  width: 760, // height omitted → auto
  format: "svg",
  baseUrl, // for resolving relative resources
});
writeFileSync("report.svg", svg); // svg is a string; binary formats return Uint8Array
```

The CLI covers every case this skill needs; reach for the API only for batch/embedded use.
