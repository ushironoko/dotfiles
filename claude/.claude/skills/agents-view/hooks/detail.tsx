import type { ElementTable } from "claude-code";

const PROMPT_LINES = 3;
const TEXT_LINES = 4;
const MAX_ACTIVITY = 40;
const MIN_NAME_WIDTH = 6;
const MAX_NAME_WIDTH = 16;
const HARNESS_PREAMBLE =
  /^\s*\[Workflow harness[^\]]*\][\s\S]*?\bfollows:[^\S\n]*\n/;
const HARNESS_FRAME = /^\s*\[Workflow harness\s*\W\s*([a-z ]+?)\s*\]/i;
const TIDY_RULES: readonly (readonly [RegExp, string])[] = [
  [/<\/?(?:tool_use_error|system-reminder)>/g, ""],
  [/\/(?:private\/)?var\/folders\/[^/\s]+\/[^/\s]+\/T\//g, "$$TMPDIR/"],
  [/\/(?:private\/)?tmp\/claude-\d+\/[^/\s]+\/[^/\s]+\//g, "$$TMPDIR/"],
  [/\/(?:Users|home)\/[^/\s]+\//g, "~/"],
];

export type Entry =
  | { kind: "prompt"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "result"; text: string; isError: boolean };

export type Kit = Pick<ElementTable<"terminal">, "Box" | "Text" | "Button">;

export interface Summary {
  state: "loading" | "done" | "error";
  text: string;
}

export interface Detail {
  id: string;
  summary?: Summary;
  label: string;
  status: string;
  elapsed: string;
  context: readonly string[];
  model?: string;
  effort?: string;
  stats: string;
  origin: string;
  entries: readonly Entry[];
}

export interface DetailView {
  isExpanded: boolean;
  onToggle: () => void;
}

export const tidyOf = (text: string): string =>
  TIDY_RULES.reduce(
    (current, [pattern, replacement]) =>
      current.replaceAll(pattern, replacement),
    text,
  );

const dedentOf = (text: string): string => {
  const lines = text.split("\n");
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.length - line.trimStart().length);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);

  return lines.map((line) => line.slice(indent)).join("\n");
};

export const harnessFrameOf = (text: string): string | undefined =>
  HARNESS_FRAME.exec(text)?.[1]?.toLowerCase();

export const promptTextOf = (text: string): string =>
  dedentOf(text.replace(HARNESS_PREAMBLE, ""))
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();

export const glyphOf = (status: string): string => {
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

export const colorOf = (status: string): string => {
  switch (status) {
    case "running": {
      return "warning";
    }
    case "completed": {
      return "success";
    }
    case "failed": {
      return "error";
    }
    default: {
      return "inactive";
    }
  }
};

const toolNameOf = (name: string): string =>
  name.startsWith("mcp__") ? (name.split("__").at(-1) ?? name) : name;

const sectionView = ({ Text }: Kit, title: string, note?: string) => (
  <Text>
    <Text bold dimColor>
      {title}
    </Text>
    {note === undefined ? "" : <Text dimColor> · {note}</Text>}
  </Text>
);

const summaryBodyOf = ({ Text }: Kit, summary: Summary) => {
  switch (summary.state) {
    case "loading": {
      return <Text dimColor>✻ Summarizing with haiku-5.5 · xhigh…</Text>;
    }
    case "done": {
      return <Text>{summary.text}</Text>;
    }
    case "error": {
      return (
        <Text color="error" wrap="truncate-end">
          Summary failed: {summary.text}
        </Text>
      );
    }
  }
};

const summaryView = (kit: Kit, summary: Summary | undefined) => {
  const { Box } = kit;

  if (summary === undefined) {
    return undefined;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={summary.state === "error" ? "error" : "inactive"}
      paddingX={1}
      marginBottom={1}
    >
      {summaryBodyOf(kit, summary)}
    </Box>
  );
};

const headerView = ({ Box, Text }: Kit, detail: Detail) => (
  <Box flexDirection="column">
    <Box columnGap={2}>
      <Box flexShrink={1}>
        <Text bold wrap="truncate-end">
          {detail.label}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={colorOf(detail.status)}>
          {glyphOf(detail.status)} {detail.status}
        </Text>
        <Text dimColor> {detail.elapsed}</Text>
      </Box>
    </Box>
    {detail.context.length === 0 ? undefined : (
      <Text dimColor wrap="truncate-end">
        {detail.context.join(" · ")}
      </Text>
    )}
    <Text wrap="truncate-end">
      <Text color="claude">{detail.model ?? "model ?"}</Text>
      {detail.effort === undefined ? "" : <Text bold> {detail.effort}</Text>}
      <Text dimColor>
        {"   "}
        {detail.stats}
      </Text>
    </Text>
  </Box>
);

const promptView = (
  kit: Kit,
  text: string | undefined,
  { isExpanded, onToggle }: DetailView,
) => {
  const { Box, Text, Button } = kit;

  if (text === undefined) {
    return undefined;
  }

  const lines = text.split("\n");
  const hidden = lines.length - PROMPT_LINES;
  const shown =
    isExpanded || hidden <= 0 ? lines : lines.slice(0, PROMPT_LINES);

  return (
    <Box flexDirection="column" marginTop={1}>
      {sectionView(kit, "PROMPT")}
      <Box flexDirection="column" paddingLeft={2}>
        {shown.map((line, index) => (
          <Text
            key={`prompt:${index}`}
            color="suggestion"
            wrap={isExpanded ? "wrap" : "truncate-end"}
          >
            {line === "" ? " " : line}
          </Text>
        ))}
        {hidden <= 0 ? undefined : (
          <Button
            key="prompt:toggle"
            plain
            dimColor
            label={isExpanded ? "▾ collapse" : `▸ show ${hidden} more lines`}
            onPress={onToggle}
          />
        )}
      </Box>
    </Box>
  );
};

const nameWidthOf = (entries: readonly Entry[]): number =>
  Math.min(
    MAX_NAME_WIDTH,
    Math.max(
      MIN_NAME_WIDTH,
      ...entries.map((entry) =>
        entry.kind === "tool" ? toolNameOf(entry.name).length : 0,
      ),
    ) + 2,
  );

const activityView = (
  { Box, Text }: Kit,
  entry: Entry,
  index: number,
  nameWidth: number,
) => {
  switch (entry.kind) {
    case "tool": {
      return (
        <Box key={`activity:${index}`}>
          <Box width={nameWidth} flexShrink={0}>
            <Text bold color="permission" wrap="truncate-end">
              {toolNameOf(entry.name)}
            </Text>
          </Box>
          <Text wrap="truncate-end">{entry.summary}</Text>
        </Box>
      );
    }
    case "result": {
      return (
        <Box key={`activity:${index}`} paddingLeft={nameWidth}>
          {entry.isError ? (
            <Text color="error" wrap="truncate-end">
              ✗ {entry.text}
            </Text>
          ) : (
            <Text dimColor wrap="truncate-end">
              ↳ {entry.text}
            </Text>
          )}
        </Box>
      );
    }
    case "text": {
      const lines = entry.text.split("\n");
      const hidden = lines.length - TEXT_LINES;

      return (
        <Box key={`activity:${index}`} flexDirection="column" marginTop={1}>
          {lines.slice(0, TEXT_LINES).map((line, row) => (
            <Text key={`text:${index}:${row}`} wrap="truncate-end">
              {line === "" ? " " : line}
            </Text>
          ))}
          {hidden <= 0 ? undefined : <Text dimColor>(+{hidden} lines)</Text>}
        </Box>
      );
    }
    case "prompt": {
      return undefined;
    }
  }
};

export const detailView = (
  kit: Kit,
  detail: Detail | undefined,
  view: DetailView,
) => {
  const { Box, Text } = kit;

  if (detail === undefined) {
    return <Text dimColor>Select an agent above.</Text>;
  }

  const prompt = detail.entries.find((entry) => entry.kind === "prompt");
  const activity = detail.entries.filter((entry) => entry.kind !== "prompt");
  const hidden = Math.max(0, activity.length - MAX_ACTIVITY);
  const calls = activity.filter((entry) => entry.kind === "tool").length;
  const shown = activity.slice(hidden);
  const nameWidth = nameWidthOf(shown);

  return (
    <Box flexDirection="column">
      {summaryView(kit, detail.summary)}
      {headerView(kit, detail)}
      {promptView(kit, prompt?.text, view)}
      <Box flexDirection="column" marginTop={1}>
        {sectionView(
          kit,
          "ACTIVITY",
          calls === 0 ? undefined : `${calls} call${calls === 1 ? "" : "s"}`,
        )}
        <Box flexDirection="column" paddingLeft={2}>
          {activity.length === 0 ? (
            <Text dimColor>No output recorded yet.</Text>
          ) : undefined}
          {hidden === 0 ? undefined : (
            <Text dimColor>… {hidden} earlier entries</Text>
          )}
          {shown.map((entry, index) =>
            activityView(kit, entry, hidden + index, nameWidth),
          )}
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {detail.origin}
        </Text>
      </Box>
    </Box>
  );
};
