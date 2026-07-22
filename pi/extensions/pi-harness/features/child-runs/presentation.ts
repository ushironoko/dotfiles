import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Spacer,
  Text,
  type Component,
} from "@earendil-works/pi-tui";
import { stripTerminalControls } from "../../lib/terminal-text";
import type {
  ChildRunRenderSummary,
  ChildRunStatus,
  PersistedChildRunV1,
  PersistedChildRunsV1,
} from "./model";
import { decodePersistedChildRuns } from "./persistence";

export type ComponentLike = Component;

interface ToolResultLike {
  content?: unknown;
  details?: unknown;
}

interface RenderOptionsLike {
  expanded?: boolean;
  isPartial?: boolean;
}

interface RenderTheme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

// pi always supplies a Theme. The identity fallback preserves direct renderer
// use in tests and non-TUI compatibility shims that only exercise layout.
const plainTheme: RenderTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

class AdaptiveIndent implements Component {
  private readonly indented = new Box(1, 0);

  constructor(private readonly child: Component) {
    this.indented.addChild(child);
  }

  render(width: number): string[] {
    if (width <= 0) return [""];
    return width === 1 ? this.child.render(width) : this.indented.render(width);
  }

  invalidate(): void {
    this.indented.invalidate();
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contentText = (content: unknown): string => {
  if (!Array.isArray(content)) return "(no output)";
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
};

const safeInline = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const sanitized = stripTerminalControls(value, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized === "" ? fallback : sanitized;
};

const safeBlock = (value: string): string => stripTerminalControls(value);

const childRunStatuses: readonly ChildRunStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "aborted",
  "skipped",
];

const safeStatus = (value: unknown): ChildRunStatus =>
  typeof value === "string" &&
  childRunStatuses.includes(value as ChildRunStatus)
    ? (value as ChildRunStatus)
    : "failed";

const statusIcons: Record<ChildRunStatus, string> = {
  queued: "○",
  running: "◌",
  succeeded: "✓",
  failed: "✗",
  aborted: "■",
  skipped: "–",
};

export const statusIcon = (status: ChildRunStatus): string =>
  statusIcons[status];

const statusColors: Record<ChildRunStatus, ThemeColor> = {
  queued: "dim",
  running: "warning",
  succeeded: "success",
  failed: "error",
  aborted: "warning",
  skipped: "dim",
};

const statusColor = (status: ChildRunStatus): ThemeColor =>
  statusColors[status];

const summaryFromDetails = (
  details: unknown,
):
  | {
      label: string;
      runs: ChildRunRenderSummary[];
    }
  | undefined => {
  if (!isRecord(details) || !isRecord(details.childRuns)) return undefined;
  const { childRuns } = details;
  if (childRuns.kind === "summary" && Array.isArray(childRuns.runs)) {
    const runs = childRuns.runs.filter((run): run is ChildRunRenderSummary =>
      isRecord(run),
    );
    return {
      label:
        typeof childRuns.label === "string" ? childRuns.label : "child runs",
      runs,
    };
  }
  const persisted = decodePersistedChildRuns(childRuns);
  if (persisted === undefined) return undefined;
  return {
    label: persisted.label,
    runs: persisted.runs.map((run) => ({
      runId: run.runId,
      agent: run.agent,
      taskPreview: run.task.replace(/\s+/g, " ").trim(),
      taskIndex: run.taskIndex,
      stageIndex: run.stageIndex,
      stageName: run.stageName,
      status: run.status,
      terminalReason: run.terminalReason,
    })),
  };
};

export const persistedRows = (
  payload: PersistedChildRunsV1,
): PersistedChildRunV1[] => payload.runs;

const countStatuses = (
  runs: ChildRunRenderSummary[],
  status: ChildRunStatus,
): number => runs.filter((run) => safeStatus(run.status) === status).length;

const renderHeader = (
  label: string,
  runs: ChildRunRenderSummary[],
  theme: RenderTheme,
): Text => {
  const completed = runs.filter((run) => {
    const status = safeStatus(run.status);
    return status !== "queued" && status !== "running";
  }).length;
  const counters = childRunStatuses.flatMap((status) => {
    const count = countStatuses(runs, status);
    return count === 0
      ? []
      : [theme.fg(statusColor(status), `${statusIcon(status)}${count}`)];
  });
  const title = theme.fg(
    "toolTitle",
    theme.bold(safeInline(label, "child runs")),
  );
  const progress = theme.fg("muted", `${completed}/${runs.length} finished`);
  const counts = counters.length === 0 ? "" : `  ${counters.join("  ")}`;
  return new Text(`${title} ${progress}${counts}`, 0, 0);
};

const renderRun = (run: ChildRunRenderSummary, theme: RenderTheme): Text => {
  const status = safeStatus(run.status);
  const taskIndex =
    Number.isSafeInteger(run.taskIndex) && run.taskIndex >= 0
      ? run.taskIndex + 1
      : 1;
  const stageIndex =
    Number.isSafeInteger(run.stageIndex) && (run.stageIndex ?? -1) >= 0
      ? (run.stageIndex as number) + 1
      : undefined;
  const position =
    stageIndex === undefined ? `${taskIndex}` : `S${stageIndex}/T${taskIndex}`;
  const icon = theme.fg(statusColor(status), statusIcon(status));
  const badge = theme.fg("accent", theme.bold(`[${position}]`));
  const agent = theme.fg("toolTitle", safeInline(run.agent, "unknown agent"));
  const task = theme.fg(
    "toolOutput",
    safeInline(run.taskPreview, "(no task preview)"),
  );
  const reason =
    status === "succeeded" || run.terminalReason === undefined
      ? ""
      : ` ${theme.fg(statusColor(status), `(${safeInline(run.terminalReason, "unknown")})`)}`;
  return new Text(`${icon} ${badge} ${agent} — ${task}${reason}`, 0, 0);
};

export const renderChildRunsResult = (
  result: ToolResultLike,
  options: RenderOptionsLike = {},
  theme: RenderTheme = plainTheme,
  _context?: unknown,
): ComponentLike => {
  const summary = summaryFromDetails(result.details);
  if (summary === undefined) {
    return new Text(
      theme.fg("toolOutput", safeBlock(contentText(result.content))),
      0,
      0,
    );
  }

  const root = new Container();
  root.addChild(renderHeader(summary.label, summary.runs, theme));

  const rows = new Container();
  const visibleRuns = options.expanded
    ? summary.runs
    : summary.runs.slice(0, 8);
  for (const run of visibleRuns) rows.addChild(renderRun(run, theme));
  if (visibleRuns.length < summary.runs.length) {
    rows.addChild(
      new Text(
        theme.fg("dim", `… ${summary.runs.length - visibleRuns.length} more`),
        0,
        0,
      ),
    );
  }
  root.addChild(new AdaptiveIndent(rows));

  if (options.expanded) {
    const original = safeBlock(contentText(result.content));
    if (original !== "") {
      root.addChild(new Spacer(1));
      root.addChild(new Text(theme.fg("muted", theme.bold("Result")), 0, 0));
      root.addChild(
        new AdaptiveIndent(new Text(theme.fg("toolOutput", original), 0, 0)),
      );
    }
  }

  root.addChild(
    new Text(theme.fg("dim", "↳ /subagents to inspect transcripts"), 0, 0),
  );
  return root;
};
