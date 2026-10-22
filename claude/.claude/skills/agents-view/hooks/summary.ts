import type { Detail, Entry } from "./detail";

const SUMMARY_LIMIT = 200;
const PROMPT_CHARS = 3000;
const ACTIVITY_ENTRIES = 40;
const LINE_CHARS = 300;
const SYSTEM_PROMPT =
  "Summarize the state of a Claude Code subagent from the record given on stdin: what it is for, its progress and current state, and its latest output or result. Answer in Japanese plain text within 200 characters. No preamble, headings, lists or Markdown.";

export const SUMMARY_TIMEOUT_MS = 120_000;

export const SUMMARY_ARGV: readonly string[] = [
  "claude",
  "-p",
  "--model",
  "claude-haiku-5-5",
  "--effort",
  "xhigh",
  "--no-session-persistence",
  "--tools",
  "",
  "--disable-slash-commands",
  "--strict-mcp-config",
  "--system-prompt",
  SYSTEM_PROMPT,
];

const clipOf = (text: string, limit: number): string => {
  const chars = [...text.replaceAll(/\s+/g, " ").trim()];

  return chars.length > limit
    ? `${chars.slice(0, limit - 1).join("")}…`
    : chars.join("");
};

const activityLineOf = (entry: Entry): string | undefined => {
  switch (entry.kind) {
    case "tool": {
      return `- ${entry.name}: ${clipOf(entry.summary, LINE_CHARS)}`;
    }
    case "result": {
      return `  ${entry.isError ? "error" : "result"}: ${clipOf(entry.text, LINE_CHARS)}`;
    }
    case "text": {
      return `- said: ${clipOf(entry.text, LINE_CHARS)}`;
    }
    case "prompt": {
      return undefined;
    }
  }
};

export const summaryInputOf = (detail: Detail): string => {
  const prompt = detail.entries.find((entry) => entry.kind === "prompt");
  const activity = detail.entries
    .filter((entry) => entry.kind !== "prompt")
    .slice(-ACTIVITY_ENTRIES)
    .flatMap((entry) => activityLineOf(entry) ?? []);

  return [
    `Agent: ${detail.label}`,
    `Kind: ${detail.context.join(", ")}`,
    `Status: ${detail.status}, elapsed ${detail.elapsed}`,
    `Model: ${[detail.model, detail.effort].filter(Boolean).join(" ")}; ${detail.stats}`,
    "",
    "Task prompt:",
    prompt === undefined
      ? "(not recorded)"
      : [...prompt.text].slice(0, PROMPT_CHARS).join(""),
    "",
    "Recent activity (oldest first):",
    ...(activity.length === 0 ? ["(none recorded)"] : activity),
  ].join("\n");
};

export const summaryTextOf = (stdout: string): string =>
  clipOf(stdout, SUMMARY_LIMIT);
