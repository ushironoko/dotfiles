import { describe, expect, test } from "bun:test";
import {
  MAX_PERSISTED_INVOCATION_BYTES,
  MAX_RUN_TRANSCRIPT_BYTES,
  MAX_RUN_TRANSCRIPT_ITEMS,
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

const begin = (store: ChildRunRegistry, count = 2) =>
  store.beginInvocation({
    toolCallId: "parent-tool-call",
    source: "subagent",
    mode: "parallel",
    label: "parallel",
    runs: Array.from({ length: count }, (_, index) => ({
      agent: `agent-${index + 1}`,
      task: `task-${index + 1}`,
      taskIndex: index,
    })),
  });

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
