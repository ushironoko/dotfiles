export const CHILD_RUNS_SCHEMA = "pi-harness/child-runs";
export const CHILD_RUNS_VERSION = 1;

export const MAX_ASSISTANT_ITEM_BYTES = 16 * 1024;
export const MAX_LIVE_DRAFT_BYTES = 16 * 1024;
export const MAX_RUN_TRANSCRIPT_BYTES = 64 * 1024;
export const MAX_RUN_TRANSCRIPT_ITEMS = 256;
export const MAX_PERSISTED_INVOCATION_BYTES = 512 * 1024;
export const MAX_REPLAY_INVOCATIONS = 32;
export const MAX_REPLAY_BYTES = 2 * 1024 * 1024;
export const MAX_LIVE_INVOCATIONS = MAX_REPLAY_INVOCATIONS;
export const MAX_LIVE_HISTORY_BYTES = MAX_REPLAY_BYTES;

export type ChildRunSource = "subagent" | "workflow";
export type ChildRunMode = "single" | "parallel" | "chain";
export type ChildRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "aborted"
  | "skipped";

export type ChildRunTerminalReason =
  | "completed"
  | "model-error"
  | "model-aborted"
  | "permission-blocked"
  | "length"
  | "spawn-error"
  | "setup-error"
  | "fail-fast"
  | "parent-abort"
  | "branch-change"
  | "shutdown"
  | "dependency-failed";

export type ToolTranscriptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted";

export type TranscriptItem =
  | { type: "assistant"; text: string }
  | {
      type: "tool";
      localId: number;
      name: string;
      status: ToolTranscriptStatus;
    }
  | {
      type: "truncated";
      omittedItems: number;
      omittedBytes: number;
    };

export type ChildObservation =
  | { type: "process_started"; at: number }
  | { type: "assistant_draft"; text: string }
  | {
      type: "assistant_final";
      text: string;
      at: number;
      model?: string;
      stopReason?: string;
    }
  | {
      type: "tool_started";
      localId: number;
      name: string;
      at: number;
    }
  | {
      type: "tool_finished";
      localId: number;
      name: string;
      failed: boolean;
      at: number;
    }
  | { type: "protocol_warning"; code: "malformed" | "oversized" }
  | {
      type: "process_exit";
      at: number;
      exitCode: number | null;
      signal?: string;
    };

export interface ChildRunSpec {
  agent: string;
  task: string;
  taskIndex: number;
  stageIndex?: number;
  stageName?: string;
  worktree?: string;
}

export interface ChildInvocationSpec {
  toolCallId: string;
  source: ChildRunSource;
  mode?: ChildRunMode;
  label: string;
  runs: ChildRunSpec[];
}

export interface LiveChildRun extends ChildRunSpec {
  invocationId: string;
  runId: string;
  source: ChildRunSource;
  mode?: ChildRunMode;
  status: ChildRunStatus;
  terminalReason?: ChildRunTerminalReason;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string;
  model?: string;
  stopReason?: string;
  liveDraft?: string;
  protocolWarnings: number;
  transcript: TranscriptItem[];
  transcriptBytes: number;
  omittedItems: number;
  omittedBytes: number;
}

export interface ChildInvocationSnapshot {
  invocationId: string;
  toolCallId?: string;
  source: ChildRunSource;
  mode?: ChildRunMode;
  label: string;
  createdAt: number;
  runs: LiveChildRun[];
}

export interface ChildRunRenderSummary {
  runId: string;
  agent: string;
  taskPreview: string;
  taskIndex: number;
  stageIndex?: number;
  stageName?: string;
  status: ChildRunStatus;
  terminalReason?: ChildRunTerminalReason;
}

export interface ChildRunUpdateDetails {
  childRuns: {
    schema: typeof CHILD_RUNS_SCHEMA;
    version: typeof CHILD_RUNS_VERSION;
    kind: "summary";
    invocationId: string;
    source: ChildRunSource;
    mode?: ChildRunMode;
    label: string;
    runs: ChildRunRenderSummary[];
  };
}

export interface PersistedChildRunV1 {
  runId: string;
  agent: string;
  task: string;
  taskIndex: number;
  stageIndex?: number;
  stageName?: string;
  worktree?: string;
  status: Exclude<ChildRunStatus, "queued" | "running">;
  terminalReason?: ChildRunTerminalReason;
  startedAt?: number;
  endedAt?: number;
  transcript: TranscriptItem[];
}

export interface PersistedChildRunsV1 {
  schema: typeof CHILD_RUNS_SCHEMA;
  version: typeof CHILD_RUNS_VERSION;
  kind: "transcript";
  invocationId: string;
  source: ChildRunSource;
  mode?: ChildRunMode;
  label: string;
  createdAt: number;
  runs: PersistedChildRunV1[];
}

export interface ChildRunsDetailsEnvelope {
  childRuns: PersistedChildRunsV1;
}

export const isTerminalStatus = (
  status: ChildRunStatus,
): status is Exclude<ChildRunStatus, "queued" | "running"> =>
  status !== "queued" && status !== "running";
