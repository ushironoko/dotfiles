import { capUtf8, stripTerminalControls } from "../../lib/terminal-text";
import { CHILD_RUN_COMPLETION_ENTRY } from "./background";
import {
  CHILD_RUNS_SCHEMA,
  CHILD_RUNS_VERSION,
  MAX_ASSISTANT_ITEM_BYTES,
  MAX_PERSISTED_INVOCATION_BYTES,
  MAX_REPLAY_BYTES,
  MAX_REPLAY_INVOCATIONS,
  MAX_RUN_TRANSCRIPT_BYTES,
  MAX_RUN_TRANSCRIPT_ITEMS,
  type ChildRunMode,
  type ChildRunSource,
  type ChildRunStatus,
  type ChildRunTerminalReason,
  type PersistedChildRunsV1,
  type PersistedChildRunV1,
  type ToolTranscriptStatus,
  type TranscriptItem,
} from "./model";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const byteLength = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const finiteInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const finiteTimestamp = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const optionalText = (
  value: unknown,
  maxBytes: number,
  lineFeedReplacement: string = "\n",
): string | undefined =>
  typeof value === "string"
    ? capUtf8(stripTerminalControls(value, lineFeedReplacement), maxBytes)
    : undefined;

const terminalStatuses: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "aborted",
  "skipped",
]);
const terminalReasons: ReadonlySet<string> = new Set([
  "completed",
  "model-error",
  "model-aborted",
  "permission-blocked",
  "length",
  "spawn-error",
  "setup-error",
  "fail-fast",
  "parent-abort",
  "branch-change",
  "shutdown",
  "dependency-failed",
]);
const toolStatuses: ReadonlySet<string> = new Set([
  "running",
  "succeeded",
  "failed",
  "interrupted",
]);

const decodeTranscriptItem = (value: unknown): TranscriptItem | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.type === "assistant") {
    const text = optionalText(value.text, MAX_ASSISTANT_ITEM_BYTES);
    return text === undefined ? undefined : { type: "assistant", text };
  }
  if (value.type === "tool") {
    const localId = finiteInteger(value.localId);
    const name = optionalText(value.name, 256, " ");
    if (
      localId === undefined ||
      localId < 1 ||
      name === undefined ||
      typeof value.status !== "string" ||
      !toolStatuses.has(value.status)
    ) {
      return undefined;
    }
    return {
      type: "tool",
      localId,
      name,
      status: value.status as ToolTranscriptStatus,
    };
  }
  if (value.type === "truncated") {
    const omittedItems = finiteInteger(value.omittedItems);
    const omittedBytes = finiteInteger(value.omittedBytes);
    if (omittedItems === undefined || omittedBytes === undefined) {
      return undefined;
    }
    return { type: "truncated", omittedItems, omittedBytes };
  }
  return undefined;
};

const decodeRun = (
  value: unknown,
  perRunBudget: number,
): PersistedChildRunV1 | undefined => {
  if (!isRecord(value)) return undefined;
  const runId = optionalText(value.runId, 256, " ");
  const agent = optionalText(value.agent, 256, " ");
  const task = optionalText(value.task, 4 * 1024);
  const taskIndex = finiteInteger(value.taskIndex);
  if (
    runId === undefined ||
    agent === undefined ||
    task === undefined ||
    taskIndex === undefined ||
    typeof value.status !== "string" ||
    !terminalStatuses.has(value.status)
  ) {
    return undefined;
  }
  const stageIndex =
    value.stageIndex === undefined
      ? undefined
      : finiteInteger(value.stageIndex);
  if (value.stageIndex !== undefined && stageIndex === undefined)
    return undefined;
  const stageName = optionalText(value.stageName, 512, " ");
  const worktree = optionalText(value.worktree, 4 * 1024, " ");
  const reason =
    typeof value.terminalReason === "string" &&
    terminalReasons.has(value.terminalReason)
      ? (value.terminalReason as ChildRunTerminalReason)
      : undefined;
  const run: PersistedChildRunV1 = {
    runId,
    agent,
    task,
    taskIndex,
    stageIndex,
    stageName,
    worktree,
    status: value.status as Exclude<ChildRunStatus, "queued" | "running">,
    terminalReason: reason,
    startedAt: finiteTimestamp(value.startedAt),
    endedAt: finiteTimestamp(value.endedAt),
    transcript: [],
  };
  if (!Array.isArray(value.transcript)) return run;
  let dropped = 0;
  let droppedBytes = 0;
  for (const rawItem of value.transcript.slice(0, MAX_RUN_TRANSCRIPT_ITEMS)) {
    const item = decodeTranscriptItem(rawItem);
    if (item === undefined) continue;
    run.transcript.push(item);
    if (byteLength(run) > perRunBudget) {
      run.transcript.pop();
      dropped += 1;
      droppedBytes += byteLength(item);
    }
  }
  dropped += Math.max(0, value.transcript.length - MAX_RUN_TRANSCRIPT_ITEMS);
  if (dropped > 0) {
    while (run.transcript.length >= MAX_RUN_TRANSCRIPT_ITEMS) {
      const removed = run.transcript.pop();
      if (removed === undefined) break;
      dropped += 1;
      droppedBytes += byteLength(removed);
    }
    run.transcript.push({
      type: "truncated",
      omittedItems: dropped,
      omittedBytes: droppedBytes,
    });
    while (byteLength(run) > perRunBudget && run.transcript.length > 1) {
      const [removed] = run.transcript.splice(-2, 1);
      const marker = run.transcript.at(-1);
      if (removed === undefined || marker?.type !== "truncated") break;
      marker.omittedItems += 1;
      marker.omittedBytes += byteLength(removed);
    }
  }
  return run;
};

