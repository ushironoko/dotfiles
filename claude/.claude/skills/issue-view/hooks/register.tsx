import type { ElementTable, On } from "claude-code";

const PANE_ID = "issue-view";
const PANE_TITLE = "Issues";
const COMMAND = "issues";
const REFRESH_MS = 60_000;
const ISSUE_LIMIT = 500;
const MAX_TITLE_CHARS = 200;
const CHROME_ROWS = 6;
const ROW_LINES = 2;
const MIN_PAGE_SIZE = 5;
const GH_FIELDS = "number,title,url,author,labels";

interface Issue {
  number: number;
  title: string;
  url: string;
  author: string;
  labels: readonly string[];
}

type Listing =
  | { kind: "idle" }
  | { kind: "loading"; previous: readonly Issue[] }
  | { kind: "loaded"; issues: readonly Issue[]; root: string }
  | { kind: "error"; message: string };

interface Host {
  root: () => Promise<string>;
  run: (
    argv: readonly string[],
    cwd?: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  open: () => Promise<unknown>;
  close: () => Promise<unknown>;
  redraw: () => void;
}

type Kit = Pick<ElementTable<"terminal">, "Box" | "Text" | "Button">;

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

  return cleaned.length > MAX_TITLE_CHARS
    ? `${cleaned.slice(0, MAX_TITLE_CHARS - 1)}…`
    : cleaned;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isWebUrl = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const labelsOf = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.flatMap((label: unknown) => {
        const name =
          typeof label === "object" && label !== null
            ? (label as Record<string, unknown>).name
            : undefined;

        return typeof name === "string" && name !== "" ? [lineOf(name)] : [];
      })
    : [];

const issueOf = (raw: unknown): Issue | null => {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const author = record.author as Record<string, unknown> | null | undefined;

  if (typeof record.number !== "number" || !isWebUrl(record.url)) {
    return null;
  }

  return {
    number: record.number,
    title: lineOf(typeof record.title === "string" ? record.title : ""),
    url: record.url,
    author: typeof author?.login === "string" ? lineOf(author.login) : "",
    labels: labelsOf(record.labels),
  };
};

const issuesOf = (stdout: string): Issue[] => {
  const parsed: unknown = JSON.parse(stdout);

  return Array.isArray(parsed)
    ? parsed.flatMap((raw) => {
        const issue = issueOf(raw);

        return issue === null ? [] : [issue];
      })
    : [];
};

const fetchListing = async (host: Host): Promise<Listing> => {
  try {
    const root = await host.root();
    const { exitCode, stdout, stderr } = await host.run(
      [
        "zsh",
        "-c",
        '"$@"',
        "zsh",
        "gh",
        "issue",
        "list",
        "--state",
        "open",
        "--limit",
        String(ISSUE_LIMIT),
        "--json",
        GH_FIELDS,
      ],
      root,
    );

    if (exitCode !== 0) {
      return {
        kind: "error",
        message: lineOf(stderr) || `gh exited with ${exitCode}`,
      };
    }

    return { kind: "loaded", issues: issuesOf(stdout), root };
  } catch (error) {
    return { kind: "error", message: lineOf(messageOf(error)) };
  }
};

const openInBrowser = async (
  host: Host,
  url: string,
): Promise<string | null> => {
  try {
    const { exitCode, stderr } = await host.run(["open", url]);

    return exitCode === 0
      ? null
      : lineOf(stderr) || `open exited with ${exitCode}`;
  } catch (error) {
    return lineOf(messageOf(error));
  }
};

const issuesOfListing = (listing: Listing): readonly Issue[] => {
  switch (listing.kind) {
    case "loaded": {
      return listing.issues;
    }
    case "loading": {
      return listing.previous;
    }
    default: {
      return [];
    }
  }
};

const statusView = ({ Text }: Kit, listing: Listing) => {
  switch (listing.kind) {
    case "idle":
    case "loading": {
      return <Text dimColor>Loading…</Text>;
    }
    case "error": {
      return <Text color="red">{listing.message}</Text>;
    }
    case "loaded": {
      return listing.issues.length === 0 ? (
        <Text dimColor>No open issues.</Text>
      ) : null;
    }
  }
};

const rowLabelOf = (issue: Issue): string =>
  `#${issue.number} ${issue.title}${issue.author === "" ? "" : ` @${issue.author}`}`;

const matchesOf = (issues: readonly Issue[], query: string) => {
  const needle = query.trim().toLowerCase();

  return needle === ""
    ? issues
    : issues.filter((issue) =>
        [
          `#${issue.number}`,
          issue.title,
          `@${issue.author}`,
          ...issue.labels,
        ].some((field) => field.toLowerCase().includes(needle)),
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

export const register = (on: On) => {
  let listing: Listing = { kind: "idle" };
  let notice: string | null = null;
  let query = "";
  let page = 0;
  let host: Host | null = null;
  let isOpen = false;
  let generation = 0;

  const refresh = async (current: Host) => {
    generation += 1;
    const mine = generation;

    listing = { kind: "loading", previous: issuesOfListing(listing) };
    current.redraw();

    const next = await fetchListing(current);

    if (mine === generation) {
      listing = next;
      current.redraw();
    }
  };

  const press = async (current: Host, url: string) => {
    notice = await openInBrowser(current, url);
    current.redraw();
  };

  on("session.start", async ($, e, next) => {
    const current: Host = {
      root: () => $.session.root(),
      run: (argv, cwd) =>
        $.process.run(argv, cwd === undefined ? undefined : { cwd }),
      open: () => $.ui.open({ id: PANE_ID, title: PANE_TITLE }),
      close: () => $.ui.close({ id: PANE_ID }),
      redraw: () => $.ui.invalidate("ui.render"),
    };
    host = current;

    await $.command.register({
      name: COMMAND,
      description: "Toggle the pane listing this repository's open issues",
    });

    const loop = () =>
      $.clock.after(REFRESH_MS, () => {
        const pending = isOpen ? refresh(current) : Promise.resolve();

        void pending.catch(() => undefined).finally(loop);
      });
    loop();

    return next(e);
  });

  on("command.run", { command: COMMAND }, async () => {
    if (host === null) {
      return { text: "issue-view is not ready yet." };
    }

    if (isOpen) {
      isOpen = false;
      await host.close();

      return { text: "Issues pane hidden." };
    }

    isOpen = true;
    notice = null;
    await host.open();
    void refresh(host).catch(() => undefined);

    return { text: "Issues pane shown." };
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE_ID || e.surface !== "terminal") {
      return next(e);
    }

    const { Box, Text, Button, Input } = $.ui.resolve(e);
    const kit: Kit = { Box, Text, Button };
    const issues = issuesOfListing(listing);
    const shown = matchesOf(issues, query);
    const paged = pagedOf(shown, page, pageSizeOf(e.props.scroll.bodyRows));
    const current = host;

    return (
      <Box flexDirection="column" paddingRight={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>
            Open issues{" "}
            {shown.length === issues.length
              ? issues.length
              : `${shown.length}/${issues.length}`}
          </Text>
          <Button
            key="refresh"
            plain
            dimColor
            label="↻ refresh"
            onPress={() => {
              if (current !== null) {
                void refresh(current).catch(() => undefined);
              }
            }}
          />
        </Box>
        {listing.kind === "loaded" ? (
          <Text dimColor wrap="truncate-start">
            {listing.root}
          </Text>
        ) : null}
        <Input
          key="filter"
          label="filter "
          placeholder="title, #number, label or @author"
          value={query}
          onInput={(value) => {
            query = value;
            page = 0;
            current?.redraw();
          }}
          onSubmit={(value) => {
            query = value;
            page = 0;
            current?.redraw();
          }}
        />
        {pagerView(kit, paged, shown.length, (target) => {
          page = target;
          current?.redraw();
        })}
        {statusView(kit, listing)}
        {shown.length === 0 && issues.length > 0 ? (
          <Text dimColor>No issues match "{query.trim()}".</Text>
        ) : null}
        {notice === null ? null : <Text color="red">{notice}</Text>}
        <Box flexDirection="column">
          {paged.items.map((issue) => (
            <Box key={`issue:${issue.number}`} flexDirection="column">
              <Button
                key={`open:${issue.number}`}
                plain
                label={rowLabelOf(issue)}
                onPress={() => {
                  if (current !== null) {
                    void press(current, issue.url).catch(() => undefined);
                  }
                }}
              />
              {issue.labels.length === 0 ? null : (
                <Text dimColor wrap="truncate-end">
                  {"   "}
                  {issue.labels.join(", ")}
                </Text>
              )}
            </Box>
          ))}
        </Box>
      </Box>
    );
  });

  on("ui.close", { id: PANE_ID }, (_, e, next) => {
    isOpen = false;
    query = "";
    page = 0;
    generation += 1;

    return next(e);
  });
};
