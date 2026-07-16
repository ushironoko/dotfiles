import { describe, expect, test } from "bun:test";
import {
  CHILD_RUNS_SCHEMA,
  CHILD_RUNS_VERSION,
  MAX_PERSISTED_INVOCATION_BYTES,
  MAX_REPLAY_BYTES,
  MAX_REPLAY_INVOCATIONS,
  MAX_RUN_TRANSCRIPT_BYTES,
  MAX_RUN_TRANSCRIPT_ITEMS,
  type PersistedChildRunsV1,
} from "../../pi/extensions/pi-harness/features/child-runs/model";
import { ChildRunRegistry } from "../../pi/extensions/pi-harness/features/child-runs/registry";

const registry = () => {
  let id = 0;
  let now = 100;
  return new ChildRunRegistry({
    idFactory: () => `id-${++id}`,
    now: () => ++now,
  });
};

const begin = (
  store: ChildRunRegistry,
  count = 2,
  toolCallId = "parent-tool-call",
) =>
  store.beginInvocation({
    toolCallId,
    source: "subagent",
    mode: "parallel",
    label: toolCallId,
    runs: Array.from({ length: count }, (_, index) => ({
      agent: `agent-${index + 1}`,
      task: `task-${index + 1}`,
      taskIndex: index,
    })),
  });

const persistedHistory = (
  invocationId: string,
  runId: string,
): PersistedChildRunsV1 => ({
  schema: CHILD_RUNS_SCHEMA,
  version: CHILD_RUNS_VERSION,
  kind: "transcript",
  invocationId,
  source: "subagent",
  mode: "single",
  label: invocationId,
  createdAt: 1,
  runs: [
    {
      runId,
      agent: "reviewer",
      task: "review",
      taskIndex: 0,
      status: "succeeded",
      terminalReason: "completed",
      transcript: [{ type: "assistant", text: "done" }],
    },
  ],
});

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

