import type {
  ElementTable,
  EngineInterface,
  On,
  RenderSurface,
} from "claude-code";

const PANE_ID = "file-view";
const TOOL_NAME = "open_file";
const TOOL_ID = "mcp__file-view__open_file";
const PAGE_CHARS = 90000;
const MARKDOWN_PAGE_CHARS = 40000;
const MAX_IMAGE_COLUMNS = 255;
const PANE_RIGHT_PADDING = 1;
const RENDER_TIMEOUT_MS = 120000;
const FIRST_TILE_KEY = "tile:0";
const ALT_DENIAL = "the Image draws its alt here";
const PROBE_INTERVAL_MS = 250;
const PROBE_ATTEMPTS = 8;
const MARKDOWN_PATH = /\.(md|markdown)$/i;
const IMAGE_PATH = /\.(png|jpe?g|svg)$/i;
const FILE_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

interface Page {
  source: string;
  startLine: number;
}

type Viewed =
  | { kind: "loading"; path: string }
  | {
      kind: "text";
      path: string;
      pages: readonly Page[];
      page: number;
      isMarkdown: boolean;
      full: string;
      loadId: number;
    }
  | { kind: "image"; path: string; loadId: number }
  | { kind: "error"; path: string; message: string };

interface Tile {
  file: string;
  columns: number;
  rows: number;
}

type Rendered =
  | { kind: "ready"; tiles: readonly Tile[] }
  | { kind: "failed"; message: string };

type RenderJob = { kind: "markdown"; source: string } | { kind: "image" };

interface RenderRequest {
  key: string;
  pageKey: string;
  path: string;
  job: RenderJob;
  columns: number;
}

interface Renderer {
  run: (request: RenderRequest) => Promise<Rendered>;
  denialOf: (tile: Tile) => Promise<string | null>;
  wait: (ms: number) => Promise<void>;
  redraw: () => void;
}

interface Engine {
  read: (path: string) => Promise<string>;
  isFile: (path: string) => Promise<boolean>;
  open: (title: string) => Promise<unknown>;
  redraw: () => void;
}

type BodyKit = Pick<
  ElementTable<"terminal">,
  "Box" | "Text" | "Code" | "Markdown" | "Image"
>;

const engineOf = ($: EngineInterface): Engine => ({
  read: (file) => $.fs.read(file),
  isFile: (file) => $.fs.stat(file).then(({ kind }) => kind === "file"),
  open: (title) => $.ui.open({ id: PANE_ID, title }),
  redraw: () => $.ui.invalidate("ui.render"),
});

const filePathOf = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const path = record.file_path ?? record.notebook_path;

  return typeof path === "string" && path !== "" ? path : null;
};

const absoluteOf = (path: string, root: string): string =>
  path.startsWith("/") ? path : `${root.replace(/\/+$/, "")}/${path}`;

const basenameOf = (path: string): string => {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;

  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
};

const isDrawable = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;

  return code === 9 || code === 10 || (code >= 32 && code !== 127);
};

const drawableOf = (text: string): string =>
  [...text.replaceAll("\r\n", "\n")].filter(isDrawable).join("");

const linesIn = (text: string): number => text.split("\n").length - 1;

const pagesOf = (text: string, limit: number, startLine = 1): Page[] => {
  if (text.length <= limit) {
    return [{ source: text, startLine }];
  }

  const cut = text.lastIndexOf("\n", limit);
  const end = cut > 0 ? cut : limit;
  const source = text.slice(0, end);
  const rest = text.slice(cut > 0 ? end + 1 : end);
  const nextLine = startLine + linesIn(source) + (cut > 0 ? 1 : 0);

  return [{ source, startLine }, ...pagesOf(rest, limit, nextLine)];
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isTile = (value: unknown): value is Tile => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const { file, columns, rows } = value as Record<string, unknown>;

  return (
    typeof file === "string" &&
    typeof columns === "number" &&
    typeof rows === "number"
  );
};

const tilesIn = (stdout: string): Tile[] | null => {
  const parsed: unknown = JSON.parse(stdout);
  const tiles =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).tiles
      : null;

  return Array.isArray(tiles) && tiles.every(isTile) ? tiles : null;
};

