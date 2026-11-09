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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

export const TILE_ROWS = 120;
const TILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const FALLBACK_CELL: Cell = { width: 18, height: 36 };
const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const BYTES_PER_PIXEL = 4;

export interface Cell {
  width: number;
  height: number;
}

export interface Tile {
  file: string;
  columns: number;
  rows: number;
}

export interface RawPng {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

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

export const isPng = (bytes: Uint8Array): boolean =>
  bytes.length >= 24 &&
  PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);

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

export const cachedTiles = (outDir: string): Tile[] | null => {
  const manifest = join(outDir, "tiles.json");

  return existsSync(manifest)
    ? (JSON.parse(readFileSync(manifest, "utf8")) as Tile[])
    : null;
};

export const writeTiles = (input: {
  raw: RawPng;
  cell: Cell;
  columns: number;
  outDir: string;
}): Tile[] => {
  const { raw, cell, columns, outDir } = input;

  mkdirSync(outDir, { recursive: true });

  const tiles = sliceIntoCells(raw, cell, TILE_ROWS).map(
    (tile, index): Tile => {
      const file = join(outDir, `tile-${index}.png`);

      writeFileSync(file, tile.png);

      return { file, columns, rows: tile.rows };
    },
  );

  writeFileSync(join(outDir, "tiles.json"), JSON.stringify(tiles));

  return tiles;
};

export const cellFromRex = (): Cell | null => {
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

export const tileRoot = (): string => join(tmpdir(), "claude-file-view");

export const pruneOldTiles = (root: string): void => {
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

export const argOf = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);

  return at === -1 ? undefined : process.argv[at + 1];
};

export const runMain = async (main: () => Promise<void>): Promise<void> => {
  await main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
};
