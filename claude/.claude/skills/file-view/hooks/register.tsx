import type { ElementTable, On, RenderSurface } from "claude-code";

const PANE_ID = "file-view";
const TOOL_NAME = "open_file";
const TOOL_ID = "mcp__file-view__open_file";
const PAGE_CHARS = 90000;
const MARKDOWN_PATH = /\.(md|markdown)$/i;
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
    }
  | { kind: "error"; path: string; message: string };

interface Engine {
  read: (path: string) => Promise<string>;
  open: (title: string) => Promise<unknown>;
  redraw: () => void;
}

type BodyKit = Pick<ElementTable<"terminal">, "Text" | "Code" | "Markdown">;

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

const pagesOf = (text: string, startLine = 1): Page[] => {
  if (text.length <= PAGE_CHARS) {
    return [{ source: text, startLine }];
  }

  const cut = text.lastIndexOf("\n", PAGE_CHARS);
  const end = cut > 0 ? cut : PAGE_CHARS;
  const source = text.slice(0, end);
  const rest = text.slice(cut > 0 ? end + 1 : end);
  const nextLine = startLine + linesIn(source) + (cut > 0 ? 1 : 0);

  return [{ source, startLine }, ...pagesOf(rest, nextLine)];
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const loadedOf = async (engine: Engine, path: string): Promise<Viewed> => {
  try {
    const raw = await engine.read(path);

    if (raw.includes("\u0000")) {
      return { kind: "error", path, message: "Binary file" };
    }

    return {
      kind: "text",
      path,
      pages: pagesOf(drawableOf(raw)),
      page: 0,
      isMarkdown: MARKDOWN_PATH.test(path),
      full: raw,
    };
  } catch (error) {
    return { kind: "error", path, message: messageOf(error) };
  }
};

const bodyOf = ({ Text, Code, Markdown }: BodyKit, shown: Viewed | null) => {
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
    case "text": {
      const page = shown.pages[shown.page] ?? { source: "", startLine: 1 };

      return shown.isMarkdown ? (
        <Markdown key={`md:${shown.page}`} text={page.source} />
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

export const register = (on: On) => {
  let viewed: Viewed | null = null;
  let generation = 0;

  const show = async (engine: Engine, path: string) => {
    generation += 1;
    const current = generation;

    viewed = { kind: "loading", path };
    await engine.open(basenameOf(path));
    engine.redraw();

    const loaded = await loadedOf(engine, path);

    if (current === generation) {
      viewed = loaded;
      engine.redraw();
    }
  };

  on("session.start", async ($, e, next) => {
    await $.tool.register({
      name: TOOL_NAME,
      description:
        "Show a file's contents with syntax highlighting in the file-view pane beside the transcript. Use when the user asks to open, show or display a file in the pane.",
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
    const engine: Engine = {
      read: (file) => $.fs.read(file),
      open: (title) => $.ui.open({ id: PANE_ID, title }),
      redraw: () => $.ui.invalidate("ui.render"),
    };

    await show(engine, path);

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

    const engine: Engine = {
      read: (file) => $.fs.read(file),
      open: (title) => $.ui.open({ id: PANE_ID, title }),
      redraw: () => $.ui.invalidate("ui.render"),
    };

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

    const { Box, Text, Code, Markdown, Button } = $.ui.resolve(e);
    const shown = viewed;

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

    return (
      <Box flexDirection="column" paddingRight={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text bold wrap="truncate-start">
            {shown?.path ?? "file-view"}
          </Text>
          {shown?.kind === "text" ? (
            <Box flexDirection="row" gap={2}>
              {pager}
              <Button
                key="copy"
                plain
                dimColor
                label="⎘ copy"
                onPress={(press) =>
                  void copy(shown.full, press.surface).catch(() => undefined)
                }
              />
            </Box>
          ) : null}
        </Box>
        {bodyOf({ Text, Code, Markdown }, shown)}
      </Box>
    );
  });

  on("ui.close", { id: PANE_ID }, (_, e, next) => {
    viewed = null;
    generation += 1;

    return next(e);
  });
};
