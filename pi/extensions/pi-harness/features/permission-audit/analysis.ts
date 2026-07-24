import {
  derivePermissionDecision,
  MAX_PERMISSION_AUDIT_RECORD_BYTES,
  PERMISSION_AUDIT_SCHEMA,
  PERMISSION_AUDIT_VERSION,
  type PermissionAuditStage,
  type PermissionDecisionRecordV1,
} from "./model";

export interface PermissionAuditParseDiagnostic {
  readonly line: number;
  readonly code: "invalid-json" | "invalid-record" | "truncated-tail";
}

export interface PermissionAuditParseResult {
  readonly records: readonly PermissionDecisionRecordV1[];
  readonly diagnostics: readonly PermissionAuditParseDiagnostic[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const nonnegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const validNavigation = (value: unknown): boolean =>
  isRecord(value) &&
  ["listed-worktree", "outside-listed-worktrees", "unverified"].includes(
    String(value.scope),
  ) &&
  typeof value.sameRepository === "boolean";

const validProject = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !["git", "non-git", "unavailable"].includes(String(value.kind))
  ) {
    return false;
  }
  if (
    !optionalString(value.name) ||
    !optionalString(value.cwd) ||
    !optionalString(value.activeWorktree) ||
    !optionalString(value.reason) ||
    !optionalString(value.fingerprint) ||
    (value.navigableRoots !== undefined &&
      !stringArray(value.navigableRoots)) ||
    (value.worktrees !== undefined && !stringArray(value.worktrees))
  ) {
    return false;
  }
  return (
    value.kind !== "git" ||
    (typeof value.cwd === "string" &&
      typeof value.activeWorktree === "string" &&
      stringArray(value.navigableRoots) &&
      stringArray(value.worktrees))
  );
};

const validStage = (value: unknown): value is PermissionAuditStage => {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    !optionalString(value.reason)
  ) {
    return false;
  }
  if (value.type === "confirmation") {
    return (
      typeof value.phase === "string" &&
      typeof value.challengeSource === "string" &&
      typeof value.reasonCode === "string" &&
      ["accepted", "rejected", "not-shown", "aborted"].includes(
        String(value.status),
      )
    );
  }
  if (value.type === "error") {
    return (
      value.verdict === "error" &&
      typeof value.component === "string" &&
      typeof value.phase === "string" &&
      typeof value.reasonCode === "string" &&
      optionalString(value.message)
    );
  }
  if (value.type === "hook") {
    return (
      (value.phase === "preflight" || value.phase === "remaining") &&
      typeof value.hookId === "string" &&
      typeof value.reasonCode === "string" &&
      ["continue", "ask", "deny", "error"].includes(String(value.verdict))
    );
  }
  if (value.type === "judge") {
    const gates = value.gates;
    return (
      typeof value.phase === "string" &&
      typeof value.reasonCode === "string" &&
      typeof value.outcome === "string" &&
      ["allow", "ask", "error"].includes(String(value.verdict)) &&
      (value.source === undefined ||
        value.source === "live" ||
        value.source === "cache") &&
      optionalString(value.model) &&
      optionalString(value.expectedDigest) &&
      optionalString(value.policyVersion) &&
      (gates === undefined ||
        (isRecord(gates) &&
          ["ALLOW", "ASK"].includes(String(gates.safety)) &&
          ["ALLOW", "ASK"].includes(String(gates.relevance))))
    );
  }
  if (value.type === "scope") {
    return (
      typeof value.phase === "string" &&
      typeof value.reasonCode === "string" &&
      ["allow", "ask", "deny", "error"].includes(String(value.verdict)) &&
      (value.project === undefined || validProject(value.project)) &&
      (value.navigation === undefined || validNavigation(value.navigation))
    );
  }
  if (value.type === "deterministic") {
    return (
      typeof value.phase === "string" &&
      typeof value.basis === "string" &&
      typeof value.reasonCode === "string" &&
      ["allow", "ask", "deny", "continue"].includes(String(value.verdict)) &&
      optionalString(value.ruleSource) &&
      (value.grantedBySkill === undefined ||
        typeof value.grantedBySkill === "boolean")
    );
  }
  return false;
};

