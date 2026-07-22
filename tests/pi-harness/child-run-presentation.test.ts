import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { renderChildRunsResult } from "../../pi/extensions/pi-harness/features/child-runs/presentation";
import {
  stripTerminalControls,
  visibleWidth,
} from "../../pi/extensions/pi-harness/lib/terminal-text";

interface ToolResultLike {
  content?: unknown;
  details?: unknown;
}

const colorCodes: Partial<Record<ThemeColor, number>> = {
  accent: 36,
  success: 32,
  error: 31,
  warning: 33,
  muted: 90,
  dim: 90,
  text: 37,
  toolTitle: 35,
  toolOutput: 37,
};

const theme = {
  fg(color: ThemeColor, text: string): string {
    return `\u001b[${colorCodes[color] ?? 37}m${text}\u001b[39m`;
  },
  bold(text: string): string {
    return `\u001b[1m${text}\u001b[22m`;
  },
} as Theme;

const summaryResult = (): ToolResultLike => ({
  content: [{ type: "text", text: "full workflow result" }],
  details: {
    childRuns: {
      kind: "summary",
      label: "workflow",
      runs: [
        ["queued", "queued task"],
        ["running", "running task"],
        ["succeeded", "successful task"],
        ["failed", "failed task", "model-error"],
        ["aborted", "aborted task", "parent-abort"],
        ["skipped", "skipped task", "dependency-failed"],
        ["succeeded", "another successful task"],
        ["running", "another running task"],
        ["queued", "another queued task"],
        ["failed", "another failed task", "setup-error"],
      ].map(([status, taskPreview, terminalReason], taskIndex) => ({
        runId: `run-${taskIndex}`,
        agent: `agent-${taskIndex}`,
        taskPreview,
        taskIndex,
        stageIndex: 0,
        stageName: "review",
        status,
        terminalReason,
      })),
    },
  },
});

const render = (
  result: ToolResultLike,
  options: { expanded?: boolean; isPartial?: boolean } = {},
  width = 120,
): { raw: string[]; plain: string[] } => {
  const raw = renderChildRunsResult(result, options, theme, {} as never).render(
    width,
  );
  return {
    raw,
    plain: raw.map((line) => stripTerminalControls(line).trimEnd()),
  };
};

describe("rich child-run tool result rendering", () => {
  test("styles a compact status summary and limits its run rows", () => {
    const { raw, plain } = render(summaryResult());

    expect(raw.join("\n")).toContain("\u001b[35m");
    expect(plain[0]).toBe("workflow 6/10 finished  ○2  ◌2  ✓2  ✗2  ■1  –1");
    expect(plain.some((line) => line.includes("[S1/T1] agent-0"))).toBe(true);
    expect(
      plain.some((line) => line.includes("failed task (model-error)")),
    ).toBe(true);
    expect(plain.some((line) => line.includes("agent-7"))).toBe(true);
    expect(plain.some((line) => line.includes("agent-8"))).toBe(false);
    expect(plain).toContain(" … 2 more");
    expect(plain.at(-1)).toBe("↳ /subagents to inspect transcripts");
  });

  test("shows every run and the original result when expanded", () => {
    const { plain } = render(summaryResult(), { expanded: true });

    expect(plain.some((line) => line.includes("[S1/T10] agent-9"))).toBe(true);
    expect(plain).not.toContain(" … 2 more");
    expect(plain).toContain("Result");
    expect(plain).toContain(" full workflow result");
  });

  test("keeps compact and expanded output within a one-column width", () => {
    for (const expanded of [false, true]) {
      const { raw, plain } = render(summaryResult(), { expanded }, 1);
      const joined = plain.join("");

      expect(raw.every((line) => visibleWidth(line) <= 1)).toBe(true);
      expect(joined).toContain("workflow");
      expect(joined).toContain("[S1/T1]agent-0");
      if (expanded) expect(joined).toContain("fullworkflowresult");
    }
  });

  test("sanitizes tool-controlled text while retaining theme styling", () => {
    const result: ToolResultLike = {
      content: [{ type: "text", text: "unused" }],
      details: {
        childRuns: {
          kind: "summary",
          label: "work\u001b]0;owned\u0007flow",
          runs: [
            {
              runId: "run-1",
              agent: "reviewer\tname",
              taskPreview: "inspect\u001b[31m red\u001b[0m\nnext",
              taskIndex: 0,
              status: "running",
            },
          ],
        },
      },
    };

    const { raw, plain } = render(result, {}, 40);

    expect(raw.join("\n")).toContain("\u001b[35m");
    expect(raw.join("\n")).not.toContain("]0;owned");
    expect(plain[0]).toContain("workflow 0/1 finished");
    expect(plain.join("\n")).toContain("[1] reviewer name — inspect red next");
    expect(raw.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  test("uses a themed, sanitized, width-safe fallback for unknown details", () => {
    const { raw, plain } = render(
      {
        content: [
          {
            type: "text",
            text: "safe\u001b]0;owned\u0007 output with a very long tail",
          },
        ],
        details: {},
      },
      {},
      16,
    );

    expect(raw.join("\n")).toContain("\u001b[37m");
    expect(raw.join("\n")).not.toContain("]0;owned");
    expect(plain.join(" ")).toContain("safe output");
    expect(raw.every((line) => visibleWidth(line) <= 16)).toBe(true);
  });
});