describe("child-run registry", () => {
  test("tracks stable declaration order and monotonic terminal states", () => {
    const store = registry();
    const { invocationId, runIds } = begin(store);
    store.observe(runIds[0]!, { type: "process_started", at: 10 });
    store.observe(runIds[0]!, {
      type: "assistant_final",
      text: "done",
      at: 11,
      model: "model",
      stopReason: "stop",
    });
    store.finishRun(runIds[0]!, {
      status: "succeeded",
      reason: "completed",
      endedAt: 12,
    });
    store.finishRun(runIds[0]!, {
      status: "failed",
      reason: "model-error",
    });
    store.finishRun(runIds[1]!, {
      status: "skipped",
      reason: "fail-fast",
    });

    const snapshot = store.getInvocation(invocationId)!;
    expect(snapshot.runs.map((run) => run.runId)).toEqual(runIds);
    expect(snapshot.runs.map((run) => run.status)).toEqual([
      "succeeded",
      "skipped",
    ]);
    expect(snapshot.runs[0]?.transcript).toEqual([
      { type: "assistant", text: "done" },
    ]);
    expect(snapshot.runs[0]?.liveDraft).toBeUndefined();
  });

  test("updates tool markers without retaining payloads or raw ids", () => {
    const store = registry();
    const { invocationId, runIds } = begin(store, 1);
    const runId = runIds[0]!;
    store.observe(runId, { type: "process_started", at: 1 });
    store.observe(runId, {
      type: "tool_started",
      localId: 1,
      name: "bash",
      at: 2,
    });
    store.observe(runId, {
      type: "tool_finished",
      localId: 1,
      name: "bash",
      failed: false,
      at: 3,
    });
    store.finishRun(runId, {
      status: "succeeded",
      reason: "completed",
    });

    expect(store.getInvocation(invocationId)?.runs[0]?.transcript).toEqual([
      { type: "tool", localId: 1, name: "bash", status: "succeeded" },
    ]);
  });

  test("marks a tool without an end event interrupted when its run terminates", () => {
    const store = registry();
    const { invocationId, runIds } = begin(store, 1);
    const runId = runIds[0]!;
    store.observe(runId, { type: "process_started", at: 1 });
    store.observe(runId, {
      type: "tool_started",
      localId: 1,
      name: "bash",
      at: 2,
    });
    store.finishRun(runId, { status: "failed", reason: "spawn-error" });

    expect(store.getInvocation(invocationId)?.runs[0]?.transcript).toEqual([
      { type: "tool", localId: 1, name: "bash", status: "interrupted" },
    ]);
    expect(store.toPersisted(invocationId)?.runs[0]?.transcript).toEqual([
      { type: "tool", localId: 1, name: "bash", status: "interrupted" },
    ]);
  });

  test("terminalizes every queued and running child with distinct reasons", () => {
    const store = registry();
    const { invocationId, runIds } = begin(store, 3);
    store.observe(runIds[0]!, { type: "process_started", at: 1 });
    store.terminalizeInvocation(
      invocationId,
      { status: "skipped", reason: "dependency-failed" },
      { status: "aborted", reason: "parent-abort" },
    );

    expect(
      store
        .getInvocation(invocationId)
        ?.runs.map((run) => [run.status, run.terminalReason]),
    ).toEqual([
      ["aborted", "parent-abort"],
      ["skipped", "dependency-failed"],
      ["skipped", "dependency-failed"],
    ]);
  });

  test("isolates subscriber errors", () => {
    const store = registry();
    let calls = 0;
    store.subscribe(() => {
      throw new Error("bad subscriber");
    });
    store.subscribe(() => calls++);
    expect(() => begin(store, 1)).not.toThrow();
    expect(calls).toBe(1);
  });

  test("enforces run and invocation transcript caps fairly", () => {
    const store = registry();
    const { invocationId, runIds } = begin(store, 64);
    for (const runId of runIds) {
      store.observe(runId, { type: "process_started", at: 1 });
      for (let index = 0; index < MAX_RUN_TRANSCRIPT_ITEMS + 20; index++) {
        store.observe(runId, {
          type: "assistant_final",
          text: `${index}:${"界".repeat(2_000)}`,
          at: 2,
        });
      }
      store.finishRun(runId, {
        status: "succeeded",
        reason: "completed",
      });
    }

    const live = store.getInvocation(invocationId)!;
    expect(
      live.runs.every(
        (run) =>
          run.transcript.length <= MAX_RUN_TRANSCRIPT_ITEMS &&
          run.transcriptBytes <= MAX_RUN_TRANSCRIPT_BYTES,
      ),
    ).toBe(true);
    const persisted = store.toPersisted(invocationId)!;
    expect(
      Buffer.byteLength(JSON.stringify(persisted), "utf8"),
    ).toBeLessThanOrEqual(MAX_PERSISTED_INVOCATION_BYTES);
    expect(persisted.runs).toHaveLength(64);
    expect(
      persisted.runs.every((run) =>
        run.transcript.some((item) => item.type === "truncated"),
      ),
    ).toBe(true);
  });

  test("enforces the serialized per-run byte cap during persistence", () => {
    const store = registry();
    const { invocationId, runIds } = begin(store, 1);
    const runId = runIds[0]!;
    store.observe(runId, { type: "process_started", at: 1 });
    for (let index = 0; index < 400; index++) {
      store.observe(runId, {
        type: "assistant_final",
        text: `${index}:${"x".repeat(234)}`,
        at: 2,
      });
    }
    store.finishRun(runId, {
      status: "succeeded",
      reason: "completed",
    });

    const liveTranscript =
      store.getInvocation(invocationId)!.runs[0]!.transcript;
    expect(
      Buffer.byteLength(JSON.stringify(liveTranscript), "utf8"),
    ).toBeGreaterThan(MAX_RUN_TRANSCRIPT_BYTES);

    const persistedRun = store.toPersisted(invocationId)!.runs[0]!;
    expect(
      Buffer.byteLength(JSON.stringify(persistedRun), "utf8"),
    ).toBeLessThanOrEqual(MAX_RUN_TRANSCRIPT_BYTES);
    expect(
      persistedRun.transcript.some((item) => item.type === "truncated"),
    ).toBe(true);
  });

  test("retains the newest completed histories and never prunes active work", () => {
    const store = registry();
    const active = begin(store, 1, "active");
    const completed: Array<{
      invocationId: string;
      payload: PersistedChildRunsV1;
    }> = [];

    for (let index = 0; index < MAX_REPLAY_INVOCATIONS; index++) {
      const toolCallId = `completed-${index}`;
      const invocation = begin(store, 1, toolCallId);
      store.finishRun(invocation.runIds[0]!, {
        status: "succeeded",
        reason: "completed",
      });
      completed.push({
        invocationId: invocation.invocationId,
        payload: store.completeToolCall(toolCallId)!,
      });
    }

    expect(
      store.getSnapshots().map(({ invocationId }) => invocationId),
    ).toEqual([
      active.invocationId,
      ...completed.map(({ invocationId }) => invocationId),
    ]);

    store.finishRun(active.runIds[0]!, {
      status: "succeeded",
      reason: "completed",
    });
    let notifications = 0;
    let publishedIds: string[] = [];
    store.subscribe(() => {
      notifications += 1;
      publishedIds = store
        .getSnapshots()
        .map(({ invocationId }) => invocationId);
    });
    const activePayload = store.completeToolCall("active")!;
    const expectedIds = [
      ...completed.slice(1).map(({ invocationId }) => invocationId),
      active.invocationId,
    ];

    expect(notifications).toBe(1);
    expect(publishedIds).toEqual(expectedIds);
    expect(
      store.getSnapshots().map(({ invocationId }) => invocationId),
    ).toEqual(expectedIds);

    const replay = registry();
    replay.replacePersistedHistory([
      ...completed.slice(1).map(({ payload }) => payload),
      activePayload,
    ]);
    expect(
      replay.getSnapshots().map(({ invocationId }) => invocationId),
    ).toEqual(expectedIds);
  });

  test("compacts oversized live data and enforces the completed byte cap", () => {
    const store = registry();
    const completed: Array<{
      invocationId: string;
      payload: PersistedChildRunsV1;
      bytes: number;
    }> = [];

    for (let invocationIndex = 0; invocationIndex < 6; invocationIndex++) {
      const toolCallId = `large-${invocationIndex}`;
      const invocation = begin(store, 64, toolCallId);
      for (const runId of invocation.runIds) {
        store.observe(runId, { type: "process_started", at: 1 });
        store.observe(runId, {
          type: "assistant_final",
          text: "x".repeat(6_000),
          at: 2,
        });
        store.finishRun(runId, {
          status: "succeeded",
          reason: "completed",
        });
      }
      const payload = store.completeToolCall(toolCallId)!;
      expect(
        payload.runs.every((run) =>
          run.transcript.some((item) => item.type === "assistant"),
        ),
      ).toBe(true);
      completed.push({
        invocationId: invocation.invocationId,
        payload,
        bytes: serializedBytes(payload),
      });
    }

    expect(completed).toHaveLength(6);
    expect(
      completed.reduce((total, item) => total + item.bytes, 0),
    ).toBeGreaterThan(MAX_REPLAY_BYTES);
    expect(completed.length).toBeLessThan(MAX_REPLAY_INVOCATIONS);
    let retainedBytes = 0;
    const expected: string[] = [];
    for (const item of [...completed].reverse()) {
      if (retainedBytes + item.bytes > MAX_REPLAY_BYTES) break;
      expected.unshift(item.invocationId);
      retainedBytes += item.bytes;
    }
    expect(
      store.getSnapshots().map(({ invocationId }) => invocationId),
    ).toEqual(expected);

    const oversized = registry();
    const invocation = begin(oversized, 64, "single-oversized");
    for (const runId of invocation.runIds) {
      oversized.observe(runId, { type: "process_started", at: 1 });
      for (let item = 0; item < 5; item++) {
        oversized.observe(runId, {
          type: "assistant_final",
          text: "界".repeat(6_000),
          at: 2,
        });
      }
      oversized.finishRun(runId, {
        status: "succeeded",
        reason: "completed",
      });
    }
    const beforeBytes = serializedBytes(
      oversized.getInvocation(invocation.invocationId),
    );
    expect(beforeBytes).toBeGreaterThan(MAX_REPLAY_BYTES);
    const compacted = oversized.completeToolCall("single-oversized")!;
    expect(serializedBytes(compacted)).toBeLessThanOrEqual(
      MAX_PERSISTED_INVOCATION_BYTES,
    );
    expect(
      oversized.getSnapshots().map(({ invocationId }) => invocationId),
    ).toEqual([invocation.invocationId]);
    expect(
      serializedBytes(oversized.getInvocation(invocation.invocationId)),
    ).toBeLessThan(beforeBytes);
  });

  test("rejects replay identities that collide with active or accepted history", () => {
    const store = registry();
    const active = begin(store, 1, "active");
    const accepted = persistedHistory("history-1", "history-run-1");

    store.replacePersistedHistory([
      persistedHistory(active.invocationId, "other-run"),
      persistedHistory("active-run-collision", active.runIds[0]!),
      accepted,
      persistedHistory("history-1", "history-run-2"),
      persistedHistory("history-2", "history-run-1"),
    ]);

    expect(
      store.getSnapshots().map(({ invocationId }) => invocationId),
    ).toEqual([active.invocationId, accepted.invocationId]);
    expect(store.getRunStatus(active.runIds[0]!)).toBe("queued");
    expect(store.getRunStatus("history-run-1")).toBe("succeeded");
    expect(store.getRunStatus("history-run-2")).toBeUndefined();
  });

  test("exposes compact summaries without transcript text", () => {
    const store = registry();
    const { invocationId, runIds } = begin(store, 1);
    store.observe(runIds[0]!, { type: "process_started", at: 1 });
    store.observe(runIds[0]!, {
      type: "assistant_draft",
      text: "SECRET_DRAFT",
    });
    const details = store.getUpdateDetails(invocationId)!;
    expect(details.childRuns.runs[0]?.status).toBe("running");
    expect(JSON.stringify(details)).not.toContain("SECRET_DRAFT");
  });
});
