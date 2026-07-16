import {
  stripTerminalControls,
  truncateToWidth,
  wrapPlainText,
} from "../../lib/terminal-text";
import type {
  ChildRunRenderSummary,
  ChildRunStatus,
  PersistedChildRunV1,
  PersistedChildRunsV1,
} from "./model";
import { decodePersistedChildRuns } from "./persistence";

export interface ComponentLike {
  render(width: number): string[];
  invalidate(): void;
  handleInput?(data: string): void;
  dispose?(): void;
}

interface ToolResultLike {
  content?: unknown;
  details?: unknown;
}

interface RenderOptionsLike {
  expanded?: boolean;
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

export const statusIcon = (status: ChildRunStatus): string => {
  switch (status) {
    case "queued":
      return "○";
    case "running":
      return "◌";
    case "succeeded":
      return "✓";
    case "failed":
      return "✗";
    case "aborted":
      return "■";
    case "skipped":
      return "–";
  }
};

const summaryFromDetails = (
  details: unknown,
):
  | {
      label: string;
      runs: ChildRunRenderSummary[];
    }
  | undefined => {
  if (!isRecord(details) || !isRecord(details.childRuns)) return undefined;
  const childRuns = details.childRuns;
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

class PlainLinesComponent implements ComponentLike {
  constructor(private readonly lines: string[]) {}

  render(width: number): string[] {
    if (width <= 0) return [""];
    return this.lines.flatMap((line) =>
      wrapPlainText(stripTerminalControls(line), width).map((wrapped) =>
        truncateToWidth(wrapped, width, ""),
      ),
    );
  }

  invalidate(): void {}
}

export const renderChildRunsResult = (
  result: ToolResultLike,
  options: RenderOptionsLike = {},
): ComponentLike => {
  const summary = summaryFromDetails(result.details);
  if (summary === undefined) {
    return new PlainLinesComponent([contentText(result.content)]);
  }
  const completed = summary.runs.filter(
    (run) => run.status !== "queued" && run.status !== "running",
  ).length;
  const lines = [
    `${summary.label}: ${completed}/${summary.runs.length} finished`,
  ];
  const visibleRuns = options.expanded
    ? summary.runs
    : summary.runs.slice(0, 8);
  for (const run of visibleRuns) {
    const stage =
      run.stageIndex === undefined
        ? `${run.taskIndex + 1}`
        : `S${run.stageIndex + 1}/T${run.taskIndex + 1}`;
    lines.push(
      `${statusIcon(run.status)} ${stage} ${run.agent} — ${run.taskPreview}`,
    );
  }
  if (visibleRuns.length < summary.runs.length) {
    lines.push(`… ${summary.runs.length - visibleRuns.length} more`);
  }
  if (options.expanded) {
    const original = contentText(result.content);
    if (original !== "") lines.push("", "Result:", original);
  }
  lines.push("/subagents to inspect transcripts");
  return new PlainLinesComponent(lines);
};
