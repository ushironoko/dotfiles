import { randomUUID } from "node:crypto";
import { capUtf8, stripTerminalControls } from "../../lib/terminal-text";
import {
  CHILD_RUNS_SCHEMA,
  CHILD_RUNS_VERSION,
  MAX_ASSISTANT_ITEM_BYTES,
  MAX_LIVE_DRAFT_BYTES,
  MAX_PERSISTED_INVOCATION_BYTES,
  MAX_RUN_TRANSCRIPT_BYTES,
  MAX_RUN_TRANSCRIPT_ITEMS,
  type ChildInvocationSnapshot,
  type ChildInvocationSpec,
  type ChildObservation,
  type ChildRunRenderSummary,
  type ChildRunStatus,
  type ChildRunTerminalReason,
  type ChildRunUpdateDetails,
  type LiveChildRun,
  type PersistedChildRunsV1,
  type PersistedChildRunV1,
  type TranscriptItem,
  isTerminalStatus,
} from "./model";

interface RegistryOptions {
  now?: () => number;
  idFactory?: () => string;
}

interface FinishRunOptions {
  status: Exclude<ChildRunStatus, "queued" | "running">;
  reason: ChildRunTerminalReason;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string;
  stopReason?: string;
  model?: string;
}

interface InternalInvocation extends ChildInvocationSnapshot {
  toolCallId?: string;
}

const byteLength = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const cloneTranscript = (items: readonly TranscriptItem[]): TranscriptItem[] =>
  items.map((item) => ({ ...item }));

const cloneRun = (run: LiveChildRun): LiveChildRun => ({
  ...run,
  transcript: cloneTranscript(run.transcript),
});

const cloneInvocation = (
  invocation: InternalInvocation,
): ChildInvocationSnapshot => ({
  invocationId: invocation.invocationId,
  toolCallId: invocation.toolCallId,
  source: invocation.source,
  mode: invocation.mode,
  label: invocation.label,
  createdAt: invocation.createdAt,
  runs: invocation.runs.map(cloneRun),
});

const taskPreview = (task: string): string => {
  const oneLine = stripTerminalControls(task, " ").replace(/\s+/g, " ").trim();
  return capUtf8(oneLine, 240);
};

const persistedTask = (task: string): string =>
  capUtf8(stripTerminalControls(task), 4 * 1024);

const persistedAgent = (agent: string): string =>
  capUtf8(stripTerminalControls(agent, " "), 256);

const persistedLabel = (label: string): string =>
  capUtf8(stripTerminalControls(label, " "), 512);

export class ChildRunRegistry {
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly invocations = new Map<string, InternalInvocation>();
  private readonly invocationOrder: string[] = [];
  private readonly runToInvocation = new Map<string, string>();
  private readonly toolCallToInvocation = new Map<string, string>();
  private readonly subscribers = new Set<() => void>();
  private disposed = false;

