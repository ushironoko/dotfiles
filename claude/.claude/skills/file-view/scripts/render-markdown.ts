#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { highlightHtmlCodeBlocks, parseAndRender } from "@ox-content/napi";
import {
  Satoru,
  type RequiredResource,
  type ResourceResolver,
} from "satoru-render";

const RENDER_VERSION = 1;
const TILE_ROWS = 120;
const TILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FALLBACK_CELL: Cell = { width: 18, height: 36 };
const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const BYTES_PER_PIXEL = 4;
const FONT_HOSTS: ReadonlySet<string> = new Set([
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.jsdelivr.net",
]);

export interface Cell {
  width: number;
  height: number;
}

export type Theme = "dark" | "light";

export interface Tile {
  file: string;
  columns: number;
  rows: number;
}

interface Palette {
  text: string;
  muted: string;
  link: string;
  border: string;
  codeBackground: string;
}

interface RawPng {
  width: number;
  height: number;
  pixels: Uint8Array;
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

const uint32At = (bytes: Uint8Array, offset: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
  );

const paeth = (left: number, up: number, upLeft: number): number => {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);

  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left;
  }

  return toUp <= toUpLeft ? up : upLeft;
};

const predictorOf = (
  filter: number,
  left: number,
  up: number,
  upLeft: number,
): number => {
  switch (filter) {
    case 0: {
      return 0;
    }
    case 1: {
      return left;
    }
    case 2: {
      return up;
    }
    case 3: {
      return (left + up) >> 1;
    }
    case 4: {
      return paeth(left, up, upLeft);
    }
    default: {
      throw new Error(`Unknown PNG filter ${filter}`);
    }
  }
};

export const decodePng = (png: Uint8Array): RawPng => {
  const width = uint32At(png, 16);
  const height = uint32At(png, 20);

  if (png[24] !== 8 || png[25] !== 6 || png[28] !== 0) {
    throw new Error("Expected an 8-bit RGBA PNG without interlacing");
  }

  const parts: Uint8Array[] = [];

  for (let at = PNG_SIGNATURE.length; at < png.length; ) {
    const length = uint32At(png, at);
    const type = String.fromCodePoint(...png.subarray(at + 4, at + 8));

    if (type === "IDAT") {
      parts.push(png.subarray(at + 8, at + 8 + length));
    }

    at += 12 + length;
  }

  const stride = width * BYTES_PER_PIXEL;
  const filtered = inflateSync(Buffer.concat(parts));
  const pixels = new Uint8Array(height * stride);

  for (let row = 0; row < height; row += 1) {
    const from = row * (stride + 1);
    const filter = filtered[from] ?? 0;
    const to = row * stride;

    for (let i = 0; i < stride; i += 1) {
      const left =
        i >= BYTES_PER_PIXEL ? (pixels[to + i - BYTES_PER_PIXEL] ?? 0) : 0;
      const up = row > 0 ? (pixels[to + i - stride] ?? 0) : 0;
      const upLeft =
        row > 0 && i >= BYTES_PER_PIXEL
          ? (pixels[to + i - stride - BYTES_PER_PIXEL] ?? 0)
          : 0;

      pixels[to + i] =
        (filtered[from + 1 + i] ?? 0) + predictorOf(filter, left, up, upLeft);
    }
  }

  return { width, height, pixels };
};

const chunkOf = (type: string, data: Uint8Array): Uint8Array => {
  const body = new Uint8Array(4 + data.length);

  body.set(new TextEncoder().encode(type));
  body.set(data, 4);

  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);

  view.setUint32(0, data.length);
  chunk.set(body, 4);
  view.setUint32(8 + data.length, Bun.hash.crc32(body));

  return chunk;
};

const encodePng = (raw: RawPng): Uint8Array => {
  const stride = raw.width * BYTES_PER_PIXEL;
  const scanlines = new Uint8Array(raw.height * (stride + 1));

  for (let row = 0; row < raw.height; row += 1) {
    scanlines.set(
      raw.pixels.subarray(row * stride, (row + 1) * stride),
      row * (stride + 1) + 1,
    );
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);

  view.setUint32(0, raw.width);
  view.setUint32(4, raw.height);
  header.set([8, 6, 0, 0, 0], 8);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunkOf("IHDR", header),
    chunkOf("IDAT", deflateSync(scanlines, { level: 6 })),
    chunkOf("IEND", new Uint8Array(0)),
  ]);
};

export const sliceIntoCells = (
  raw: RawPng,
  cell: Cell,
  tileRows: number,
): { png: Uint8Array; rows: number }[] => {
  const stride = raw.width * BYTES_PER_PIXEL;
  const totalRows = Math.max(1, Math.ceil(raw.height / cell.height));
  const tiles: { png: Uint8Array; rows: number }[] = [];

  for (let startRow = 0; startRow < totalRows; startRow += tileRows) {
    const rows = Math.min(tileRows, totalRows - startRow);
    const height = rows * cell.height;
    const pixels = new Uint8Array(height * stride);
    const from = startRow * cell.height * stride;

    pixels.set(
      raw.pixels.subarray(
        from,
        Math.min(from + pixels.length, raw.pixels.length),
      ),
    );
    tiles.push({
      png: encodePng({ width: raw.width, height, pixels }),
      rows,
    });
  }

  return tiles;
};

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

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

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

const cellFromRex = (): Cell | null => {
  if (process.env.REX_BLOCK === undefined) {
    return null;
  }

  try {
    const { stdout, exitCode } = Bun.spawnSync([
      "rex",
      "block",
      "call",
      "size",
    ]);
    const size = JSON.parse(stdout.toString()) as {
      cell_width_px?: number;
      cell_height_px?: number;
    };

    return exitCode === 0 && size.cell_width_px && size.cell_height_px
      ? { width: size.cell_width_px, height: size.cell_height_px }
      : null;
  } catch {
    return null;
  }
};

const pruneOldTiles = (root: string): void => {
  if (!existsSync(root)) {
    return;
  }

  const oldest = Date.now() - TILE_MAX_AGE_MS;

  for (const name of readdirSync(root)) {
    const path = join(root, name);

    if (statSync(path).mtimeMs < oldest) {
      rmSync(path, { recursive: true, force: true });
    }
  }
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
  const manifest = join(outDir, "tiles.json");

  if (existsSync(manifest)) {
    return JSON.parse(readFileSync(manifest, "utf8")) as Tile[];
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

  mkdirSync(outDir, { recursive: true });

  const tiles = sliceIntoCells(decodePng(png), cell, TILE_ROWS).map(
    (tile, index): Tile => {
      const file = join(outDir, `tile-${index}.png`);

      writeFileSync(file, tile.png);

      return { file, columns, rows: tile.rows };
    },
  );

  writeFileSync(manifest, JSON.stringify(tiles));

  return tiles;
};

const argOf = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);

  return at === -1 ? undefined : process.argv[at + 1];
};

const main = async (): Promise<void> => {
  const columns = Number(argOf("columns"));
  const file = argOf("file");

  if (!Number.isInteger(columns) || columns < 1 || file === undefined) {
    throw new Error(
      "Usage: render-markdown --file <path> --columns <n> [--theme dark|light]",
    );
  }

  const outRoot = join(tmpdir(), "claude-file-view");

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
  await main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