const validCommand = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !SHA256_PATTERN.test(String(value.sha256)) ||
    !nonnegativeSafeInteger(value.bytes)
  ) {
    return false;
  }
  if (value.kind === "command") return typeof value.text === "string";
  if (value.kind === "malformed") return typeof value.valueType === "string";
  return value.kind === "omitted" && value.reason === "record-too-large";
};

const validTask = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !["task", "none", "uncorrelated"].includes(String(value.correlation))
  ) {
    return false;
  }
  if (value.correlation !== "task") return value.task === undefined;
  return (
    isRecord(value.task) &&
    typeof value.task.text === "string" &&
    typeof value.task.source === "string" &&
    optionalString(value.task.fingerprint)
  );
};

const validRunEvidence = (value: unknown): boolean =>
  isRecord(value) &&
  optionalString(value.assistantText) &&
  typeof value.fingerprint === "string" &&
  Array.isArray(value.priorToolResults) &&
  value.priorToolResults.every(
    (item) =>
      isRecord(item) &&
      typeof item.toolName === "string" &&
      ["ok", "error", "unknown"].includes(String(item.status)),
  );

export const isPermissionDecisionRecordV1 = (
  value: unknown,
): value is PermissionDecisionRecordV1 => {
  if (!isRecord(value)) return false;
  const processValue = value.process;
  const lineage = isRecord(processValue) ? processValue.lineage : undefined;
  if (
    value.schema !== PERMISSION_AUDIT_SCHEMA ||
    value.version !== PERMISSION_AUDIT_VERSION ||
    typeof value.timestamp !== "string" ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    typeof value.decisionId !== "string" ||
    !UUID_PATTERN.test(value.decisionId) ||
    typeof value.writerInstanceId !== "string" ||
    !UUID_PATTERN.test(value.writerInstanceId) ||
    !nonnegativeSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    typeof value.sessionId !== "string" ||
    typeof value.toolCallId !== "string" ||
    !isRecord(processValue) ||
    !nonnegativeSafeInteger(processValue.pid) ||
    typeof processValue.isChild !== "boolean" ||
    !isRecord(lineage) ||
    typeof lineage.lineageId !== "string" ||
    !UUID_PATTERN.test(lineage.lineageId) ||
    (lineage.source !== "generated" && lineage.source !== "harness-env") ||
    !optionalString(lineage.parentSessionId) ||
    !optionalString(lineage.childInvocationId) ||
    !optionalString(lineage.childRunId) ||
    !validCommand(value.command) ||
    !validTask(value.task) ||
    (value.cwd !== undefined && typeof value.cwd !== "string") ||
    (value.runEvidence !== undefined && !validRunEvidence(value.runEvidence)) ||
    (value.project !== undefined && !validProject(value.project)) ||
    (value.leadingNavigation !== undefined &&
      !validNavigation(value.leadingNavigation)) ||
    (value.gitCwd !== undefined && !validNavigation(value.gitCwd)) ||
    !Array.isArray(value.stages) ||
    !value.stages.every(validStage) ||
    !["allow", "ask", "deny"].includes(String(value.effectiveDecision)) ||
    derivePermissionDecision(value.stages) !== value.effectiveDecision ||
    !["release", "block"].includes(String(value.boundaryDisposition)) ||
    typeof value.terminalReasonCode !== "string"
  ) {
    return false;
  }
  return true;
};

export const parsePermissionAuditJsonl = (
  text: string,
): PermissionAuditParseResult => {
  const records: PermissionDecisionRecordV1[] = [];
  const diagnostics: PermissionAuditParseDiagnostic[] = [];
  const endsWithNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (endsWithNewline) lines.pop();
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    if (Buffer.byteLength(line, "utf8") > MAX_PERMISSION_AUDIT_RECORD_BYTES) {
      diagnostics.push({ line: index + 1, code: "invalid-record" });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      diagnostics.push({
        line: index + 1,
        code:
          !endsWithNewline && index === lines.length - 1
            ? "truncated-tail"
            : "invalid-json",
      });
      continue;
    }
    if (!isPermissionDecisionRecordV1(parsed)) {
      diagnostics.push({ line: index + 1, code: "invalid-record" });
      continue;
    }
    records.push(parsed);
  }
  return { records, diagnostics };
};

const increment = (target: Record<string, number>, key: string): void => {
  target[key] = (target[key] ?? 0) + 1;
};

