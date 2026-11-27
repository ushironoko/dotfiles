import type { ElementTable, FsEntry, On } from "claude-code";

const PANE_ID = "memory-view";
const PANE_TITLE = "Memories";
const COMMAND = "memories";
const INDEX_FILE = "MEMORY.md";
const ROW_PREFIX = "open:";
const EDITOR_KEY = "editor";
const BACK_KEY = "back";
const REFRESH_MS = 30_000;
const REFOCUS_MS = 50;
const HEAD_BYTES = 4096;
const MAX_LINE_CHARS = 200;
const CHROME_ROWS = 6;
const ROW_LINES = 2;
const MIN_PAGE_SIZE = 5;
const EDITOR_CHROME_ROWS = 4;
const MIN_EDITOR_ROWS = 5;
const MINUTE_MS = 60_000;
const MEMORY_PATH_PATTERN = /persistent file-based memory at `([^`]+)`/;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/;
const FIELD_PATTERN = /^\s*([A-Za-z_][\w-]*):\s*(.*?)\s*$/;

interface Memory {
  file: string;
  path: string;
  name: string;
  description: string;
  type: string;
  mtimeMs: number;
  isIndex: boolean;
}

interface Listing {
  memories: readonly Memory[];
  isLoading: boolean;
  dir?: string;
  loadedAt?: number;
  error?: string;
}

type Fetched =
  | { kind: "loaded"; memories: readonly Memory[]; dir: string }
  | { kind: "error"; message: string };

type View =
  | { kind: "list" }
  | { kind: "detail"; memory: Memory; text: string }
  | { kind: "edit"; memory: Memory; text: string; draft: string };

interface IndexChange {
  path: string;
  before: string;
  after: string;
}

interface Removal {
  memory: Memory;
  text: string;
  index?: IndexChange;
}

interface Host {
  dir: () => Promise<string>;
  now: () => Promise<number>;
  list: (path: string) => Promise<FsEntry[]>;
  head: (path: string) => Promise<string>;
  read: (path: string) => Promise<string>;
  write: (path: string, text: string) => Promise<void>;
  remove: (
    path: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  open: () => Promise<unknown>;
  close: () => Promise<unknown>;
  focus: (key: string) => void;
  later: (fn: () => void) => void;
  redraw: () => void;
}

type Kit = Pick<
  ElementTable<"terminal">,
  "Box" | "Text" | "Button" | "Input" | "Markdown"
>;

interface Paged<T> {
  items: readonly T[];
  page: number;
  pages: number;
  first: number;
  last: number;
}

const isDrawable = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;

  return code >= 32 && code !== 127;
};

const lineOf = (text: string): string => {
  const cleaned = [...text.replaceAll(/\s+/g, " ").trim()]
    .filter(isDrawable)
    .join("");

  return cleaned.length > MAX_LINE_CHARS
    ? `${cleaned.slice(0, MAX_LINE_CHARS - 1)}…`
    : cleaned;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isMissing = (error: unknown): boolean => /ENOENT/.test(messageOf(error));

const unquote = (value: string): string =>
  /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;

const frontmatterOf = (text: string): Record<string, string> => {
  const block = FRONTMATTER_PATTERN.exec(text)?.[1] ?? "";

  return block.split(/\r?\n/).reduce<Record<string, string>>((fields, line) => {
    const [, key, value] = FIELD_PATTERN.exec(line) ?? [];

    return key === undefined ||
      value === undefined ||
      value === "" ||
      key in fields
      ? fields
      : { ...fields, [key]: unquote(value) };
  }, {});
};

const bodyOf = (text: string): string =>
  text.replace(FRONTMATTER_PATTERN, "").replace(/^\s+/, "");

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const parentOf = (path: string): string =>
  path.slice(0, Math.max(0, path.lastIndexOf("/")));

const memoryOf = (entry: FsEntry, dir: string, head: string): Memory => {
  const fields = frontmatterOf(head);
  const isIndex = entry.name === INDEX_FILE;

  return {
    file: entry.name,
    path: `${dir}/${entry.name}`,
    name: lineOf(
      isIndex ? entry.name : (fields.name ?? entry.name.replace(/\.md$/, "")),
    ),
    description: lineOf(fields.description ?? ""),
    type: lineOf(isIndex ? "index" : (fields.type ?? "")),
    mtimeMs: entry.mtimeMs,
    isIndex,
  };
};

const rankOf = (memory: Memory): number => (memory.isIndex ? 0 : 1);

const sortedOf = (memories: readonly Memory[]): Memory[] =>
  memories.toSorted((a, b) => rankOf(a) - rankOf(b) || b.mtimeMs - a.mtimeMs);

const fetchListing = async (host: Host): Promise<Fetched> => {
  try {
    const dir = await host.dir();
    const entries = await host
      .list(dir)
      .catch((error: unknown) =>
        isMissing(error) ? [] : Promise.reject(error),
      );
    const files = entries.filter(
      (entry) => entry.kind === "file" && entry.name.endsWith(".md"),
    );
    const memories = await Promise.all(
      files.map(async (entry) =>
        memoryOf(
          entry,
          dir,
          await host.head(`${dir}/${entry.name}`).catch(() => ""),
        ),
      ),
    );

    return { kind: "loaded", memories: sortedOf(memories), dir };
  } catch (error) {
    return { kind: "error", message: lineOf(messageOf(error)) };
  }
};

const unlinkIndex = async (
  host: Host,
  memory: Memory,
): Promise<IndexChange | undefined> => {
  const path = `${parentOf(memory.path)}/${INDEX_FILE}`;
  const before = await host.read(path).catch(() => undefined);

  if (before === undefined) {
    return undefined;
  }

  const pointer = new RegExp(
    String.raw`\]\((?:\./)?${escapeRegExp(memory.file)}\)`,
  );
  const after = before
    .split("\n")
    .filter((line) => !pointer.test(line))
    .join("\n");

  if (after === before) {
    return undefined;
  }

  await host.write(path, after);

  return { path, before, after };
};

const removeMemory = async (
  host: Host,
  memory: Memory,
): Promise<Removal | string> => {
  try {
    const text = await host.read(memory.path);
    const { exitCode, stderr } = await host.remove(memory.path);

    if (exitCode !== 0) {
      return lineOf(stderr) || `rm exited with ${exitCode}`;
    }

    const index = await unlinkIndex(host, memory).catch(() => undefined);

    return { memory, text, index };
  } catch (error) {
    return lineOf(messageOf(error));
  }
};

const restoreMemory = async (
  host: Host,
  removal: Removal,
): Promise<string | null> => {
  try {
    await host.write(removal.memory.path, removal.text);

    if (removal.index === undefined) {
      return null;
    }

    const current = await host.read(removal.index.path).catch(() => undefined);

    if (current !== removal.index.after) {
      return `restored ${removal.memory.file}; ${INDEX_FILE} changed since, its pointer was not put back`;
    }

    await host.write(removal.index.path, removal.index.before);

    return null;
  } catch (error) {
    return lineOf(messageOf(error));
  }
};

const ageOf = (time: number, now: number): string => {
  if (time <= 0) {
    return "";
  }

  const minutes = Math.max(0, Math.floor((now - time) / MINUTE_MS));

  if (minutes < 60) {
    return `${minutes}m`;
  }

  if (minutes < 60 * 24) {
    return `${Math.floor(minutes / 60)}h`;
  }

  if (minutes < 60 * 24 * 30) {
    return `${Math.floor(minutes / (60 * 24))}d`;
  }

  return `${Math.floor(minutes / (60 * 24 * 30))}mo`;
};

const clockOf = (time: number): string => {
  const date = new Date(time);

  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const typeColorOf = (type: string) => {
  switch (type) {
    case "index": {
      return "suggestion";
    }
    case "user": {
      return "permission";
    }
    case "feedback": {
      return "warning";
    }
    case "project": {
      return "success";
    }
    default: {
      return "inactive";
    }
  }
};

const matchesOf = (memories: readonly Memory[], query: string) => {
  const needle = query.trim().toLowerCase();

  return needle === ""
    ? memories
    : memories.filter((memory) =>
        [memory.name, memory.file, memory.description, memory.type].some(
          (field) => field.toLowerCase().includes(needle),
        ),
      );
};

const pageSizeOf = (bodyRows: number): number =>
  Math.max(MIN_PAGE_SIZE, Math.floor((bodyRows - CHROME_ROWS) / ROW_LINES));

const pagedOf = <T,>(
  items: readonly T[],
  page: number,
  size: number,
): Paged<T> => {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const first = current * size;

  return {
    items: items.slice(first, first + size),
    page: current,
    pages,
    first,
    last: Math.min(first + size, items.length),
  };
};

const projectOf = (dir: string | undefined): string | undefined =>
  dir
    ?.split("/")
    .findLast((part) => part !== "" && part !== "memory")
    ?.replace(/^-+/, "");

const freshnessView = ({ Text }: Kit, listing: Listing) => {
  if (listing.isLoading) {
    return <Text color="warning">loading…</Text>;
  }

  return listing.loadedAt === undefined ? null : (
    <Text dimColor>{clockOf(listing.loadedAt)}</Text>
  );
};

const headerView = (
  kit: Kit,
  listing: Listing,
  counts: { shown: number; total: number },
  onRefresh: () => void,
) => {
  const { Box, Text, Button } = kit;
  const project = projectOf(listing.dir);
  const count =
    counts.shown === counts.total
      ? `${counts.total} files`
      : `${counts.shown} of ${counts.total} files`;

  return (
    <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text bold>Memories</Text>
          <Text dimColor>
            {"  "}
            {count}
            {project === undefined ? "" : ` · ${project}`}
          </Text>
        </Text>
      </Box>
      <Box flexShrink={0} columnGap={2}>
        {freshnessView(kit, listing)}
        <Button
          key="refresh"
          plain
          dimColor
          label="↻ refresh"
          onPress={onRefresh}
        />
      </Box>
    </Box>
  );
};

const pagerView = <T,>(
  { Box, Text, Button }: Kit,
  paged: Paged<T>,
  total: number,
  onPage: (page: number) => void,
) =>
  paged.pages <= 1 ? null : (
    <Box flexDirection="row" columnGap={2}>
      {paged.page > 0 ? (
        <Button
          key="page:prev"
          plain
          hotkey="p"
          label="‹ prev"
          onPress={() => onPage(paged.page - 1)}
        />
      ) : (
        <Text dimColor>‹ prev</Text>
      )}
      <Text dimColor>
        page {paged.page + 1}/{paged.pages} · {paged.first + 1}–{paged.last} of{" "}
        {total}
      </Text>
      {paged.page < paged.pages - 1 ? (
        <Button
          key="page:next"
          plain
          hotkey="n"
          label="next ›"
          onPress={() => onPage(paged.page + 1)}
        />
      ) : (
        <Text dimColor>next ›</Text>
      )}
    </Box>
  );

const stateView = (
  { Text }: Kit,
  listing: Listing,
  counts: { shown: number; total: number },
  query: string,
) => {
  if (listing.error !== undefined) {
    return <Text color="error">memory: {listing.error}</Text>;
  }

  if (counts.total === 0) {
    return (
      <Text dimColor>
        {listing.loadedAt === undefined
          ? "Loading memories…"
          : "No memories in this project yet."}
      </Text>
    );
  }

  return counts.shown === 0 ? (
    <Text dimColor>No memories match "{query.trim()}".</Text>
  ) : null;
};

const rowView = (
  { Box, Text, Button }: Kit,
  memory: Memory,
  now: number,
  onOpen: () => void,
) => (
  <Box key={`memory:${memory.file}`} flexDirection="column">
    <Box flexDirection="row" columnGap={1}>
      <Box flexGrow={1} flexShrink={1}>
        <Button key={`${ROW_PREFIX}${memory.file}`} plain onPress={onOpen}>
          <Text color={typeColorOf(memory.type)}>
            {memory.isIndex ? "◆" : "●"}
          </Text>{" "}
          <Text bold wrap="truncate-end">
            {memory.name}
          </Text>
        </Button>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor>{ageOf(memory.mtimeMs, now)}</Text>
      </Box>
    </Box>
    <Box paddingLeft={2}>
      <Text dimColor wrap="truncate-end">
        {[memory.type, memory.description]
          .filter((part) => part !== "")
          .join(" · ") || memory.file}
      </Text>
    </Box>
  </Box>
);

const listFooterView = (
  { Box, Text, Button }: Kit,
  options: { canUndo: boolean; onDelete: () => void; onUndo: () => void },
) => (
  <Box flexDirection="row" columnGap={2} marginTop={1}>
    <Text dimColor>enter: open</Text>
    <Button
      key="delete"
      plain
      dimColor
      hotkey="x"
      label="delete"
      onPress={options.onDelete}
    />
    {options.canUndo ? (
      <Button
        key="undo"
        plain
        dimColor
        hotkey="u"
        label="undo delete"
        onPress={options.onUndo}
      />
    ) : null}
  </Box>
);

const metaLineOf = (memory: Memory, now: number): string =>
  [
    memory.type,
    memory.file,
    memory.mtimeMs > 0 ? `updated ${ageOf(memory.mtimeMs, now)} ago` : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");

const detailView = (
  kit: Kit,
  view: Extract<View, { kind: "detail" }>,
  now: number,
  handlers: { onBack: () => void; onEdit: () => void },
) => {
  const { Box, Text, Button, Markdown } = kit;
  const body = view.memory.isIndex ? view.text : bodyOf(view.text);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Button
          key={BACK_KEY}
          plain
          hotkey="h"
          label="‹ back"
          onPress={handlers.onBack}
        />
        <Button
          key="edit"
          plain
          hotkey="i"
          label="edit"
          onPress={handlers.onEdit}
        />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={typeColorOf(view.memory.type)} wrap="wrap">
          {view.memory.name}
        </Text>
        <Text dimColor wrap="truncate-end">
          {metaLineOf(view.memory, now)}
        </Text>
        {view.memory.description === "" ? null : (
          <Text italic wrap="wrap">
            {view.memory.description}
          </Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {body.trim() === "" ? (
          <Text dimColor>(empty)</Text>
        ) : (
          <Markdown text={body} />
        )}
      </Box>
    </Box>
  );
};

const editView = (
  kit: Kit,
  view: Extract<View, { kind: "edit" }>,
  rows: number,
  handlers: {
    onInput: (value: string) => void;
    onSave: (value: string) => void;
  },
) => {
  const { Box, Text, Input } = kit;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Text wrap="truncate-end">
          <Text bold color="warning">
            Editing
          </Text>
          <Text> {view.memory.file}</Text>
        </Text>
        <Text dimColor>esc: save & exit</Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        enter: save · shift+enter: newline · tab: save & exit
      </Text>
      <Box marginTop={1}>
        <Input
          key={EDITOR_KEY}
          rows={rows}
          autoFocus
          value={view.draft}
          submitLabel="save"
          onInput={handlers.onInput}
          onSubmit={handlers.onSave}
        />
      </Box>
    </Box>
  );
};

export const register = (on: On) => {
  let listing: Listing = { isLoading: false, memories: [] };
  let view: View = { kind: "list" };
  let notice: { text: string; isError: boolean } | null = null;
  let query = "";
  let page = 0;
  let focused: string | undefined;
  let removal: Removal | null = null;
  let announcedDir: string | undefined;
  let host: Host | null = null;
  let isOpen = false;
  let generation = 0;

  const say = (text: string, isError = false) => {
    notice = { text, isError };
  };

  const refresh = async (current: Host) => {
    generation += 1;
    const mine = generation;

    listing = { ...listing, isLoading: true };
    current.redraw();

    const fetched = await fetchListing(current);
    const now = await current.now();

    if (mine === generation) {
      listing =
        fetched.kind === "loaded"
          ? {
              memories: fetched.memories,
              dir: fetched.dir,
              loadedAt: now,
              isLoading: false,
            }
          : { ...listing, isLoading: false, error: fetched.message };
      current.redraw();
    }
  };

  const openMemory = async (current: Host, memory: Memory) => {
    try {
      const text = await current.read(memory.path);

      view = { kind: "detail", memory, text };
      notice = null;
      current.redraw();
      current.focus(BACK_KEY);
    } catch (error) {
      say(lineOf(messageOf(error)), true);
      void refresh(current).catch(() => undefined);
    }
  };

  const backToList = (current: Host) => {
    const file = view.kind === "list" ? undefined : view.memory.file;

    view = { kind: "list" };
    current.redraw();

    if (file !== undefined) {
      current.focus(`${ROW_PREFIX}${file}`);
    }
  };

  const startEdit = (current: Host) => {
    if (view.kind !== "detail") {
      return;
    }

    view = { ...view, kind: "edit", draft: view.text };
    notice = null;
    current.redraw();
    current.focus(EDITOR_KEY);
  };

  const save = async (current: Host, draft: string): Promise<boolean> => {
    if (view.kind !== "edit") {
      return true;
    }

    const editing = view;

    if (draft === editing.text) {
      return true;
    }

    try {
      await current.write(editing.memory.path, draft);
      view = { ...editing, text: draft, draft };
      say(`saved ${editing.memory.file}`);
      void refresh(current).catch(() => undefined);

      return true;
    } catch (error) {
      say(`not saved: ${lineOf(messageOf(error))}`, true);
      current.redraw();

      return false;
    }
  };

  const leaveEdit = async (current: Host) => {
    if (view.kind !== "edit") {
      return;
    }

    const isSaved = await save(current, view.draft);

    if (isSaved && view.kind === "edit") {
      view = { kind: "detail", memory: view.memory, text: view.text };
      current.redraw();
      current.focus(BACK_KEY);
    }
  };

  const stepBack = async (current: Host) => {
    if (view.kind === "edit") {
      await leaveEdit(current);
    } else if (view.kind === "detail") {
      backToList(current);
    }
  };

  const deleteFocused = async (current: Host) => {
    const shown = matchesOf(listing.memories, query);
    const position = shown.findIndex((memory) => memory.file === focused);
    const memory = shown[position];

    if (memory === undefined) {
      say("focus a memory row (Tab or arrows) before pressing x", true);
      current.redraw();

      return;
    }

    if (memory.isIndex) {
      say(`${INDEX_FILE} is the index and is not deleted from here`, true);
      current.redraw();

      return;
    }

    const removed = await removeMemory(current, memory);

    if (typeof removed === "string") {
      say(`not deleted: ${removed}`, true);
      current.redraw();

      return;
    }

    removal = removed;
    say(
      `deleted ${memory.file}${removed.index === undefined ? "" : ` and its ${INDEX_FILE} pointer`}`,
    );

    const neighbour = shown[position + 1] ?? shown[position - 1];

    focused = undefined;
    await refresh(current);

    if (neighbour !== undefined) {
      current.focus(`${ROW_PREFIX}${neighbour.file}`);
    }
  };

  const undoDelete = async (current: Host) => {
    if (removal === null) {
      return;
    }

    const restoring = removal;
    const problem = await restoreMemory(current, restoring);

    removal = null;
    say(problem ?? `restored ${restoring.memory.file}`, problem !== null);
    await refresh(current);
    current.focus(`${ROW_PREFIX}${restoring.memory.file}`);
  };

  const reset = () => {
    isOpen = false;
    view = { kind: "list" };
    query = "";
    page = 0;
    focused = undefined;
    removal = null;
    notice = null;
    generation += 1;
  };

  on("session.start", async ($, e, next) => {
    const fallbackDir = async () => {
      const { transcriptPath } = await $.session.info();

      if (transcriptPath === "") {
        throw new Error("this session keeps no transcript to locate memory by");
      }

      return `${parentOf(transcriptPath)}/memory`;
    };
    const current: Host = {
      dir: async () => announcedDir ?? (await fallbackDir()),
      now: () => $.clock.now(),
      list: (path) => $.fs.list(path),
      head: (path) => $.fs.read(path, { length: HEAD_BYTES }),
      read: (path) => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      remove: (path) => $.process.run(["rm", "-f", "--", path]),
      open: () =>
        $.ui.open({
          id: PANE_ID,
          title: PANE_TITLE,
          focus: true,
          closeOnEscape: true,
        }),
      close: () => $.ui.close({ id: PANE_ID }),
      focus: (key) => {
        void $.ui.focus({ requestId: PANE_ID, key }).catch(() => undefined);
      },
      later: (fn) => {
        $.clock.after(REFOCUS_MS, fn);
      },
      redraw: () => $.ui.invalidate("ui.render"),
    };
    host = current;

    await $.command.register({
      name: COMMAND,
      description: "Toggle the pane listing this project's memory files",
    });

    const loop = () =>
      $.clock.after(REFRESH_MS, () => {
        const pending =
          isOpen && view.kind === "list" ? refresh(current) : Promise.resolve();

        void pending.catch(() => undefined).finally(loop);
      });
    loop();

    return next(e);
  });

  on("prompt.section", { name: "memory" }, async (_, e, next) => {
    const result = await next(e);
    const found = MEMORY_PATH_PATTERN.exec(result.text ?? "")?.[1];

    if (found !== undefined) {
      announcedDir = found.replace(/\/+$/, "");
    }

    return result;
  });

  on("tool.call", { tool: ["Write", "Edit"] }, async (_, e, next) => {
    const result = await next(e);
    const { dir } = listing;

    if (
      host !== null &&
      isOpen &&
      dir !== undefined &&
      e.file_path.startsWith(`${dir}/`)
    ) {
      void refresh(host).catch(() => undefined);
    }

    return result;
  });

  on("command.run", { command: COMMAND }, async () => {
    if (host === null) {
      return { text: "memory-view is not ready yet." };
    }

    if (isOpen) {
      await leaveEdit(host);
      reset();
      await host.close();

      return { text: "Memories pane hidden." };
    }

    isOpen = true;
    notice = null;
    await host.open();
    void refresh(host).catch(() => undefined);

    return { text: "Memories pane shown." };
  });

  on("ui.focus", { requestId: PANE_ID }, async (_, e, next) => {
    const result = await next(e);

    if (result.deny !== undefined || e.component !== "Pane") {
      return result;
    }

    if (view.kind === "list") {
      focused = e.element?.startsWith(ROW_PREFIX)
        ? e.element.slice(ROW_PREFIX.length)
        : undefined;
    } else if (
      view.kind === "edit" &&
      e.element !== undefined &&
      e.element !== EDITOR_KEY &&
      host !== null
    ) {
      void leaveEdit(host).catch(() => undefined);
    }

    return result;
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE_ID || e.surface !== "terminal") {
      return next(e);
    }

    const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e);
    const kit: Kit = { Box, Text, Button, Input, Markdown };
    const now = await $.clock.now();
    const current = host;
    const noticeView =
      notice === null ? null : (
        <Text color={notice.isError ? "error" : "success"} wrap="wrap">
          {notice.text}
        </Text>
      );

    if (current === null) {
      return <Text dimColor>memory-view is starting…</Text>;
    }

    if (view.kind === "detail") {
      return (
        <Box flexDirection="column" paddingRight={1}>
          {noticeView}
          {detailView(kit, view, now, {
            onBack: () => backToList(current),
            onEdit: () => startEdit(current),
          })}
        </Box>
      );
    }

    if (view.kind === "edit") {
      return (
        <Box flexDirection="column" paddingRight={1}>
          {noticeView}
          {editView(
            kit,
            view,
            Math.max(
              MIN_EDITOR_ROWS,
              e.props.scroll.bodyRows - EDITOR_CHROME_ROWS,
            ),
            {
              onInput: (value) => {
                if (view.kind === "edit") {
                  view = { ...view, draft: value };
                }
              },
              onSave: (value) => {
                if (view.kind === "edit") {
                  view = { ...view, draft: value };
                  void save(current, value).catch(() => undefined);
                }
              },
            },
          )}
        </Box>
      );
    }

    const shown = matchesOf(listing.memories, query);
    const paged = pagedOf(shown, page, pageSizeOf(e.props.scroll.bodyRows));
    const counts = { shown: shown.length, total: listing.memories.length };

    return (
      <Box flexDirection="column" paddingRight={1}>
        {headerView(kit, listing, counts, () => {
          void refresh(current).catch(() => undefined);
        })}
        <Input
          key="filter"
          label="filter "
          placeholder="name, file, type or description"
          value={query}
          onInput={(value) => {
            query = value;
            page = 0;
            current.redraw();
          }}
          onSubmit={(value) => {
            query = value;
            page = 0;
            current.redraw();
          }}
        />
        {pagerView(kit, paged, shown.length, (target) => {
          page = target;
          current.redraw();
        })}
        {stateView(kit, listing, counts, query)}
        {noticeView}
        <Box flexDirection="column" marginTop={1}>
          {paged.items.map((memory) =>
            rowView(kit, memory, now, () => {
              void openMemory(current, memory).catch(() => undefined);
            }),
          )}
        </Box>
        {listFooterView(kit, {
          canUndo: removal !== null,
          onDelete: () => {
            void deleteFocused(current).catch(() => undefined);
          },
          onUndo: () => {
            void undoDelete(current).catch(() => undefined);
          },
        })}
      </Box>
    );
  });

  on("ui.close", { id: PANE_ID }, async (_, e, next) => {
    if (e.origin.kind === "person" && view.kind !== "list" && host !== null) {
      const current = host;

      await stepBack(current);
      current.later(() => {
        void current.open().catch(() => undefined);
      });

      return { deny: "memory-view stepped back instead of closing" };
    }

    if (host !== null && view.kind === "edit") {
      await save(host, view.draft).catch(() => false);
    }

    reset();

    return next(e);
  });
};