const loadedOf = async (
  engine: Engine,
  path: string,
  loadId: number,
): Promise<Viewed> => {
  try {
    if (IMAGE_PATH.test(path)) {
      return (await engine.isFile(path))
        ? { kind: "image", path, loadId }
        : { kind: "error", path, message: "Not a regular file" };
    }

    const raw = await engine.read(path);

    if (raw.includes("\u0000")) {
      return { kind: "error", path, message: "Binary file" };
    }

    const isMarkdown = MARKDOWN_PATH.test(path);

    return {
      kind: "text",
      path,
      pages: pagesOf(
        drawableOf(raw),
        isMarkdown ? MARKDOWN_PAGE_CHARS : PAGE_CHARS,
      ),
      page: 0,
      isMarkdown,
      full: raw,
      loadId,
    };
  } catch (error) {
    return { kind: "error", path, message: messageOf(error) };
  }
};

const tilesBodyOf = (
  { Box, Text, Image }: BodyKit,
  rendered: Rendered | null,
  stale: readonly Tile[] | null,
) => {
  const tiles = rendered?.kind === "ready" ? rendered.tiles : stale;

  if (tiles === null) {
    return <Text dimColor>Rendering…</Text>;
  }

  return (
    <Box flexDirection="column">
      {tiles.map(({ file, columns, rows }, index) => (
        <Image
          key={`tile:${index}`}
          source={{ file, format: "png" }}
          columns={columns}
          rows={rows}
          alt=" "
        />
      ))}
    </Box>
  );
};

const markdownBodyOf = (
  kit: BodyKit,
  source: string,
  page: number,
  rendered: Rendered | null,
  stale: readonly Tile[] | null,
) => {
  const { Box, Text, Markdown } = kit;

  if (rendered?.kind === "failed") {
    return (
      <Box flexDirection="column">
        <Text dimColor>Showing plain Markdown: {rendered.message}</Text>
        <Markdown key={`md:${page}`} text={source} />
      </Box>
    );
  }

  return tilesBodyOf(kit, rendered, stale);
};

const imageBodyOf = (
  kit: BodyKit,
  rendered: Rendered | null,
  stale: readonly Tile[] | null,
) => {
  const { Text } = kit;

  return rendered?.kind === "failed" ? (
    <Text color="red">Could not draw the image: {rendered.message}</Text>
  ) : (
    tilesBodyOf(kit, rendered, stale)
  );
};

const bodyOf = (
  kit: BodyKit,
  shown: Viewed | null,
  rendered: Rendered | null,
  stale: readonly Tile[] | null,
) => {
  const { Text, Code } = kit;

  if (shown === null) {
    return (
      <Text dimColor>Click a file path under a tool row to show it here.</Text>
    );
  }

  switch (shown.kind) {
    case "loading": {
      return <Text dimColor>Loading…</Text>;
    }
    case "error": {
      return <Text color="red">{shown.message}</Text>;
    }
    case "image": {
      return imageBodyOf(kit, rendered, stale);
    }
    case "text": {
      const page = shown.pages[shown.page] ?? { source: "", startLine: 1 };

      return shown.isMarkdown ? (
        markdownBodyOf(kit, page.source, shown.page, rendered, stale)
      ) : (
        <Code
          source={page.source}
          path={shown.path}
          startLine={page.startLine}
        />
      );
    }
  }
};

const renderTargetOf = (
  shown: Viewed | null,
): { pageKey: string; job: RenderJob } | null => {
  if (shown?.kind === "image") {
    return { pageKey: `${shown.loadId}`, job: { kind: "image" } };
  }

  if (shown?.kind !== "text" || !shown.isMarkdown) {
    return null;
  }

  return {
    pageKey: `${shown.loadId}:${shown.page}`,
    job: { kind: "markdown", source: shown.pages[shown.page]?.source ?? "" },
  };
};

const copyableOf = (
  shown: Viewed | null,
): { label: string; text: string } | null => {
  switch (shown?.kind) {
    case "text": {
      return { label: "⎘ copy", text: shown.full };
    }
    case "image": {
      return { label: "⎘ path", text: shown.path };
    }
    default: {
      return null;
    }
  }
};

