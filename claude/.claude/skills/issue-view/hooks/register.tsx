import type { ElementTable, On } from "claude-code";

const PANE_ID = "issue-view";
const PANE_TITLE = "Issues";
const COMMAND = "issues";
const REFRESH_MS = 60_000;
const ISSUE_LIMIT = 500;
const MAX_TITLE_CHARS = 200;
const CHROME_ROWS = 5;
const ROW_LINES = 2;
const MIN_PAGE_SIZE = 5;
const GH_FIELDS = "number,title,url,author,assignees,labels,updatedAt";
const MINUTE_MS = 60_000;

interface Issue {
  number: number;
  title: string;
  url: string;
  author: string;
  assignees: readonly string[];
  labels: readonly string[];
  updatedAt?: number;
}

interface Listing {
  issues: readonly Issue[];
  isLoading: boolean;
  root?: string;
  loadedAt?: number;
  error?: string;
}

type Fetched =
  | { kind: "loaded"; issues: readonly Issue[]; root: string }
  | { kind: "error"; message: string };

interface Host {
  root: () => Promise<string>;
  now: () => Promise<number>;
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

const timeOf = (raw: unknown): number | undefined => {
  const time = typeof raw === "string" ? Date.parse(raw) : Number.NaN;

  return Number.isFinite(time) ? time : undefined;
};

const loginsOf = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.flatMap((user: unknown) => {
        const login =
          typeof user === "object" && user !== null
            ? (user as Record<string, unknown>).login
            : undefined;

        return typeof login === "string" && login !== "" ? [lineOf(login)] : [];
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
    assignees: loginsOf(record.assignees),
    labels: labelsOf(record.labels),
    updatedAt: timeOf(record.updatedAt),
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

const fetchListing = async (host: Host): Promise<Fetched> => {
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

const repoOf = (listing: Listing): string | undefined => {
  const [first] = listing.issues;

  if (first !== undefined) {
    const [, owner, repo] = new URL(first.url).pathname.split("/");

    if (owner !== undefined && repo !== undefined) {
      return `${owner}/${repo}`;
    }
  }

  return listing.root?.split("/").findLast((part) => part !== "");
};

const ageOf = (time: number | undefined, now: number): string => {
  if (time === undefined) {
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

const metaOf = (issue: Issue): string =>
  [
    issue.author === "" ? undefined : `@${issue.author}`,
    issue.assignees.length === 0
      ? undefined
      : `→ ${issue.assignees.map((login) => `@${login}`).join(", ")}`,
    issue.labels.length === 0 ? undefined : issue.labels.join(", "),
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

const matchesOf = (issues: readonly Issue[], query: string) => {
  const needle = query.trim().toLowerCase();

  return needle === ""
    ? issues
    : issues.filter((issue) =>
        [
          `#${issue.number}`,
          issue.title,
          `@${issue.author}`,
          ...issue.assignees.map((login) => `@${login}`),
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

const freshnessView = ({ Text }: Kit, listing: Listing) => {
  if (listing.isLoading) {
    return <Text color="warning">loading…</Text>;
  }

  return listing.loadedAt === undefined ? null : (
    <Text dimColor>{clockOf(listing.loadedAt)}</Text>
  );
};

const headerView = (
  { Box, Text, Button }: Kit,
  listing: Listing,
  counts: { shown: number; total: number },
  onRefresh: () => void,
) => {
  const repo = repoOf(listing);
  const count =
    counts.shown === counts.total
      ? `${counts.total} open`
      : `${counts.shown} of ${counts.total} open`;

  return (
    <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text bold>Issues</Text>
          <Text dimColor>
            {"  "}
            {count}
            {repo === undefined ? "" : ` · ${repo}`}
          </Text>
        </Text>
      </Box>
      <Box flexShrink={0} columnGap={2}>
        {freshnessView({ Box, Text, Button }, listing)}
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
    return <Text color="error">gh: {listing.error}</Text>;
  }

  if (counts.total === 0) {
    return (
      <Text dimColor>
        {listing.loadedAt === undefined
          ? "Loading open issues…"
          : "No open issues."}
      </Text>
    );
  }

  return counts.shown === 0 ? (
    <Text dimColor>No issues match "{query.trim()}".</Text>
  ) : null;
};

const rowView = (
  { Box, Text, Button }: Kit,
  issue: Issue,
  layout: { numberWidth: number; now: number },
  onOpen: () => void,
) => {
  const meta = metaOf(issue);

  return (
    <Box key={`issue:${issue.number}`} flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Button key={`open:${issue.number}`} plain onPress={onOpen}>
            <Text color="success">●</Text>{" "}
            <Text bold color="suggestion">
              {`#${issue.number}`.padEnd(layout.numberWidth)}
            </Text>{" "}
            <Text wrap="truncate-end">{issue.title}</Text>
          </Button>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{ageOf(issue.updatedAt, layout.now)}</Text>
        </Box>
      </Box>
      <Box paddingLeft={layout.numberWidth + 3}>
        <Text dimColor wrap="truncate-end">
          {meta === "" ? " " : meta}
        </Text>
      </Box>
    </Box>
  );
};

export const register = (on: On) => {
  let listing: Listing = { issues: [], isLoading: false };
  let notice: string | null = null;
  let query = "";
  let page = 0;
  let host: Host | null = null;
  let isOpen = false;
  let generation = 0;

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
              issues: fetched.issues,
              root: fetched.root,
              loadedAt: now,
              isLoading: false,
            }
          : { ...listing, isLoading: false, error: fetched.message };
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
      now: () => $.clock.now(),
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
    const now = await $.clock.now();
    const shown = matchesOf(listing.issues, query);
    const paged = pagedOf(shown, page, pageSizeOf(e.props.scroll.bodyRows));
    const counts = { shown: shown.length, total: listing.issues.length };
    const numberWidth = Math.max(
      2,
      ...paged.items.map((issue) => `#${issue.number}`.length),
    );
    const current = host;

    return (
      <Box flexDirection="column" paddingRight={1}>
        {headerView(kit, listing, counts, () => {
          if (current !== null) {
            void refresh(current).catch(() => undefined);
          }
        })}
        <Input
          key="filter"
          label="filter "
          placeholder="title, #number, label, @author or @assignee"
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
        {stateView(kit, listing, counts, query)}
        {notice === null ? null : <Text color="error">{notice}</Text>}
        <Box flexDirection="column" marginTop={1}>
          {paged.items.map((issue) =>
            rowView(kit, issue, { numberWidth, now }, () => {
              if (current !== null) {
                void press(current, issue.url).catch(() => undefined);
              }
            }),
          )}
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
