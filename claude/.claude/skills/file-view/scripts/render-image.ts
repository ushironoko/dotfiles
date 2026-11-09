#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import {
  argOf,
  cachedTiles,
  type Cell,
  cellFromRex,
  decodePng,
  FALLBACK_CELL,
  isPng,
  pruneOldTiles,
  type RawPng,
  runMain,
  sha256,
  type Tile,
  tileRoot,
  writeTiles,
} from "./tiles";

const RENDER_VERSION = 1;
const JPEG_FRAME_MARKERS: ReadonlySet<number> = new Set([
  192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
]);

export type ImageKind = "raster" | "svg";

export interface PixelSize {
  width: number;
  height: number;
}

export const imageKindOf = (path: string): ImageKind | null => {
  if (/\.svg$/i.test(path)) {
    return "svg";
  }

  return /\.(png|jpe?g)$/i.test(path) ? "raster" : null;
};

const uint16At = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);

const jpegSizeOf = (bytes: Uint8Array): PixelSize | null => {
  for (let at = 2; at + 9 < bytes.length; ) {
    if (bytes[at] !== 255) {
      return null;
    }

    const marker = bytes[at + 1] ?? 0;

    if (marker === 255) {
      at += 1;
      continue;
    }

    if (JPEG_FRAME_MARKERS.has(marker)) {
      return {
        height: uint16At(bytes, at + 5),
        width: uint16At(bytes, at + 7),
      };
    }

    at += 2 + uint16At(bytes, at + 2);
  }

  return null;
};

export const pixelSizeOf = (bytes: Uint8Array): PixelSize | null => {
  if (isPng(bytes)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset);

    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  return bytes[0] === 255 && bytes[1] === 216 ? jpegSizeOf(bytes) : null;
};

export const columnsFor = (
  naturalWidth: number,
  maxColumns: number,
  cell: Cell,
): number =>
  Math.max(1, Math.min(maxColumns, Math.ceil(naturalWidth / cell.width)));

export const rasterFrameOf = (
  bytes: Uint8Array,
  maxColumns: number,
  cell: Cell,
): { svg: string; columns: number } => {
  const size = pixelSizeOf(bytes);

  if (size === null || size.width < 1 || size.height < 1) {
    throw new Error("Not a PNG or JPEG image");
  }

  const columns = columnsFor(size.width, maxColumns, cell);
  const canvas = columns * cell.width;
  const width = Math.min(size.width, canvas);
  const height = Math.max(1, Math.round((size.height * width) / size.width));
  const mime = isPng(bytes) ? "image/png" : "image/jpeg";
  const href = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${height}"><image href="${href}" width="${width}" height="${height}"/></svg>`,
    columns,
  };
};

const rasterOf = (
  bytes: Uint8Array,
  maxColumns: number,
  cell: Cell,
): { raw: RawPng; columns: number } => {
  const { svg, columns } = rasterFrameOf(bytes, maxColumns, cell);

  return { raw: decodePng(new Resvg(svg).render().asPng()), columns };
};

const vectorOf = (
  bytes: Uint8Array,
  maxColumns: number,
  cell: Cell,
): { raw: RawPng; columns: number } => {
  const rendered = new Resvg(Buffer.from(bytes), {
    fitTo: { mode: "width", value: maxColumns * cell.width },
    font: { loadSystemFonts: true },
  }).render();

  return { raw: decodePng(rendered.asPng()), columns: maxColumns };
};

export const renderImage = (input: {
  file: string;
  columns: number;
  cell: Cell;
  outRoot: string;
}): Tile[] => {
  const { file, columns, cell, outRoot } = input;
  const kind = imageKindOf(file);

  if (kind === null) {
    throw new Error("Only PNG, JPEG and SVG images are drawn");
  }

  const bytes = new Uint8Array(readFileSync(file));
  const outDir = join(
    outRoot,
    sha256(
      JSON.stringify([RENDER_VERSION, kind, sha256(bytes), columns, cell]),
    ),
  );
  const cached = cachedTiles(outDir);

  if (cached !== null) {
    return cached;
  }

  const drawn =
    kind === "svg"
      ? vectorOf(bytes, columns, cell)
      : rasterOf(bytes, columns, cell);

  return writeTiles({ ...drawn, cell, outDir });
};

const main = async (): Promise<void> => {
  const columns = Number(argOf("columns"));
  const file = argOf("file");

  if (!Number.isInteger(columns) || columns < 1 || file === undefined) {
    throw new Error("Usage: render-image --file <path> --columns <n>");
  }

  const outRoot = tileRoot();

  pruneOldTiles(outRoot);

  const tiles = renderImage({
    file,
    columns,
    cell: cellFromRex() ?? FALLBACK_CELL,
    outRoot,
  });

  process.stdout.write(JSON.stringify({ tiles }));
};

if (import.meta.main) {
  await runMain(main);
}
