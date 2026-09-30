import type { ElementTable, On } from "claude-code";

const PANE_ID = "file-view";
const MAX_SOURCE_CHARS = 10000;
const FILE_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

type Viewed =
  | { kind: "loading"; path: string }
  | { kind: "text"; path: string; source: string; isTruncated: boolean }
  | { kind: "error"; path: string; message: string };

interface Engine {
  read: (path: string) => Promise<string>;
  open: (title: string) => Promise<unknown>;
  redraw: () => void;
}

type BodyKit = Pick<ElementTable<"terminal">, "Box" | "Text" | "Code">;

const filePathOf = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const path = record.file_path ?? record.notebook_path;

  return typeof path === "string" && path !== "" ? path : null;
};

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

const boundedOf = (text: string): { source: string; isTruncated: boolean } => {
  if (text.length <= MAX_SOURCE_CHARS) {
    return { source: text, isTruncated: false };
  }

  const cut = text.lastIndexOf("\n", MAX_SOURCE_CHARS);

  return {
    source: text.slice(0, cut > 0 ? cut : MAX_SOURCE_CHARS - 1),
    isTruncated: true,
  };
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
      ...boundedOf(drawableOf(raw.slice(0, MAX_SOURCE_CHARS * 2))),
    };
  } catch (error) {
    return { kind: "error", path, message: messageOf(error) };
  }
};

const bodyOf = ({ Box, Text, Code }: BodyKit, shown: Viewed | null) => {
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
      return (
        <Box flexDirection="column">
          <Code source={shown.source} path={shown.path} startLine={1} />
          {shown.isTruncated ? (
            <Text dimColor>… truncated at {MAX_SOURCE_CHARS} characters</Text>
          ) : null}
        </Box>
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

    const { Box, Text, Code } = $.ui.resolve(e);
    const shown = viewed;

    return (
      <Box flexDirection="column" paddingRight={1}>
        <Text bold wrap="truncate-start">
          {shown?.path ?? "file-view"}
        </Text>
        {bodyOf({ Box, Text, Code }, shown)}
      </Box>
    );
  });

  on("ui.close", { id: PANE_ID }, (_, e, next) => {
    viewed = null;
    generation += 1;

    return next(e);
  });
};
