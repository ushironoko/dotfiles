import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  decodePng,
  fencedFrontmatter,
  htmlOf,
  isReachable,
  renderTiles,
  sliceIntoCells,
  taskMarkersDrawn,
} from "../../claude/.claude/skills/file-view/scripts/render-markdown";

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);

  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, Bun.hash.crc32(body));

  return out;
};

const pngOf = (
  width: number,
  height: number,
  scanlines: number[],
): Uint8Array => {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);

  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Uint8Array.from(scanlines))),
    chunk("IEND", new Uint8Array(0)),
  ]);
};

describe("markdown to html", () => {
  test("turns frontmatter into a yaml fence", () => {
    expect(fencedFrontmatter("---\nname: x\n---\n\n# T\n")).toBe(
      "```yaml\nname: x\n```\n\n\n# T\n",
    );
    expect(fencedFrontmatter("# T\n---\n")).toBe("# T\n---\n");
  });

  test("draws task markers the renderer can paint", () => {
    expect(
      taskMarkersDrawn('<li><input type="checkbox" checked disabled> a</li>'),
    ).toBe('<li class="task"><span class="box on"></span> a</li>');
    expect(
      taskMarkersDrawn('<li><input type="checkbox" disabled> a</li>'),
    ).toBe('<li class="task"><span class="box"></span> a</li>');
  });

  test("renders gfm tables and highlights code", () => {
    const html = htmlOf("|a|\n|-|\n|1|\n\n```ts\nconst a = 1;\n```\n");

    expect(html).toContain("<table>");
    expect(html).toContain('class="ox-highlight');
  });
});

describe("png tiles", () => {
  test("undoes every filter type", () => {
    const decoded = decodePng(
      pngOf(
        2,
        5,
        [
          0, 1, 2, 3, 4, 5, 6, 7, 8, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1,
          1, 1, 1, 1, 3, 2, 2, 2, 2, 2, 2, 2, 2, 4, 1, 1, 1, 1, 1, 1, 1, 1,
        ],
      ),
    );

    expect([...decoded.pixels.subarray(0, 8)]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect([...decoded.pixels.subarray(8, 16)]).toEqual([
      1, 1, 1, 1, 2, 2, 2, 2,
    ]);
    expect([...decoded.pixels.subarray(16, 24)]).toEqual([
      2, 2, 2, 2, 3, 3, 3, 3,
    ]);
    expect([...decoded.pixels.subarray(24, 32)]).toEqual([
      3, 3, 3, 3, 5, 5, 5, 5,
    ]);
    expect([...decoded.pixels.subarray(32, 40)]).toEqual([
      4, 4, 4, 4, 6, 6, 6, 6,
    ]);
  });

  test("slices on cell boundaries and pads the last tile", () => {
    const pixels = new Uint8Array(5 * 4).fill(9);
    const tiles = sliceIntoCells(
      { width: 1, height: 5, pixels },
      { width: 1, height: 2 },
      2,
    );

    expect(tiles.map(({ rows }) => rows)).toEqual([2, 1]);

    const last = decodePng(tiles[1]?.png ?? new Uint8Array());

    expect(last.height).toBe(2);
    expect([...last.pixels]).toEqual([9, 9, 9, 9, 0, 0, 0, 0]);
  });
});

describe("resources", () => {
  test("only font hosts and local images are reachable", () => {
    const font = "font";
    const image = "image";

    expect(
      isReachable({ type: font, url: "https://fonts.gstatic.com/a" }),
    ).toBe(true);
    expect(isReachable({ type: image, url: "https://example.com/a.png" })).toBe(
      false,
    );
    expect(
      isReachable({ type: font, url: "https://example.com/a.woff2" }),
    ).toBe(false);
    expect(isReachable({ type: image, url: "./a.png" })).toBe(true);
    expect(isReachable({ type: image, url: "file:///repo/a.png" })).toBe(true);
    expect(isReachable({ type: "css", url: "file:///etc/hosts" })).toBe(false);
  });
});

describe("renderTiles", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "file-view-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("fails rather than draw blank text when fonts cannot load", async () => {
    const realFetch = globalThis.fetch;

    globalThis.fetch = Object.assign(
      async () => {
        throw new Error("offline");
      },
      { preconnect: realFetch.preconnect },
    );

    try {
      await expect(
        renderTiles({
          markdown: "# Title\n",
          columns: 10,
          theme: "dark",
          cell: { width: 8, height: 16 },
          baseDir: root,
          outRoot: join(root, "out"),
          fontDir: join(root, "fonts"),
        }),
      ).rejects.toThrow("Could not load fonts");
      expect(await readdir(root)).not.toContain("out");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