const stageRoute = (stage: PermissionAuditStage): string => {
  if (stage.type === "deterministic")
    return `${stage.type}:${stage.phase}:${stage.basis}`;
  if (stage.type === "hook")
    return `${stage.type}:${stage.phase}:${stage.hookId}`;
  if (stage.type === "confirmation") {
    return `${stage.type}:${stage.phase}:${stage.challengeSource}`;
  }
  if (stage.type === "error")
    return `${stage.type}:${stage.component}:${stage.phase}`;
  return `${stage.type}:${stage.phase}`;
};

export interface PermissionAuditSummary {
  readonly total: number;
  readonly byDecision: Readonly<Record<string, number>>;
  readonly byDisposition: Readonly<Record<string, number>>;
  readonly byRoute: Readonly<Record<string, number>>;
  readonly byReason: Readonly<Record<string, number>>;
  readonly byJudgeGates: Readonly<Record<string, number>>;
  readonly byConfirmation: Readonly<Record<string, number>>;
  readonly byCommand: Readonly<Record<string, number>>;
  readonly byProcessKind: Readonly<Record<string, number>>;
}

export const summarizePermissionAudit = (
  records: readonly PermissionDecisionRecordV1[],
): PermissionAuditSummary => {
  const byDecision: Record<string, number> = {};
  const byDisposition: Record<string, number> = {};
  const byRoute: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const byJudgeGates: Record<string, number> = {};
  const byConfirmation: Record<string, number> = {};
  const byCommand: Record<string, number> = {};
  const byProcessKind: Record<string, number> = {};
  for (const record of records) {
    increment(byDecision, record.effectiveDecision);
    increment(byDisposition, record.boundaryDisposition);
    increment(byReason, `terminal:${record.terminalReasonCode}`);
    increment(byCommand, record.command.sha256);
    increment(byProcessKind, record.process.isChild ? "child" : "parent");
    for (const stage of record.stages) {
      increment(byRoute, stageRoute(stage));
      increment(byReason, stage.reasonCode);
      if (stage.type === "judge" && stage.gates !== undefined) {
        increment(
          byJudgeGates,
          `${stage.source ?? "unknown"}:${stage.gates.safety}/${stage.gates.relevance}`,
        );
      }
      if (stage.type === "confirmation") {
        increment(byConfirmation, stage.status);
      }
    }
  }
  return {
    total: records.length,
    byDecision,
    byDisposition,
    byRoute,
    byReason,
    byJudgeGates,
    byConfirmation,
    byCommand,
    byProcessKind,
  };
};

export interface PermissionQualificationCandidate {
  readonly schema: "pi-harness/permission-qualification-candidate";
  readonly version: 1;
  readonly decisionId: string;
  readonly observedAt: string;
  readonly command: string;
  readonly commandSha256: string;
  readonly cwd?: string;
  readonly task: PermissionDecisionRecordV1["task"];
  readonly runEvidence?: PermissionDecisionRecordV1["runEvidence"];
  readonly project?: PermissionDecisionRecordV1["project"];
  readonly leadingNavigation?: PermissionDecisionRecordV1["leadingNavigation"];
  readonly gitCwd?: PermissionDecisionRecordV1["gitCwd"];
  readonly observedDecision: PermissionDecisionRecordV1["effectiveDecision"];
  readonly boundaryDisposition: PermissionDecisionRecordV1["boundaryDisposition"];
  readonly stages: PermissionDecisionRecordV1["stages"];
}

export const buildPermissionQualificationCandidates = (
  records: readonly PermissionDecisionRecordV1[],
): readonly PermissionQualificationCandidate[] =>
  records.flatMap((record) => {
    if (record.command.kind !== "command") return [];
    return [
      {
        schema: "pi-harness/permission-qualification-candidate" as const,
        version: 1 as const,
        decisionId: record.decisionId,
        observedAt: record.timestamp,
        command: record.command.text,
        commandSha256: record.command.sha256,
        ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
        task: record.task,
        ...(record.runEvidence === undefined
          ? {}
          : { runEvidence: record.runEvidence }),
        ...(record.project === undefined ? {} : { project: record.project }),
        ...(record.leadingNavigation === undefined
          ? {}
          : { leadingNavigation: record.leadingNavigation }),
        ...(record.gitCwd === undefined ? {} : { gitCwd: record.gitCwd }),
        observedDecision: record.effectiveDecision,
        boundaryDisposition: record.boundaryDisposition,
        stages: record.stages,
      },
    ];
  });
