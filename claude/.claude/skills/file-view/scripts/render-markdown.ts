#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { highlightHtmlCodeBlocks, parseAndRender } from "@ox-content/napi";
import {
  Satoru,
  type RequiredResource,
  type ResourceResolver,
} from "satoru-render";
import {
  argOf,
  cachedTiles,
  type Cell,
  cellFromRex,
  decodePng,
  FALLBACK_CELL,
  pruneOldTiles,
  runMain,
  sha256,
  type Tile,
  tileRoot,
  writeTiles,
} from "./tiles";

export type { Cell, Tile } from "./tiles";

const RENDER_VERSION = 1;
const FONT_HOSTS: ReadonlySet<string> = new Set([
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.jsdelivr.net",
]);

export type Theme = "dark" | "light";

interface Palette {
  text: string;
  muted: string;
  link: string;
  border: string;
  codeBackground: string;
}

const PALETTES: Record<Theme, Palette> = {
  dark: {
    text: "#e6e6e6",
    muted: "#a0a0a0",
    link: "#79c0ff",
    border: "#555555",
    codeBackground: "#2a2d33",
  },
  light: {
    text: "#1f2328",
    muted: "#59636e",
    link: "#0969da",
    border: "#d0d7de",
    codeBackground: "#eff1f3",
  },
};

export const fencedFrontmatter = (markdown: string): string => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);

  return match === null
    ? markdown
    : `\`\`\`yaml\n${match[1]}\n\`\`\`\n\n${markdown.slice(match[0].length)}`;
};

export const taskMarkersDrawn = (html: string): string =>
  html
    .replaceAll(
      /<li><input type="checkbox" checked disabled>/g,
      '<li class="task"><span class="box on"></span>',
    )
    .replaceAll(
      /<li><input type="checkbox" disabled>/g,
      '<li class="task"><span class="box"></span>',
    );

export const htmlOf = (markdown: string): string => {
  const { html } = parseAndRender(fencedFrontmatter(markdown), { gfm: true });

  return taskMarkersDrawn(highlightHtmlCodeBlocks(html).html);
};

export const styleOf = (theme: Theme, cell: Cell): string => {
  const colors = PALETTES[theme];
  const fontSize = Math.round(cell.height * 0.8);
  const hairline = Math.max(1, Math.round(cell.height / 18));

  return `
html, body { background: transparent; }
body { margin: 0; padding: ${cell.height / 2}px ${cell.width}px; font-family: sans-serif; font-size: ${fontSize}px; line-height: 1.6; color: ${colors.text}; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.2em 0 .5em; }
h1 { font-size: 1.7em; border-bottom: ${hairline}px solid ${colors.border}; padding-bottom: .2em; }
h2 { font-size: 1.35em; border-bottom: ${hairline}px solid ${colors.border}; padding-bottom: .2em; }
h3 { font-size: 1.15em; }
h4, h5, h6 { font-size: 1em; }
p, ul, ol, table, blockquote, pre { margin: 0 0 .8em; }
ul, ol { padding-left: 1.6em; }
ul ul, ul ol, ol ul, ol ol { margin-bottom: 0; }
a { color: ${colors.link}; }
code { font-family: monospace; font-size: .92em; background: ${colors.codeBackground}; padding: .1em .3em; border-radius: .25em; }
pre { font-size: .92em; line-height: 1.45; padding: .8em 1em; border-radius: .4em; background: ${colors.codeBackground}; white-space: pre-wrap; word-break: break-all; }
pre code { font-size: 1em; background: transparent; padding: 0; }
blockquote { margin-left: 0; padding-left: 1em; border-left: ${hairline * 3}px solid ${colors.border}; color: ${colors.muted}; }
hr { border: 0; border-top: ${hairline}px solid ${colors.border}; margin: 1.2em 0; }
table { border-collapse: collapse; font-size: 1em; }
th, td { border: ${hairline}px solid ${colors.border}; padding: .3em .6em; }
img { max-width: 100%; }
li.task { list-style: none; }
.box { display: inline-block; width: .8em; height: .8em; margin: 0 .4em 0 -1.2em; border: ${hairline}px solid ${colors.muted}; border-radius: .15em; }
.box.on { background: ${colors.link}; border-color: ${colors.link}; }
`;
};

export const documentOf = (
  markdown: string,
  theme: Theme,
  cell: Cell,
): string =>
  `<html><head><style>${styleOf(theme, cell)}</style></head><body>${htmlOf(markdown)}</body></html>`;

export const isReachable = (
  resource: Pick<RequiredResource, "type" | "url">,
): boolean => {
  if (resource.url.startsWith("provider:")) {
    return true;
  }

  try {
    const { protocol, hostname } = new URL(resource.url);

    return protocol === "file:"
      ? resource.type === "image"
      : protocol === "https:" && FONT_HOSTS.has(hostname);
  } catch {
    return resource.type === "image";
  }
};

const fontCacheDir = (): string =>
  join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "claude-file-view",
    "fonts",
  );

const resolverOf =
  (cacheDir: string, onMissingFont: (url: string) => void): ResourceResolver =>
  async (resource, fallback) => {
    if (!isReachable(resource)) {
      return null;
    }

    const isFont = resource.type === "font" || resource.type === "css";
    const cached = join(cacheDir, sha256(resource.url));

    if (isFont && existsSync(cached)) {
      return new Uint8Array(readFileSync(cached));
    }

    const resolved = await fallback(resource);

    if (isFont && resolved === null) {
      onMissingFont(resource.url);
    }

    if (isFont && resolved instanceof Uint8Array) {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cached, resolved);
    }

    return resolved;
  };

export const renderTiles = async (input: {
  markdown: string;
  columns: number;
  theme: Theme;
  cell: Cell;
  baseDir: string;
  outRoot: string;
  fontDir: string;
}): Promise<Tile[]> => {
  const { markdown, columns, theme, cell, baseDir, outRoot, fontDir } = input;
  const key = sha256(
    JSON.stringify([RENDER_VERSION, markdown, columns, theme, cell, baseDir]),
  );
  const outDir = join(outRoot, key);
  const cached = cachedTiles(outDir);

  if (cached !== null) {
    return cached;
  }

  const missingFonts: string[] = [];
  const satoru = await Satoru.create();
  const png = await satoru.render({
    value: documentOf(markdown, theme, cell),
    width: columns * cell.width,
    format: "png",
    baseUrl: `file://${baseDir}/`,
    resolveResource: resolverOf(fontDir, (url) => missingFonts.push(url)),
  });

  if (!(png instanceof Uint8Array)) {
    throw new Error("satoru did not return PNG bytes");
  }

  if (missingFonts.length > 0) {
    throw new Error(`Could not load fonts: ${missingFonts.join(", ")}`);
  }

  return writeTiles({ raw: decodePng(png), cell, columns, outDir });
};

const main = async (): Promise<void> => {
  const columns = Number(argOf("columns"));
  const file = argOf("file");

  if (!Number.isInteger(columns) || columns < 1 || file === undefined) {
    throw new Error(
      "Usage: render-markdown --file <path> --columns <n> [--theme dark|light]",
    );
  }

  const outRoot = tileRoot();

  pruneOldTiles(outRoot);

  const tiles = await renderTiles({
    markdown: await Bun.stdin.text(),
    columns,
    theme: argOf("theme") === "light" ? "light" : "dark",
    cell: cellFromRex() ?? FALLBACK_CELL,
    baseDir: dirname(file),
    outRoot,
    fontDir: fontCacheDir(),
  });

  process.stdout.write(JSON.stringify({ tiles }));
};

if (import.meta.main) {
  await runMain(main);
}
