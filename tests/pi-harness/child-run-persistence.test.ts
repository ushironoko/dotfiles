import { describe, expect, test } from "bun:test";
import {
  CHILD_RUNS_SCHEMA,
  CHILD_RUNS_VERSION,
  MAX_RUN_TRANSCRIPT_BYTES,
  MAX_RUN_TRANSCRIPT_ITEMS,
  type PersistedChildRunsV1,
} from "../../pi/extensions/pi-harness/features/child-runs/model";
import {
  attachChildRunsDetails,
  decodePersistedChildRuns,
  extractPersistedChildRuns,
} from "../../pi/extensions/pi-harness/features/child-runs/persistence";

const payload = (
  overrides: Partial<PersistedChildRunsV1> = {},
): PersistedChildRunsV1 => ({
  schema: CHILD_RUNS_SCHEMA,
  version: CHILD_RUNS_VERSION,
  kind: "transcript",
  invocationId: "invocation-1",
  source: "workflow",
  label: "workflow",
  createdAt: 100,
  runs: [
    {
      runId: "run-1",
      agent: "reviewer",
      task: "review task",
      taskIndex: 0,
      stageIndex: 0,
      stageName: "review",
      status: "succeeded",
      terminalReason: "completed",
      startedAt: 101,
      endedAt: 102,
      transcript: [
        { type: "assistant", text: "safe answer" },
        { type: "tool", localId: 1, name: "read", status: "succeeded" },
      ],
    },
  ],
  ...overrides,
});

describe("child-run persisted details", () => {
  test("preserves existing tool details under a namespaced childRuns key", () => {
    const childRuns = payload();
    expect(attachChildRunsDetails({ stages: ["legacy"] }, childRuns)).toEqual({
      stages: ["legacy"],
      childRuns,
    });
  });

  test("decodes an allowlisted payload and strips terminal controls", () => {
    const hostile = payload();
    hostile.label = "work\u001b]2;spoof\u0007flow";
    hostile.runs[0]!.transcript[0] = {
      type: "assistant",
      text: "safe\u001b[31m answer\u001b[0m",
    };
    const decoded = decodePersistedChildRuns(hostile)!;
    expect(decoded.label).toBe("workflow");
    expect(decoded.runs[0]?.transcript[0]).toEqual({
      type: "assistant",
      text: "safe answer",
    });
  });

  test("rejects future, malformed, nonterminal, and oversized data", () => {
    expect(
      decodePersistedChildRuns({ ...payload(), version: 999 }),
    ).toBeUndefined();
    expect(
      decodePersistedChildRuns({ ...payload(), source: "unknown" }),
    ).toBeUndefined();
    const running = payload();
    (running.runs[0] as unknown as { status: string }).status = "running";
    expect(decodePersistedChildRuns(running)).toBeUndefined();
    const oversized = payload({ label: "x".repeat(600 * 1024) });
    // Label is safely capped, so the decoded form remains bounded.
    expect(
      Buffer.byteLength(
        JSON.stringify(decodePersistedChildRuns(oversized)),
        "utf8",
      ),
    ).toBeLessThan(600 * 1024);
  });

  test("re-caps a hostile replay payload to the per-run byte limit", () => {
    const hostile = payload();
    hostile.runs[0]!.transcript = Array.from({ length: 20 }, (_, index) => ({
      type: "assistant" as const,
      text: `${index}:${"x".repeat(10_000)}`,
    }));
    const decoded = decodePersistedChildRuns(hostile)!;
    expect(
      Buffer.byteLength(JSON.stringify(decoded.runs[0]), "utf8"),
    ).toBeLessThanOrEqual(MAX_RUN_TRANSCRIPT_BYTES);
    expect(
      decoded.runs[0]?.transcript.some((item) => item.type === "truncated"),
    ).toBe(true);
  });

  test("keeps replay transcripts within the item cap including truncation", () => {
    const hostile = payload();
    hostile.runs[0]!.transcript = Array.from(
      { length: MAX_RUN_TRANSCRIPT_ITEMS + 1 },
      (_, index) => ({
        type: "assistant" as const,
        text: `answer-${index}`,
      }),
    );

    const transcript = decodePersistedChildRuns(hostile)!.runs[0]!.transcript;
    expect(transcript).toHaveLength(MAX_RUN_TRANSCRIPT_ITEMS);
    expect(transcript.at(-1)).toMatchObject({
      type: "truncated",
      omittedItems: 2,
    });
  });

  test("extracts only active-branch tool-result payloads and deduplicates ids", () => {
    const older = payload();
    const newer = payload({ label: "newer" });
    const branch = [
      {
        type: "message",
        message: { role: "assistant", details: { childRuns: payload() } },
      },
      {
        type: "message",
        message: { role: "toolResult", details: { childRuns: older } },
      },
      { type: "custom", data: { childRuns: payload() } },
      {
        type: "message",
        message: { role: "toolResult", details: { childRuns: newer } },
      },
    ];
    expect(extractPersistedChildRuns(branch)).toEqual([newer]);
  });

  test("never admits unallowlisted privacy sentinels", () => {
    const raw = payload() as unknown as Record<string, unknown>;
    raw.stderr = "SECRET_STDERR";
    raw.cwd = "/SECRET_CWD";
    raw.provider = "SECRET_PROVIDER";
    const run = (raw.runs as Record<string, unknown>[])[0]!;
    run.liveDraft = "SECRET_DRAFT";
    run.arguments = { command: "SECRET_ARGUMENT" };
    run.result = "SECRET_RESULT";
    run.thinking = "SECRET_THINKING";
    run.rawToolCallId = "SECRET_TOOL_ID";
    const decoded = decodePersistedChildRuns(raw)!;
    const serialized = JSON.stringify(decoded);
    for (const secret of [
      "SECRET_STDERR",
      "SECRET_CWD",
      "SECRET_PROVIDER",
      "SECRET_DRAFT",
      "SECRET_ARGUMENT",
      "SECRET_RESULT",
      "SECRET_THINKING",
      "SECRET_TOOL_ID",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
