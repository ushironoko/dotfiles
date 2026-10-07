import type { ElementTable, On } from "claude-code";

const PANE_ID = "pr-view";
const PANE_TITLE = "Pull Requests";
const COMMAND = "prs";
const REFRESH_MS = 60_000;
const PR_LIMIT = 50;
const MAX_TITLE_CHARS = 200;
const GH_FIELDS = "number,title,url,isDraft,author,headRefName";

interface PullRequest {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  author: string;
  branch: string;
}

type Listing =
  | { kind: "idle" }
  | { kind: "loading"; previous: readonly PullRequest[] }
  | { kind: "loaded"; prs: readonly PullRequest[]; root: string }
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

const pullRequestOf = (raw: unknown): PullRequest | null => {
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
    isDraft: record.isDraft === true,
    author: typeof author?.login === "string" ? lineOf(author.login) : "",
    branch:
      typeof record.headRefName === "string" ? lineOf(record.headRefName) : "",
  };
};

const pullRequestsOf = (stdout: string): PullRequest[] => {
  const parsed: unknown = JSON.parse(stdout);

  return Array.isArray(parsed)
    ? parsed.flatMap((raw) => {
        const pr = pullRequestOf(raw);

        return pr === null ? [] : [pr];
      })
    : [];
};

const fetchListing = async (host: Host): Promise<Listing> => {
  try {
    const root = await host.root();
    const { exitCode, stdout, stderr } = await host.run(
      [
        "gh",
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        String(PR_LIMIT),
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

    return { kind: "loaded", prs: pullRequestsOf(stdout), root };
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

const prsOf = (listing: Listing): readonly PullRequest[] => {
  switch (listing.kind) {
    case "loaded": {
      return listing.prs;
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
      return listing.prs.length === 0 ? (
        <Text dimColor>No open pull requests.</Text>
      ) : null;
    }
  }
};

const rowLabelOf = (pr: PullRequest): string =>
  `#${pr.number}${pr.isDraft ? " [draft]" : ""} ${pr.title}${pr.author === "" ? "" : ` @${pr.author}`}`;

const matchesOf = (prs: readonly PullRequest[], query: string) => {
  const needle = query.trim().toLowerCase();

  return needle === ""
    ? prs
    : prs.filter((pr) =>
        [`#${pr.number}`, pr.title, pr.branch, `@${pr.author}`].some((field) =>
          field.toLowerCase().includes(needle),
        ),
      );
};

export const register = (on: On) => {
  let listing: Listing = { kind: "idle" };
  let notice: string | null = null;
  let query = "";
  let host: Host | null = null;
  let isOpen = false;
  let generation = 0;

  const refresh = async (current: Host) => {
    generation += 1;
    const mine = generation;

    listing = { kind: "loading", previous: prsOf(listing) };
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
      description:
        "Toggle the pane listing this repository's open pull requests",
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
      return { text: "pr-view is not ready yet." };
    }

    if (isOpen) {
      isOpen = false;
      await host.close();

      return { text: "Pull requests pane hidden." };
    }

    isOpen = true;
    notice = null;
    await host.open();
    void refresh(host).catch(() => undefined);

    return { text: "Pull requests pane shown." };
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE_ID || e.surface !== "terminal") {
      return next(e);
    }

    const { Box, Text, Button, Input } = $.ui.resolve(e);
    const kit: Kit = { Box, Text, Button };
    const prs = prsOf(listing);
    const shown = matchesOf(prs, query);
    const current = host;

    return (
      <Box flexDirection="column" paddingRight={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>
            Open PRs{" "}
            {shown.length === prs.length
              ? prs.length
              : `${shown.length}/${prs.length}`}
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
          placeholder="title, #number, branch or @author"
          value={query}
          onInput={(value) => {
            query = value;
            current?.redraw();
          }}
          onSubmit={(value) => {
            query = value;
            current?.redraw();
          }}
        />
        {statusView(kit, listing)}
        {shown.length === 0 && prs.length > 0 ? (
          <Text dimColor>No pull requests match "{query.trim()}".</Text>
        ) : null}
        {notice === null ? null : <Text color="red">{notice}</Text>}
        <Box flexDirection="column">
          {shown.map((pr) => (
            <Box key={`pr:${pr.number}`} flexDirection="column">
              <Button
                key={`open:${pr.number}`}
                plain
                dimColor={pr.isDraft}
                label={rowLabelOf(pr)}
                onPress={() => {
                  if (current !== null) {
                    void press(current, pr.url).catch(() => undefined);
                  }
                }}
              />
              <Text dimColor wrap="truncate-end">
                {"   "}
                {pr.branch}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    );
  });

  on("ui.close", { id: PANE_ID }, (_, e, next) => {
    isOpen = false;
    query = "";
    generation += 1;

    return next(e);
  });
};