export const decodePersistedChildRuns = (
  value: unknown,
): PersistedChildRunsV1 | undefined => {
  if (
    !isRecord(value) ||
    value.schema !== CHILD_RUNS_SCHEMA ||
    value.version !== CHILD_RUNS_VERSION ||
    value.kind !== "transcript" ||
    (value.source !== "subagent" && value.source !== "workflow") ||
    !Array.isArray(value.runs) ||
    value.runs.length > 64
  ) {
    return undefined;
  }
  const invocationId = optionalText(value.invocationId, 256, " ");
  const label = optionalText(value.label, 512, " ");
  const createdAt = finiteTimestamp(value.createdAt);
  if (
    invocationId === undefined ||
    label === undefined ||
    createdAt === undefined
  ) {
    return undefined;
  }
  const mode: ChildRunMode | undefined =
    value.mode === "single" ||
    value.mode === "parallel" ||
    value.mode === "chain"
      ? value.mode
      : undefined;
  const perRunBudget = Math.max(
    1024,
    Math.floor(
      (MAX_PERSISTED_INVOCATION_BYTES - 4096) / Math.max(1, value.runs.length),
    ),
  );
  const runs = value.runs.flatMap((rawRun) => {
    const run = decodeRun(
      rawRun,
      Math.min(perRunBudget, MAX_RUN_TRANSCRIPT_BYTES),
    );
    return run === undefined ? [] : [run];
  });
  if (runs.length !== value.runs.length) return undefined;
  const decoded: PersistedChildRunsV1 = {
    schema: CHILD_RUNS_SCHEMA,
    version: CHILD_RUNS_VERSION,
    kind: "transcript",
    invocationId,
    source: value.source as ChildRunSource,
    mode,
    label,
    createdAt,
    runs,
  };
  return byteLength(decoded) <= MAX_PERSISTED_INVOCATION_BYTES
    ? decoded
    : undefined;
};

/** Read only finalized child-run payloads on the active session branch. */
export const extractPersistedChildRuns = (
  entries: readonly unknown[],
): PersistedChildRunsV1[] => {
  const byId = new Map<string, PersistedChildRunsV1>();
  const order: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    let candidate: unknown;
    if (entry.type === "message") {
      const message = isRecord(entry.message) ? entry.message : undefined;
      if (message?.role !== "toolResult") continue;
      const details = isRecord(message.details) ? message.details : undefined;
      candidate = details?.childRuns;
    } else if (
      entry.type === "custom" &&
      entry.customType === CHILD_RUN_COMPLETION_ENTRY
    ) {
      const data = isRecord(entry.data) ? entry.data : undefined;
      candidate = data?.childRuns;
    } else {
      continue;
    }
    const decoded = decodePersistedChildRuns(candidate);
    if (decoded === undefined) continue;
    if (!byId.has(decoded.invocationId)) order.push(decoded.invocationId);
    byId.set(decoded.invocationId, decoded);
  }

  const selected: PersistedChildRunsV1[] = [];
  let bytes = 0;
  for (const invocationId of order.slice(-MAX_REPLAY_INVOCATIONS).reverse()) {
    const payload = byId.get(invocationId);
    if (payload === undefined) continue;
    const nextBytes = byteLength(payload);
    if (bytes + nextBytes > MAX_REPLAY_BYTES) break;
    selected.push(payload);
    bytes += nextBytes;
  }
  return selected.reverse();
};

export const attachChildRunsDetails = (
  currentDetails: unknown,
  childRuns: PersistedChildRunsV1,
): Record<string, unknown> => ({
  ...(isRecord(currentDetails) ? currentDetails : {}),
  childRuns,
});
