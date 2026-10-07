import type { ElementTable, On } from "claude-code";

const PANE_ID = "agents-view";
const PANE_TITLE = "Agents";
const COMMAND = "subagents";
const TICK_MS = 500;
const MAX_AGENTS = 100;
const MAX_ENTRIES = 300;
const MAX_TEXT_CHARS = 2000;
const MAX_LINE_CHARS = 100;
const SUMMARY_FIELDS = [
  "file_path",
  "notebook_path",
  "command",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
] as const;

type Entry =
  | { kind: "prompt"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "result"; text: string; isError: boolean };

interface Tracked {
  id: string;
  label: string;
  type: string;
  status: string;
  isListed: boolean;
  seq: number;
  entries: readonly Entry[];
}

interface Listed {
  id: string;
  description: string;
  type: string;
  status: string;
}

interface Host {
  list: () => Promise<readonly Listed[]>;
  open: () => Promise<unknown>;
  redraw: () => void;
}

interface Row {
  type: string;
  role?: string;
  isMeta?: true;
  content: readonly { type: string; [field: string]: unknown }[];
}

type Kit = Pick<ElementTable<"terminal">, "Box" | "Text" | "Button">;

const isDrawable = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;

  return code === 9 || code === 10 || (code >= 32 && code !== 127);
};

const drawableOf = (text: string, limit: number): string => {
  const cleaned = [...text.slice(0, limit * 2).replaceAll("\r\n", "\n")]
    .filter(isDrawable)
    .join("");

  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
};

const lineOf = (text: string): string =>
  drawableOf(text.replaceAll(/\s+/g, " ").trim(), MAX_LINE_CHARS);

const summaryOf = (input: unknown): string => {
  if (typeof input !== "object" || input === null) {
    return "";
  }

  const record = input as Record<string, unknown>;
  const found = SUMMARY_FIELDS.map((field) => record[field]).find(
    (value): value is string => typeof value === "string" && value !== "",
  );

  return found === undefined ? "" : lineOf(found);
};

const resultTextOf = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part: unknown) =>
      typeof part === "object" &&
      part !== null &&
      (part as Record<string, unknown>).type === "text"
        ? String((part as Record<string, unknown>).text ?? "")
        : "",
    )
    .join("\n");
};

const resultEntryOf = (content: unknown, isError: boolean): Entry => {
  const text = resultTextOf(content);
  const lines = text === "" ? 0 : text.split("\n").length;
  const head = lineOf(
    text.split("\n").find((line) => line.trim() !== "") ?? "",
  );

  return {
    kind: "result",
    isError,
    text: lines > 1 ? `${head} (+${lines - 1} lines)` : head,
  };
};

const entriesOf = (row: Row, isOpening: boolean): Entry[] =>
  row.content.flatMap((block): Entry[] => {
    if (block.type === "text" && typeof block.text === "string") {
      const text = drawableOf(block.text, MAX_TEXT_CHARS);

      if (text.trim() === "") {
        return [];
      }

      return [
        row.role === "user" && isOpening
          ? { kind: "prompt", text }
          : { kind: "text", text },
      ];
    }

    if (block.type === "tool_use") {
      return [
        {
          kind: "tool",
          name: typeof block.name === "string" ? block.name : "tool",
          summary: summaryOf(block.input),
        },
      ];
    }

    if (block.type === "tool_result") {
      return [resultEntryOf(block.content, block.is_error === true)];
    }

    return [];
  });

const statusOfReason = (reason: string): string => {
  switch (reason) {
    case "answer": {
      return "completed";
    }
    case "aborted": {
      return "killed";
    }
    default: {
      return "failed";
    }
  }
};

const glyphOf = (status: string): string => {
  switch (status) {
    case "running": {
      return "●";
    }
    case "completed": {
      return "✓";
    }
    case "failed": {
      return "✗";
    }
    case "killed": {
      return "■";
    }
    default: {
      return "○";
    }
  }
};

const orderOf = (agents: ReadonlyMap<string, Tracked>): Tracked[] =>
  [...agents.values()].toSorted((a, b) => {
    const running =
      Number(b.status === "running") - Number(a.status === "running");

    return running === 0 ? b.seq - a.seq : running;
  });

const prunedOf = (
  agents: ReadonlyMap<string, Tracked>,
): ReadonlyMap<string, Tracked> =>
  agents.size <= MAX_AGENTS
    ? agents
    : new Map(
        orderOf(agents)
          .slice(0, MAX_AGENTS)
          .map((one) => [one.id, one]),
      );

const signatureOf = (agents: ReadonlyMap<string, Tracked>): string =>
  [...agents.values()]
    .map((one) => `${one.id}:${one.status}:${one.entries.length}:${one.label}`)
    .join("|");

const entryView = ({ Text }: Kit, entry: Entry) => {
  switch (entry.kind) {
    case "prompt": {
      return <Text color="cyan">▶ {entry.text}</Text>;
    }
    case "text": {
      return <Text>{entry.text}</Text>;
    }
    case "tool": {
      return (
        <Text dimColor wrap="truncate-end">
          → {entry.name} {entry.summary}
        </Text>
      );
    }
    case "result": {
      return entry.isError ? (
        <Text color="red" wrap="truncate-end">
          {"  "}← {entry.text}
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          {"  "}← {entry.text}
        </Text>
      );
    }
  }
};