export const register = (on: On) => {
  let viewed: Viewed | null = null;
  let generation = 0;
  let isRendering = false;
  let latestTiles: { pageKey: string; tiles: readonly Tile[] } | null = null;
  let imageDenial: string | null = null;
  let isImageSupported = false;
  const renders = new Map<string, Rendered>();

  const probeImageSupport = async (renderer: Renderer, tile: Tile) => {
    for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
      await renderer.wait(PROBE_INTERVAL_MS);

      const denial = await renderer.denialOf(tile);

      if (denial === null) {
        isImageSupported = true;

        return;
      }

      if (denial.startsWith(ALT_DENIAL)) {
        imageDenial = denial;
        renderer.redraw();

        return;
      }
    }
  };

  const ensureRendered = (renderer: Renderer, request: RenderRequest) => {
    if (imageDenial !== null || isRendering || renders.has(request.key)) {
      return;
    }

    isRendering = true;

    void renderer
      .run(request)
      .then((rendered) => {
        renders.set(request.key, rendered);

        if (rendered.kind === "ready") {
          latestTiles = { pageKey: request.pageKey, tiles: rendered.tiles };

          const [first] = rendered.tiles;

          if (first !== undefined && !isImageSupported) {
            void probeImageSupport(renderer, first).catch(() => undefined);
          }
        }
      })
      .finally(() => {
        isRendering = false;
        renderer.redraw();
      });
  };

  const forgetRenders = () => {
    renders.clear();
    latestTiles = null;
  };

  const show = async (engine: Engine, path: string) => {
    generation += 1;
    const current = generation;

    viewed = { kind: "loading", path };
    forgetRenders();
    await engine.open(basenameOf(path));
    engine.redraw();

    const loaded = await loadedOf(engine, path, current);

    if (current === generation) {
      viewed = loaded;
      engine.redraw();
    }
  };

  on("session.start", async ($, e, next) => {
    await $.tool.register({
      name: TOOL_NAME,
      description:
        "Show a file in the file-view pane beside the transcript: source with syntax highlighting, Markdown rendered, and PNG, JPEG or SVG images drawn as pictures. Use when the user asks to open, show or display a file in the pane.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Absolute path, or a path relative to the project root",
          },
        },
        required: ["path"],
      },
      isDeferred: false,
    });

    return next(e);
  });

  on("tool.call", { tool: TOOL_ID }, async ($, e) => {
    const raw = (e as Record<string, unknown>).path;

    if (typeof raw !== "string" || raw.trim() === "") {
      return { deny: "path must be a non-empty string." };
    }

    const path = absoluteOf(raw.trim(), await $.session.root());
    await show(engineOf($), path);

    return viewed?.kind === "error"
      ? { deny: `${path}: ${viewed.message}` }
      : { result: `Opened ${path} in the file-view pane.` };
  }).catch((_, e) => ({
    deny: `file-view could not open ${String((e as Record<string, unknown>).path)}.`,
  }));

  on("ui.render", { component: "ToolUse" }, async ($, e, next) => {
    const drawn = await next(e);
    const path = FILE_TOOLS.has(e.props.tool)
      ? filePathOf(e.props.input)
      : null;

    if (path === null || e.surface !== "terminal") {
      return drawn;
    }

    const { Box, Button } = $.ui.resolve(e);

    const engine = engineOf($);

    return (
      <Box flexDirection="column">
        {drawn}
        <Box paddingLeft={2}>
          <Button
            key={`open:${e.requestId}`}
            plain
            dimColor
            label={`⧉ ${path}`}
            onPress={() => void show(engine, path).catch(() => undefined)}
          />
        </Box>
      </Box>
    );
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE_ID || e.surface !== "terminal") {
      return next(e);
    }

    const { Box, Text, Code, Markdown, Image, Button } = $.ui.resolve(e);
    const shown = viewed;

    const themeOf = async (): Promise<"light" | "dark"> => {
      const rows = await $.config.list();

      return String(rows.find((row) => row.key === "theme")?.value).includes(
        "light",
      )
        ? "light"
        : "dark";
    };

    const renderer: Renderer = {
      run: async ({ path, job, columns }) => {
        try {
          const common = ["--file", path, "--columns", String(columns)];
          const argv =
            job.kind === "image"
              ? ["bun", `${$.plugin.root}/scripts/render-image.ts`, ...common]
              : [
                  "bun",
                  `${$.plugin.root}/scripts/render-markdown.ts`,
                  ...common,
                  "--theme",
                  await themeOf(),
                ];
          const { exitCode, stdout, stderr } = await $.process.run(argv, {
            cwd: $.plugin.root,
            ...(job.kind === "markdown" ? { stdin: job.source } : {}),
            timeoutMs: RENDER_TIMEOUT_MS,
          });
          const tiles = exitCode === 0 ? tilesIn(stdout) : null;

          return tiles === null
            ? { kind: "failed", message: stderr.trim() || "no tiles" }
            : { kind: "ready", tiles };
        } catch (error) {
          return { kind: "failed", message: messageOf(error) };
        }
      },
      denialOf: async ({ file }) => {
        const blitted = await $.ui.blit({
          requestId: PANE_ID,
          key: FIRST_TILE_KEY,
          source: { file, format: "png" },
        });

        return blitted.deny ?? null;
      },
      wait: (ms) => $.clock.sleep(ms),
      redraw: () => $.ui.invalidate("ui.render"),
    };

    const drawnTiles = (() => {
      const target = renderTargetOf(shown);

      if (shown === null || target === null) {
        return { rendered: null, stale: null };
      }

      const columns = Math.max(
        1,
        Math.min(MAX_IMAGE_COLUMNS, e.props.bodyColumns - PANE_RIGHT_PADDING),
      );
      const { pageKey, job } = target;
      const key = `${pageKey}:${columns}`;

      ensureRendered(renderer, {
        key,
        pageKey,
        path: shown.path,
        job,
        columns,
      });

      return {
        rendered:
          imageDenial === null
            ? (renders.get(key) ?? null)
            : ({ kind: "failed", message: imageDenial } as const),
        stale: latestTiles?.pageKey === pageKey ? latestTiles.tiles : null,
      };
    })();

    const copy = async (text: string, surface: RenderSurface) => {
      const copied = await $.ui.copy({ text, surface });

      $.ui.toast(
        copied.isCopied
          ? `Copied ${text.length.toLocaleString()} characters`
          : `Copy failed: ${copied.reason}`,
      );
    };

    const turn = async (page: number) => {
      if (viewed?.kind !== "text" || viewed.pages[page] === undefined) {
        return;
      }

      viewed = { ...viewed, page };
      $.ui.invalidate("ui.render");
      await $.ui.scroll({ in: PANE_ID, to: "start", block: "start" });
    };

    const pager =
      shown?.kind === "text" && shown.pages.length > 1 ? (
        <Box flexDirection="row" gap={1}>
          <Button
            key="prev"
            plain
            dimColor={shown.page === 0}
            label="◀"
            onPress={() => void turn(shown.page - 1).catch(() => undefined)}
          />
          <Text dimColor>
            {shown.page + 1}/{shown.pages.length}
          </Text>
          <Button
            key="next"
            plain
            dimColor={shown.page === shown.pages.length - 1}
            label="▶"
            onPress={() => void turn(shown.page + 1).catch(() => undefined)}
          />
        </Box>
      ) : null;

    const copyable = copyableOf(shown);

    return (
      <Box flexDirection="column" paddingRight={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text bold wrap="truncate-start">
            {shown?.path ?? "file-view"}
          </Text>
          {copyable === null ? null : (
            <Box flexDirection="row" gap={2}>
              {pager}
              <Button
                key="copy"
                plain
                dimColor
                label={copyable.label}
                onPress={(press) =>
                  void copy(copyable.text, press.surface).catch(() => undefined)
                }
              />
            </Box>
          )}
        </Box>
        {bodyOf(
          { Box, Text, Code, Markdown, Image },
          shown,
          drawnTiles.rendered,
          drawnTiles.stale,
        )}
      </Box>
    );
  });

  on("ui.close", { id: PANE_ID }, (_, e, next) => {
    viewed = null;
    generation += 1;
    forgetRenders();

    return next(e);
  });
};
