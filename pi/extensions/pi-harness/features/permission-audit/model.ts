import { createHash, randomUUID } from "node:crypto";

export const PERMISSION_AUDIT_SCHEMA = "pi-harness/bash-permission";
export const PERMISSION_AUDIT_VERSION = 1;
export const MAX_PERMISSION_AUDIT_RECORD_BYTES = 1024 * 1024;

export type PermissionAuditDecision = "allow" | "ask" | "deny";
export type PermissionBoundaryDisposition = "release" | "block";
export type PermissionStageVerdict =
  | "allow"
  | "ask"
  | "deny"
  | "continue"
  | "error";

export interface PermissionCommandValue {
  readonly kind: "command";
  readonly text: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface MalformedPermissionCommandValue {
  readonly kind: "malformed";
  readonly valueType: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface OmittedPermissionCommandValue {
  readonly kind: "omitted";
  readonly reason: "record-too-large";
  readonly sha256: string;
  readonly bytes: number;
}

export type PermissionCommandRecord =
  | PermissionCommandValue
  | MalformedPermissionCommandValue
  | OmittedPermissionCommandValue;

export interface PermissionTaskAuditContext {
  readonly correlation: "task" | "none" | "uncorrelated";
  readonly task?: {
    readonly text: string;
    readonly source: string;
    readonly fingerprint?: string;
  };
}

export interface PermissionRunAuditContext {
  readonly assistantText?: string;
  readonly priorToolResults: readonly {
    readonly toolName: string;
    readonly status: "ok" | "error" | "unknown";
  }[];
  readonly fingerprint: string;
}

export interface PermissionProjectAuditContext {
  readonly kind: "git" | "non-git" | "unavailable";
  readonly name?: string;
  readonly cwd?: string;
  readonly activeWorktree?: string;
  readonly navigableRoots?: readonly string[];
  readonly worktrees?: readonly string[];
  readonly reason?: string;
  readonly fingerprint?: string;
}

export interface PermissionNavigationAuditContext {
  readonly scope: "listed-worktree" | "outside-listed-worktrees" | "unverified";
  readonly sameRepository: boolean;
}

export interface DeterministicPermissionStage {
  readonly type: "deterministic";
  readonly phase: string;
  readonly verdict:
    | Exclude<PermissionStageVerdict, "continue" | "error">
    | "continue";
  readonly basis: string;
  readonly reasonCode: string;
  readonly reason?: string;
  readonly ruleSource?: string;
  readonly grantedBySkill?: boolean;
}

export interface ScopePermissionStage {
  readonly type: "scope";
  readonly phase: string;
  readonly verdict: "allow" | "ask" | "deny" | "error";
  readonly reasonCode: string;
  readonly reason?: string;
  readonly project?: PermissionProjectAuditContext;
  readonly navigation?: PermissionNavigationAuditContext;
}

export interface JudgePermissionStage {
  readonly type: "judge";
  readonly phase: string;
  readonly verdict: "allow" | "ask" | "error";
  readonly reasonCode: string;
  readonly reason?: string;
  readonly outcome: string;
  readonly source?: "live" | "cache";
  readonly model?: string;
  readonly expectedDigest?: string;
  readonly policyVersion?: string;
  readonly gates?: {
    readonly safety: "ALLOW" | "ASK";
    readonly relevance: "ALLOW" | "ASK";
  };
}

export interface HookPermissionStage {
  readonly type: "hook";
  readonly phase: "preflight" | "remaining";
  readonly hookId: string;
  readonly verdict: "continue" | "ask" | "deny" | "error";
  readonly reasonCode: string;
  readonly reason?: string;
}

export type PermissionConfirmationStatus =
  | "accepted"
  | "rejected"
  | "not-shown"
  | "aborted";

export interface ConfirmationPermissionStage {
  readonly type: "confirmation";
  readonly phase: string;
  readonly challengeSource: string;
  readonly status: PermissionConfirmationStatus;
  readonly reasonCode: string;
  readonly reason?: string;
}

export interface ErrorPermissionStage {
  readonly type: "error";
  readonly component: string;
  readonly phase: string;
  readonly verdict: "error";
  readonly reasonCode: string;
  readonly message?: string;
}

export type PermissionAuditStage =
  | DeterministicPermissionStage
  | ScopePermissionStage
  | JudgePermissionStage
  | HookPermissionStage
  | ConfirmationPermissionStage
  | ErrorPermissionStage;

export interface PermissionAuditLineage {
  readonly lineageId: string;
  readonly source: "generated" | "harness-env";
  readonly parentSessionId?: string;
  readonly childInvocationId?: string;
  readonly childRunId?: string;
}

export interface PermissionDecisionRecordV1 {
  readonly schema: typeof PERMISSION_AUDIT_SCHEMA;
  readonly version: typeof PERMISSION_AUDIT_VERSION;
  readonly timestamp: string;
  readonly decisionId: string;
  readonly writerInstanceId: string;
  readonly sequence: number;
  readonly process: {
    readonly pid: number;
    readonly isChild: boolean;
    readonly lineage: PermissionAuditLineage;
  };
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly command: PermissionCommandRecord;
  readonly cwd?: string;
  readonly task: PermissionTaskAuditContext;
  readonly runEvidence?: PermissionRunAuditContext;
  readonly project?: PermissionProjectAuditContext;
  readonly leadingNavigation?: PermissionNavigationAuditContext;
  readonly gitCwd?: PermissionNavigationAuditContext;
  readonly stages: readonly PermissionAuditStage[];
  readonly effectiveDecision: PermissionAuditDecision;
  readonly boundaryDisposition: PermissionBoundaryDisposition;
  readonly terminalReasonCode: string;
}

export interface PermissionDecisionRecordInput {
  readonly timestamp?: string;
  readonly decisionId?: string;
  readonly writerInstanceId: string;
  readonly sequence: number;
  readonly pid: number;
  readonly isChild: boolean;
  readonly lineage: PermissionAuditLineage;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly command: PermissionCommandRecord;
  readonly cwd?: string;
  readonly task: PermissionTaskAuditContext;
  readonly runEvidence?: PermissionRunAuditContext;
  readonly project?: PermissionProjectAuditContext;
  readonly leadingNavigation?: PermissionNavigationAuditContext;
  readonly gitCwd?: PermissionNavigationAuditContext;
  readonly stages: readonly PermissionAuditStage[];
  readonly boundaryDisposition: PermissionBoundaryDisposition;
  readonly terminalReasonCode: string;
}

const serializedValue = (value: unknown): string => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return Object.prototype.toString.call(value);
  }
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const buildPermissionCommand = (
  value: unknown,
): PermissionCommandRecord => {
  if (typeof value === "string") {
    return {
      kind: "command",
      text: value,
      sha256: sha256(value),
      bytes: Buffer.byteLength(value, "utf8"),
    };
  }
  const serialized = serializedValue(value);
  return {
    kind: "malformed",
    valueType: value === null ? "null" : typeof value,
    sha256: sha256(serialized),
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
};

const stageBlocks = (stage: PermissionAuditStage): boolean => {
  if (stage.type === "confirmation") {
    return stage.status !== "accepted";
  }
  if (stage.type === "error") return true;
  return stage.verdict === "deny" || stage.verdict === "error";
};

export const derivePermissionDecision = (
  stages: readonly PermissionAuditStage[],
): PermissionAuditDecision => {
  if (
    stages.some((stage) => stage.type !== "confirmation" && stageBlocks(stage))
  ) {
    return "deny";
  }
  if (stages.some((stage) => stage.type === "confirmation")) return "ask";
  return "allow";
};

export const buildPermissionDecisionRecord = (
  input: PermissionDecisionRecordInput,
): PermissionDecisionRecordV1 => ({
  schema: PERMISSION_AUDIT_SCHEMA,
  version: PERMISSION_AUDIT_VERSION,
  timestamp: input.timestamp ?? new Date().toISOString(),
  decisionId: input.decisionId ?? randomUUID(),
  writerInstanceId: input.writerInstanceId,
  sequence: input.sequence,
  process: {
    pid: input.pid,
    isChild: input.isChild,
    lineage: input.lineage,
  },
  sessionId: input.sessionId,
  toolCallId: input.toolCallId,
  command: input.command,
  ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  task: input.task,
  ...(input.runEvidence === undefined
    ? {}
    : { runEvidence: input.runEvidence }),
  ...(input.project === undefined ? {} : { project: input.project }),
  ...(input.leadingNavigation === undefined
    ? {}
    : { leadingNavigation: input.leadingNavigation }),
  ...(input.gitCwd === undefined ? {} : { gitCwd: input.gitCwd }),
  stages: [...input.stages],
  effectiveDecision: derivePermissionDecision(input.stages),
  boundaryDisposition: input.boundaryDisposition,
  terminalReasonCode: input.terminalReasonCode,
});

export const permissionRecordBytes = (
  record: PermissionDecisionRecordV1,
): number => Buffer.byteLength(JSON.stringify(record), "utf8");

const compactIdentifier = (value: string): string => {
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes <= 1024 ? value : `sha256:${sha256(value)}:bytes:${bytes}`;
};

export const buildOversizedPermissionRecord = (
  input: PermissionDecisionRecordInput,
): PermissionDecisionRecordV1 => {
  const command = input.command;
  const compactCommand: PermissionCommandRecord = {
    kind: "omitted",
    reason: "record-too-large",
    sha256: command.sha256,
    bytes: command.bytes,
  };
  return buildPermissionDecisionRecord({
    writerInstanceId: input.writerInstanceId,
    sequence: input.sequence,
    pid: input.pid,
    isChild: input.isChild,
    lineage: input.lineage,
    sessionId: compactIdentifier(input.sessionId),
    toolCallId: compactIdentifier(input.toolCallId),
    command: compactCommand,
    task: { correlation: input.task.correlation },
    stages: [
      {
        type: "error",
        component: "permission-audit",
        phase: "serialize",
        verdict: "error",
        reasonCode: "record-too-large",
      },
    ],
    boundaryDisposition: "block",
    terminalReasonCode: "record-too-large",
    ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
    ...(input.decisionId === undefined ? {} : { decisionId: input.decisionId }),
  });
};

export const fitPermissionDecisionRecord = (
  input: PermissionDecisionRecordInput,
): PermissionDecisionRecordV1 => {
  const record = buildPermissionDecisionRecord(input);
  return permissionRecordBytes(record) <= MAX_PERMISSION_AUDIT_RECORD_BYTES
    ? record
    : buildOversizedPermissionRecord(input);
};