const detailView = (kit: Kit, agent: Tracked | undefined) => {
  const { Box, Text } = kit;

  if (agent === undefined) {
    return <Text dimColor>Select an agent above.</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">
        {agent.label}
      </Text>
      <Text dimColor>
        {agent.type} · {agent.status} · {agent.id}
      </Text>
      {agent.entries.length === 0 ? (
        <Text dimColor>No output recorded yet.</Text>
      ) : (
        <Box flexDirection="column">
          {agent.entries.map((entry) => entryView(kit, entry))}
        </Box>
      )}
    </Box>
  );
};

export const register = (on: On) => {
  let agents: ReadonlyMap<string, Tracked> = new Map();
  let selectedId: string | null = null;
  let host: Host | null = null;
  let isOpen = false;
  let hasAutoOpened = false;
  let isDirty = false;
  let drawnSignature = "";
  let seq = 0;

  const upsert = (id: string, change: (current: Tracked) => Tracked) => {
    const current = agents.get(id) ?? {
      id,
      label: id,
      type: "workflow",
      status: "running",
      isListed: false,
      seq: (seq += 1),
      entries: [],
    };
    agents = prunedOf(new Map([...agents, [id, change(current)]]));
    isDirty = true;
  };

  const openPane = async (current: Host) => {
    isOpen = true;
    await current.open();
    current.redraw();
  };

  const tick = async (current: Host) => {
    const listed = await current.list().catch(() => []);

    listed.forEach((info) =>
      upsert(info.id, (one) => ({
        ...one,
        label: lineOf(info.description) || one.label,
        type: info.type,
        status: info.status,
        isListed: true,
      })),
    );

    if (!hasAutoOpened && agents.size > 0) {
      hasAutoOpened = true;

      if (!isOpen) {
        await openPane(current);
      }
    }

    const signature = signatureOf(agents);

    if (isDirty && signature !== drawnSignature) {
      drawnSignature = signature;
      current.redraw();
    }

    isDirty = false;
  };

  on("session.start", async ($, e, next) => {
    const current: Host = {
      list: () => $.agent.list(),
      open: () => $.ui.open({ id: PANE_ID, title: PANE_TITLE }),
      redraw: () => $.ui.invalidate("ui.render"),
    };
    host = current;

    await $.command.register({
      name: COMMAND,
      description: "Toggle the pane listing this session's subagents",
    });
    const loop = () =>
      $.clock.after(
        TICK_MS,
        () =>
          void tick(current)
            .catch(() => undefined)
            .finally(loop),
      );
    loop();

    return next(e);
  });

  on("command.run", { command: COMMAND }, async ($) => {
    if (host === null) {
      return { text: "agents-view is not ready yet." };
    }

    if (isOpen) {
      isOpen = false;
      await $.ui.close({ id: PANE_ID });

      return { text: "Agents pane hidden." };
    }

    hasAutoOpened = true;
    await openPane(host);

    return { text: "Agents pane shown." };
  });

  on("session.append", (_, e, next) => {
    const { agentId, message } = e;

    if (
      agentId !== undefined &&
      (message.type === "user" || message.type === "assistant") &&
      message.isMeta !== true
    ) {
      upsert(agentId, (one) => {
        const added = entriesOf(message, one.entries.length === 0);
        const opening = added.find((entry) => entry.kind === "prompt");

        return {
          ...one,
          label:
            !one.isListed && one.label === one.id && opening !== undefined
              ? lineOf(opening.text)
              : one.label,
          entries: [...one.entries, ...added].slice(-MAX_ENTRIES),
        };
      });
    }

    return next(e);
  });

  on("turn.complete", (_, e, next) => {
    const { agentId } = e;

    if (agentId !== undefined && agents.has(agentId)) {
      upsert(agentId, (one) =>
        one.isListed ? one : { ...one, status: statusOfReason(e.reason) },
      );
    }

    return next(e);
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE_ID || e.surface !== "terminal") {
      return next(e);
    }

    const { Box, Text, Button } = $.ui.resolve(e);
    const kit: Kit = { Box, Text, Button };
    const ordered = orderOf(agents);
    const selected =
      agents.get(selectedId ?? "") ??
      ordered.find((one) => one.status === "running") ??
      ordered[0];
    const running = ordered.filter((one) => one.status === "running").length;

    return (
      <Box flexDirection="column" paddingRight={1}>
        <Text bold>
          Agents {running} running / {ordered.length} total
        </Text>
        {ordered.length === 0 ? (
          <Text dimColor>No subagents in this session yet.</Text>
        ) : (
          <Box flexDirection="column">
            {ordered.map((one) => (
              <Button
                key={`agent:${one.id}`}
                plain
                dimColor={one.id !== selected?.id}
                label={`${one.id === selected?.id ? "❯" : " "} ${glyphOf(one.status)} [${one.type}] ${one.label}`}
                onPress={() => {
                  selectedId = one.id;
                  host?.redraw();
                }}
              />
            ))}
          </Box>
        )}
        <Text dimColor>{"─".repeat(Math.max(1, e.props.bodyColumns - 1))}</Text>
        {detailView(kit, selected)}
      </Box>
    );
  });

  on("ui.close", { id: PANE_ID }, (_, e, next) => {
    isOpen = false;

    return next(e);
  });
};