  constructor(options: RegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  beginInvocation(spec: ChildInvocationSpec): {
    invocationId: string;
    runIds: string[];
  } {
    if (this.disposed) throw new Error("Child-run registry is disposed");
    const invocationId = this.idFactory();
    const createdAt = this.now();
    const runs = spec.runs.map<LiveChildRun>((runSpec) => {
      const runId = this.idFactory();
      this.runToInvocation.set(runId, invocationId);
      return {
        ...runSpec,
        agent: capUtf8(stripTerminalControls(runSpec.agent, " "), 256),
        task: capUtf8(stripTerminalControls(runSpec.task), 16 * 1024),
        invocationId,
        runId,
        source: spec.source,
        mode: spec.mode,
        status: "queued",
        protocolWarnings: 0,
        transcript: [],
        transcriptBytes: 0,
        omittedItems: 0,
        omittedBytes: 0,
      };
    });
    const invocation: InternalInvocation = {
      invocationId,
      toolCallId: spec.toolCallId,
      source: spec.source,
      mode: spec.mode,
      label: persistedLabel(spec.label),
      createdAt,
      runs,
    };
    this.invocations.set(invocationId, invocation);
    this.invocationOrder.push(invocationId);
    this.toolCallToInvocation.set(spec.toolCallId, invocationId);
    this.publish();
    return { invocationId, runIds: runs.map((run) => run.runId) };
  }

  observe(runId: string, observation: ChildObservation): void {
    const run = this.findRun(runId);
    if (run === undefined || isTerminalStatus(run.status)) return;

    switch (observation.type) {
      case "process_started":
        if (run.status === "queued") {
          run.status = "running";
          run.startedAt = observation.at;
        }
        break;
      case "assistant_draft":
        run.liveDraft = capUtf8(observation.text, MAX_LIVE_DRAFT_BYTES);
        break;
      case "assistant_final":
        run.liveDraft = undefined;
        run.model = observation.model;
        run.stopReason = observation.stopReason;
        this.appendTranscript(run, {
          type: "assistant",
          text: capUtf8(observation.text, MAX_ASSISTANT_ITEM_BYTES),
        });
        break;
      case "tool_started":
        this.appendTranscript(run, {
          type: "tool",
          localId: observation.localId,
          name: observation.name,
          status: "running",
        });
        break;
      case "tool_finished": {
        const existingIndex = run.transcript.findIndex(
          (item) =>
            item.type === "tool" && item.localId === observation.localId,
        );
        const existing = run.transcript[existingIndex];
        if (existing?.type === "tool") {
          const previousBytes = byteLength(existing);
          existing.status = observation.failed ? "failed" : "succeeded";
          existing.name = observation.name;
          run.transcriptBytes += byteLength(existing) - previousBytes;
          if (run.transcriptBytes > MAX_RUN_TRANSCRIPT_BYTES) {
            const [removed] = run.transcript.splice(existingIndex, 1);
            if (removed !== undefined) {
              const removedBytes = byteLength(removed);
              run.transcriptBytes -= removedBytes;
              run.omittedItems += 1;
              run.omittedBytes += removedBytes;
              this.finalizeTruncation(run);
            }
          }
        } else {
          this.appendTranscript(run, {
            type: "tool",
            localId: observation.localId,
            name: observation.name,
            status: observation.failed ? "failed" : "succeeded",
          });
        }
        break;
      }
      case "protocol_warning":
        run.protocolWarnings += 1;
        break;
      case "process_exit":
        run.exitCode = observation.exitCode;
        run.signal = observation.signal;
        run.endedAt = observation.at;
        break;
    }
    this.publish();
  }

  finishRun(runId: string, options: FinishRunOptions): void {
    const run = this.findRun(runId);
    if (run === undefined || isTerminalStatus(run.status)) return;
    if (run.status === "running" && options.status === "skipped") return;
    run.status = options.status;
    run.terminalReason = options.reason;
    run.endedAt = options.endedAt ?? run.endedAt ?? this.now();
    run.exitCode = options.exitCode ?? run.exitCode;
    run.signal = options.signal ?? run.signal;
    run.stopReason = options.stopReason ?? run.stopReason;
    run.model = options.model ?? run.model;
    run.liveDraft = undefined;
    this.interruptOpenTools(run);
    this.finalizeTruncation(run);
    this.publish();
  }

  terminalizeInvocation(
    invocationId: string,
    queued: Pick<FinishRunOptions, "status" | "reason">,
    running: Pick<FinishRunOptions, "status" | "reason">,
  ): void {
    const invocation = this.invocations.get(invocationId);
    if (invocation === undefined) return;
    for (const run of invocation.runs) {
      if (run.status === "queued") this.finishRun(run.runId, queued);
      else if (run.status === "running") this.finishRun(run.runId, running);
    }
  }

  getInvocationIdForToolCall(toolCallId: string): string | undefined {
    return this.toolCallToInvocation.get(toolCallId);
  }

  getRunIds(invocationId: string): string[] {
    return (
      this.invocations.get(invocationId)?.runs.map((run) => run.runId) ?? []
    );
  }

  getRunStatus(runId: string): ChildRunStatus | undefined {
    return this.findRun(runId)?.status;
  }

  getSnapshots(): ChildInvocationSnapshot[] {
    return this.invocationOrder.flatMap((id) => {
      const invocation = this.invocations.get(id);
      return invocation === undefined ? [] : [cloneInvocation(invocation)];
    });
  }

  getInvocation(invocationId: string): ChildInvocationSnapshot | undefined {
    const invocation = this.invocations.get(invocationId);
    return invocation === undefined ? undefined : cloneInvocation(invocation);
  }

  getUpdateDetails(invocationId: string): ChildRunUpdateDetails | undefined {
    const invocation = this.invocations.get(invocationId);
    if (invocation === undefined) return undefined;
    return {
      childRuns: {
        schema: CHILD_RUNS_SCHEMA,
        version: CHILD_RUNS_VERSION,
        kind: "summary",
        invocationId,
        source: invocation.source,
        mode: invocation.mode,
        label: invocation.label,
        runs: invocation.runs.map<ChildRunRenderSummary>((run) => ({
          runId: run.runId,
          agent: run.agent,
          taskPreview: taskPreview(run.task),
          taskIndex: run.taskIndex,
          stageIndex: run.stageIndex,
          stageName: run.stageName,
          status: run.status,
          terminalReason: run.terminalReason,
        })),
      },
    };
  }

  toPersisted(invocationId: string): PersistedChildRunsV1 | undefined {
    const invocation = this.invocations.get(invocationId);
    if (invocation === undefined) return undefined;
    const perRunBudget = Math.max(
      1024,
      Math.floor(
        (MAX_PERSISTED_INVOCATION_BYTES - 4096) /
          Math.max(1, invocation.runs.length),
      ),
    );
    const runs = invocation.runs.map((run) =>
      this.persistRun(run, perRunBudget),
    );
    const payload: PersistedChildRunsV1 = {
      schema: CHILD_RUNS_SCHEMA,
      version: CHILD_RUNS_VERSION,
      kind: "transcript",
      invocationId: invocation.invocationId,
      source: invocation.source,
      mode: invocation.mode,
      label: persistedLabel(invocation.label),
      createdAt: invocation.createdAt,
      runs,
    };

    // Metadata itself can exceed the fair estimate with many long tasks.
    // Tighten task text from the end until the hard serialized cap is met.
    while (byteLength(payload) > MAX_PERSISTED_INVOCATION_BYTES) {
      const candidate = [...payload.runs]
        .reverse()
        .find((run) => Buffer.byteLength(run.task, "utf8") > 64);
      if (candidate === undefined) break;
      candidate.task = capUtf8(
        candidate.task,
        Math.max(64, Math.floor(Buffer.byteLength(candidate.task, "utf8") / 2)),
      );
    }
    return payload;
  }

  completeToolCall(toolCallId: string): PersistedChildRunsV1 | undefined {
    const invocationId = this.toolCallToInvocation.get(toolCallId);
    if (invocationId === undefined) return undefined;
    const payload = this.toPersisted(invocationId);
    this.toolCallToInvocation.delete(toolCallId);
    const invocation = this.invocations.get(invocationId);
    if (invocation !== undefined) invocation.toolCallId = undefined;
    return payload;
  }

  replacePersistedHistory(payloads: readonly PersistedChildRunsV1[]): void {
    const historicalIds = this.invocationOrder.filter(
      (invocationId) =>
        this.invocations.get(invocationId)?.toolCallId === undefined,
    );
    for (const invocationId of historicalIds) {
      const invocation = this.invocations.get(invocationId);
      this.invocations.delete(invocationId);
      for (const run of invocation?.runs ?? []) {
        this.runToInvocation.delete(run.runId);
      }
      const index = this.invocationOrder.indexOf(invocationId);
      if (index !== -1) this.invocationOrder.splice(index, 1);
    }

    for (const payload of payloads) {
      const runs = payload.runs.map<LiveChildRun>((run) => ({
        ...run,
        invocationId: payload.invocationId,
        source: payload.source,
        mode: payload.mode,
        protocolWarnings: 0,
        transcript: cloneTranscript(run.transcript),
        transcriptBytes: byteLength(run.transcript),
        omittedItems: 0,
        omittedBytes: 0,
      }));
      const invocation: InternalInvocation = {
        invocationId: payload.invocationId,
        source: payload.source,
        mode: payload.mode,
        label: payload.label,
        createdAt: payload.createdAt,
        runs,
      };
      this.invocations.set(payload.invocationId, invocation);
      this.invocationOrder.push(payload.invocationId);
      for (const run of runs)
        this.runToInvocation.set(run.runId, payload.invocationId);
    }
    this.publish();
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    for (const invocationId of this.invocationOrder) {
      this.terminalizeInvocation(
        invocationId,
        { status: "aborted", reason: "shutdown" },
        { status: "aborted", reason: "shutdown" },
      );
    }
    this.disposed = true;
    this.subscribers.clear();
    this.toolCallToInvocation.clear();
  }

  private findRun(runId: string): LiveChildRun | undefined {
    const invocationId = this.runToInvocation.get(runId);
    return invocationId === undefined
      ? undefined
      : this.invocations
          .get(invocationId)
          ?.runs.find((run) => run.runId === runId);
  }

  private appendTranscript(run: LiveChildRun, item: TranscriptItem): void {
    const bytes = byteLength(item);
    if (
      run.transcript.length >= MAX_RUN_TRANSCRIPT_ITEMS ||
      run.transcriptBytes + bytes > MAX_RUN_TRANSCRIPT_BYTES
    ) {
      run.omittedItems += 1;
      run.omittedBytes += bytes;
      this.finalizeTruncation(run);
      return;
    }
    run.transcript.push(item);
    run.transcriptBytes += bytes;
  }

  private interruptOpenTools(run: LiveChildRun): void {
    for (const item of run.transcript) {
      if (item.type === "tool" && item.status === "running") {
        item.status = "interrupted";
      }
    }
    run.transcriptBytes = run.transcript.reduce(
      (total, item) => total + byteLength(item),
      0,
    );
    while (run.transcriptBytes > MAX_RUN_TRANSCRIPT_BYTES) {
      let index = run.transcript.length - 1;
      while (index >= 0 && run.transcript[index]?.type === "truncated") {
        index -= 1;
      }
      if (index === -1) break;
      const [removed] = run.transcript.splice(index, 1);
      if (removed === undefined) break;
      const removedBytes = byteLength(removed);
      run.transcriptBytes -= removedBytes;
      run.omittedItems += 1;
      run.omittedBytes += removedBytes;
    }
  }

  private finalizeTruncation(run: LiveChildRun): void {
    if (run.omittedItems === 0) return;
    const marker = run.transcript.find(
      (item): item is Extract<TranscriptItem, { type: "truncated" }> =>
        item.type === "truncated",
    );
    if (marker !== undefined) {
      marker.omittedItems = run.omittedItems;
      marker.omittedBytes = run.omittedBytes;
      return;
    }
    const item: TranscriptItem = {
      type: "truncated",
      omittedItems: run.omittedItems,
      omittedBytes: run.omittedBytes,
    };
    while (
      run.transcript.length >= MAX_RUN_TRANSCRIPT_ITEMS ||
      run.transcriptBytes + byteLength(item) > MAX_RUN_TRANSCRIPT_BYTES
    ) {
      const removed = run.transcript.pop();
      if (removed === undefined) break;
      run.transcriptBytes -= byteLength(removed);
      run.omittedItems += 1;
      run.omittedBytes += byteLength(removed);
      item.omittedItems = run.omittedItems;
      item.omittedBytes = run.omittedBytes;
    }
    run.transcript.push(item);
    run.transcriptBytes += byteLength(item);
  }

  private persistRun(run: LiveChildRun, budget: number): PersistedChildRunV1 {
    const status = isTerminalStatus(run.status) ? run.status : "aborted";
    const persisted: PersistedChildRunV1 = {
      runId: run.runId,
      agent: persistedAgent(run.agent),
      task: persistedTask(run.task),
      taskIndex: run.taskIndex,
      stageIndex: run.stageIndex,
      stageName:
        run.stageName === undefined ? undefined : persistedLabel(run.stageName),
      status,
      terminalReason:
        run.terminalReason ?? (status === "aborted" ? "shutdown" : undefined),
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      transcript: [],
    };
    let omittedItems = 0;
    let omittedBytes = 0;
    for (const item of run.transcript) {
      const safeItem: TranscriptItem =
        item.type === "assistant"
          ? {
              type: "assistant",
              text: capUtf8(
                stripTerminalControls(item.text),
                MAX_ASSISTANT_ITEM_BYTES,
              ),
            }
          : item.type === "tool"
            ? {
                type: "tool",
                localId: item.localId,
                name: persistedAgent(item.name),
                status: item.status,
              }
            : { ...item };
      persisted.transcript.push(safeItem);
      if (byteLength(persisted) > budget) {
        persisted.transcript.pop();
        omittedItems += 1;
        omittedBytes += byteLength(safeItem);
      }
    }
    if (omittedItems > 0) {
      persisted.transcript.push({
        type: "truncated",
        omittedItems,
        omittedBytes,
      });
      while (
        byteLength(persisted) > budget &&
        persisted.transcript.length > 1
      ) {
        const removed = persisted.transcript.splice(
          persisted.transcript.length - 2,
          1,
        )[0];
        if (removed === undefined) break;
        const marker = persisted.transcript.at(-1);
        if (marker?.type === "truncated") {
          marker.omittedItems += 1;
          marker.omittedBytes += byteLength(removed);
        }
      }
    }
    return persisted;
  }

  private publish(): void {
    if (this.disposed) return;
    for (const subscriber of this.subscribers) {
      try {
        subscriber();
      } catch {
        // One renderer must not prevent state from reaching others.
      }
    }
  }
}

export type { FinishRunOptions };
