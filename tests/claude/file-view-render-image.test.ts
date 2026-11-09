import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  columnsFor,
  imageKindOf,
  pixelSizeOf,
  rasterFrameOf,
  renderImage,
} from "../../claude/.claude/skills/file-view/scripts/render-image";
import {
  decodePng,
  sliceIntoCells,
} from "../../claude/.claude/skills/file-view/scripts/tiles";

const CELL = { width: 4, height: 8 };

const solidPng = (width: number, height: number): Uint8Array => {
  const pixels = new Uint8Array(width * height * 4);

  for (let at = 0; at < pixels.length; at += 4) {
    pixels.set([200, 40, 40, 255], at);
  }

  const [tile] = sliceIntoCells(
    { width, height, pixels },
    { width: 1, height },
    1,
  );

  if (tile === undefined) {
    throw new Error("no png");
  }

  return tile.png;
};

const jpegHeader = (width: number, height: number): Uint8Array =>
  Uint8Array.of(
    255,
    216,
    255,
    224,
    0,
    4,
    0,
    0,
    255,
    192,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    17,
    0,
  );

describe("image kinds and sizes", () => {
  test("names the images it draws", () => {
    expect(imageKindOf("/a/b.PNG")).toBe("raster");
    expect(imageKindOf("/a/b.jpeg")).toBe("raster");
    expect(imageKindOf("/a/b.jpg")).toBe("raster");
    expect(imageKindOf("/a/b.svg")).toBe("svg");
    expect(imageKindOf("/a/b.gif")).toBeNull();
  });

  test("reads PNG and JPEG pixel sizes from their headers", () => {
    expect(pixelSizeOf(solidPng(7, 3))).toEqual({ width: 7, height: 3 });
    expect(pixelSizeOf(jpegHeader(640, 480))).toEqual({
      width: 640,
      height: 480,
    });
    expect(pixelSizeOf(Uint8Array.of(1, 2, 3))).toBeNull();
  });

  test("keeps small pictures at their own width and caps wide ones", () => {
    expect(columnsFor(10, 50, CELL)).toBe(3);
    expect(columnsFor(1000, 50, CELL)).toBe(50);
    expect(columnsFor(0, 50, CELL)).toBe(1);
  });

  test("frames a wide raster at the pane width, keeping its aspect", () => {
    const { svg, columns } = rasterFrameOf(jpegHeader(400, 200), 10, CELL);

    expect(columns).toBe(10);
    expect(svg).toContain('width="40" height="20"');
    expect(svg).toContain("data:image/jpeg;base64,");
  });
});

describe("renderImage", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "file-view-image-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("tiles a PNG at its own size and reuses the cache", async () => {
    const file = join(root, "a.png");

    await writeFile(file, solidPng(10, 20));

    const input = { file, columns: 50, cell: CELL, outRoot: join(root, "out") };
    const tiles = renderImage(input);

    expect(tiles.map(({ columns, rows }) => ({ columns, rows }))).toEqual([
      { columns: 3, rows: 3 },
    ]);

    const drawn = decodePng(await Bun.file(tiles[0]?.file ?? "").bytes());

    expect(drawn.width).toBe(12);
    expect([...drawn.pixels.subarray(0, 4)]).toEqual([200, 40, 40, 255]);
    expect(renderImage(input)).toEqual(tiles);
    expect(await readdir(join(root, "out"))).toHaveLength(1);
  });

  test("scales an SVG to the pane width", async () => {
    const file = join(root, "a.svg");

    await writeFile(
      file,
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="5"><rect width="10" height="5" fill="#0a0"/></svg>',
    );

    const tiles = renderImage({
      file,
      columns: 20,
      cell: CELL,
      outRoot: join(root, "out"),
    });

    expect(tiles.map(({ columns, rows }) => ({ columns, rows }))).toEqual([
      { columns: 20, rows: 5 },
    ]);
  });

  test("refuses a file that is not a PNG or JPEG", async () => {
    const file = join(root, "a.png");

    await writeFile(file, "not an image");

    expect(() =>
      renderImage({ file, columns: 5, cell: CELL, outRoot: root }),
    ).toThrow("Not a PNG or JPEG image");
  });
});
