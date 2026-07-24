import { randomUUID } from "node:crypto";
import type { HarnessConfig } from "../../config";
import type {
  CtxLike,
  PiLike,
  ToolCallBlockResult,
  ToolCallEvent,
} from "../../lib/pi-like";
import {
  derivePermissionRunEvidence,
  type PermissionLeadingNavigation,
  type PermissionProjectContext,
  type PermissionTaskTracker,
} from "../permission-policy/context";
import {
  buildPermissionCommand,
  fitPermissionDecisionRecord,
  type PermissionAuditStage,
  type PermissionProjectAuditContext,
  type PermissionTaskAuditContext,
} from "./model";
import {
  createPermissionAuditWriter,
  type PermissionAuditWriter,
} from "./writer";

export const PERMISSION_AUDIT_LINEAGE_ENV = "PI_HARNESS_AUDIT_LINEAGE_ID";
export const PERMISSION_AUDIT_PARENT_SESSION_ENV =
  "PI_HARNESS_AUDIT_PARENT_SESSION_ID";
export const PERMISSION_AUDIT_INVOCATION_ENV = "PI_HARNESS_AUDIT_INVOCATION_ID";
export const PERMISSION_AUDIT_RUN_ENV = "PI_HARNESS_AUDIT_RUN_ID";
export const PERMISSION_AUDIT_UNAVAILABLE_REASON =
  "permission-audit: decision record could not be persisted; command blocked";
export const PERMISSION_AUDIT_RECORD_TOO_LARGE_REASON =
  "permission-audit: decision record exceeded 1 MiB; command blocked";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

interface PermissionAuditContextUpdate {
  readonly project?: PermissionProjectContext;
  readonly leadingNavigation?: PermissionLeadingNavigation;
  readonly gitCwd?: PermissionLeadingNavigation;
}

interface PermissionAuditTransaction {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly command: ReturnType<typeof buildPermissionCommand>;
  readonly cwd?: string;
  readonly task: PermissionTaskAuditContext;
  readonly runEvidence?: ReturnType<typeof derivePermissionRunEvidence>;
  readonly stages: PermissionAuditStage[];
  project?: PermissionProjectContext;
  leadingNavigation?: PermissionLeadingNavigation;
  gitCwd?: PermissionLeadingNavigation;
  finalization?: Promise<PermissionAuditFinalizeResult>;
  context: CtxLike;
}

type PermissionAuditFinalizeResult =
  | "persisted"
  | "record-too-large"
  | "unavailable";

export interface PermissionAuditIntegration {
  readonly lineageId: string;
  addStage(toolCallId: string, stage: PermissionAuditStage): void;
  updateContext(toolCallId: string, update: PermissionAuditContextUpdate): void;
  finalizeBlock(toolCallId: string, reasonCode: string): Promise<boolean>;
  registerTail(
    pi: PiLike,
    blockToolCall: (reason: string) => ToolCallBlockResult,
  ): void;
  childEnvironment(
    ctx: CtxLike,
    childInvocationId: string | undefined,
    childRunId: string | undefined,
  ): Record<string, string>;
}

interface SetupPermissionAuditOptions {
  readonly taskTracker: PermissionTaskTracker;
  readonly writer?: PermissionAuditWriter;
  readonly env?: Record<string, string | undefined>;
  readonly randomUUID?: () => string;
  readonly onDisplayedConfirmation?: () => void;
}

const sessionId = (ctx: CtxLike): string => {
  try {
    const value = ctx.sessionManager?.getSessionId?.();
    return typeof value === "string" && value !== ""
      ? value
      : "unknown-session";
  } catch {
    return "unknown-session";
  }
};

const taskContext = (
  tracker: PermissionTaskTracker,
): PermissionTaskAuditContext => {
  const tracked = tracker.current();
  return tracked.correlation === "task"
    ? { correlation: "task", task: tracked.task }
    : { correlation: tracked.correlation };
};

const projectContext = (
  project: PermissionProjectContext | undefined,
): PermissionProjectAuditContext | undefined => {
  if (project === undefined) return undefined;
  if (project.kind === "git") {
    return {
      kind: "git",
      ...(project.name === undefined ? {} : { name: project.name }),
      cwd: project.cwd,
      activeWorktree: project.activeWorktree,
      navigableRoots: project.navigableRoots,
      worktrees: project.worktrees,
      fingerprint: project.fingerprint,
    };
  }
  if (project.kind === "non-git") {
    return {
      kind: "non-git",
      cwd: project.cwd,
      fingerprint: project.fingerprint,
    };
  }
  return {
    kind: "unavailable",
    ...(project.cwd === undefined ? {} : { cwd: project.cwd }),
    ...(project.reason === undefined ? {} : { reason: project.reason }),
    fingerprint: project.fingerprint,
  };
};

const validCorrelationId = (value: string | undefined): string | undefined =>
  value !== undefined && CORRELATION_ID_PATTERN.test(value) ? value : undefined;

const lineageFrom = (
  env: Record<string, string | undefined>,
  createId: () => string,
) => {
  const inherited = env[PERMISSION_AUDIT_LINEAGE_ENV];
  const lineageId =
    inherited !== undefined && UUID_PATTERN.test(inherited)
      ? inherited
      : createId();
  return {
    lineageId,
    source:
      inherited !== undefined && UUID_PATTERN.test(inherited)
        ? ("harness-env" as const)
        : ("generated" as const),
    parentSessionId: validCorrelationId(
      env[PERMISSION_AUDIT_PARENT_SESSION_ENV],
    ),
    childInvocationId: validCorrelationId(env[PERMISSION_AUDIT_INVOCATION_ENV]),
    childRunId: validCorrelationId(env[PERMISSION_AUDIT_RUN_ENV]),
  };
};

const currentRunEvidence = (
  ctx: CtxLike,
  toolCallId: string,
): ReturnType<typeof derivePermissionRunEvidence> => {
  try {
    return derivePermissionRunEvidence(
      ctx.sessionManager?.getBranch() ?? [],
      toolCallId,
    );
  } catch {
    return undefined;
  }
};

export const setupPermissionAudit = (
  pi: PiLike,
  config: HarnessConfig,
  options: SetupPermissionAuditOptions,
): PermissionAuditIntegration => {
  const createId = options.randomUUID ?? randomUUID;
  let lineage: ReturnType<typeof lineageFrom>;
  try {
    lineage = lineageFrom(options.env ?? process.env, createId);
  } catch {
    // Keep the permission chain installed even if entropy is unavailable. The
    // writer will independently fail and the tail will block the command.
    lineage = {
      lineageId: "00000000-0000-4000-8000-000000000000",
      source: "generated",
      parentSessionId: undefined,
      childInvocationId: undefined,
      childRunId: undefined,
    };
  }
  let writer: PermissionAuditWriter;
  if (options.writer !== undefined) {
    writer = options.writer;
  } else {
    try {
      writer = createPermissionAuditWriter(config.paths.logDir, {
        isChild: config.isChild,
      });
    } catch (error) {
      const unavailable =
        error instanceof Error ? error : new Error(String(error));
      writer = {
        writerInstanceId: "unavailable",
        append: () => Promise.reject(unavailable),
        close: () => Promise.resolve(),
      };
    }
  }
  const transactions = new Map<string, PermissionAuditTransaction>();
  const completedFinalizations = new Map<
    string,
    PermissionAuditFinalizeResult
  >();
  let unavailableWarningShown = false;
  let shuttingDown = false;

  const warnUnavailable = (ctx: CtxLike): void => {
    if (!ctx.hasUI || unavailableWarningShown) return;
    unavailableWarningShown = true;
    ctx.ui.notify(
      "Permission audit log is unavailable; Bash commands are blocked until logging is restored.",
      "error",
    );
  };

  const rememberFinalization = (
    toolCallId: string,
    result: PermissionAuditFinalizeResult,
  ): PermissionAuditFinalizeResult => {
    completedFinalizations.set(toolCallId, result);
    if (completedFinalizations.size > 4096) {
      const oldest = completedFinalizations.keys().next().value;
      if (oldest !== undefined) completedFinalizations.delete(oldest);
    }
    return result;
  };

  const begin = (event: ToolCallEvent, ctx: CtxLike): void => {
    if (
      event.toolName !== "bash" ||
      transactions.has(event.toolCallId) ||
      completedFinalizations.has(event.toolCallId)
    ) {
      return;
    }
    const command = event.input?.command;
    const runEvidence = currentRunEvidence(ctx, event.toolCallId);
    transactions.set(event.toolCallId, {
      sessionId: sessionId(ctx),
      toolCallId: event.toolCallId,
      command: buildPermissionCommand(command),
      ...(ctx.cwd === undefined ? {} : { cwd: ctx.cwd }),
      task: taskContext(options.taskTracker),
      ...(runEvidence === undefined ? {} : { runEvidence }),
      stages: [],
      context: ctx,
    });
  };

  const finalize = async (
    toolCallId: string,
    boundaryDisposition: "release" | "block",
    terminalReasonCode: string,
  ): Promise<PermissionAuditFinalizeResult> => {
    const transaction = transactions.get(toolCallId);
    if (transaction === undefined) {
      return completedFinalizations.get(toolCallId) ?? "unavailable";
    }
    if (transaction.finalization !== undefined) {
      return transaction.finalization;
    }
    const finalization = (async (): Promise<PermissionAuditFinalizeResult> => {
      try {
        const project = projectContext(transaction.project);
        const record = await writer.append((identity) =>
          fitPermissionDecisionRecord({
            ...identity,
            pid: process.pid,
            isChild: config.isChild,
            lineage,
            sessionId: transaction.sessionId,
            toolCallId: transaction.toolCallId,
            command: transaction.command,
            ...(transaction.cwd === undefined ? {} : { cwd: transaction.cwd }),
            task: transaction.task,
            ...(transaction.runEvidence === undefined
              ? {}
              : { runEvidence: transaction.runEvidence }),
            ...(project === undefined ? {} : { project }),
            ...(transaction.leadingNavigation === undefined
              ? {}
              : { leadingNavigation: transaction.leadingNavigation }),
            ...(transaction.gitCwd === undefined
              ? {}
              : { gitCwd: transaction.gitCwd }),
            stages: transaction.stages,
            boundaryDisposition,
            terminalReasonCode,
          }),
        );
        transactions.delete(toolCallId);
        return rememberFinalization(
          toolCallId,
          record.terminalReasonCode === "record-too-large"
            ? "record-too-large"
            : "persisted",
        );
      } catch {
        transactions.delete(toolCallId);
        warnUnavailable(transaction.context);
        return rememberFinalization(toolCallId, "unavailable");
      }
    })();
    transaction.finalization = finalization;
    return finalization;
  };

  pi.on("session_start", () => {
    completedFinalizations.clear();
    unavailableWarningShown = false;
  });

  pi.on("tool_call", (event, ctx) => {
    if (shuttingDown || event.toolName !== "bash") return undefined;
    begin(event, ctx);
    return undefined;
  });

  return {
    lineageId: lineage.lineageId,
    addStage(toolCallId, stage) {
      const transaction = transactions.get(toolCallId);
      if (transaction === undefined || transaction.finalization !== undefined) {
        return;
      }
      transaction.stages.push(stage);
      if (stage.type === "confirmation" && stage.status !== "not-shown") {
        try {
          options.onDisplayedConfirmation?.();
        } catch {
          // Reminder bookkeeping must never alter the permission decision.
        }
      }
    },
    updateContext(toolCallId, update) {
      const transaction = transactions.get(toolCallId);
      if (transaction === undefined || transaction.finalization !== undefined) {
        return;
      }
      if (update.project !== undefined) transaction.project = update.project;
      if (update.leadingNavigation !== undefined) {
        transaction.leadingNavigation = update.leadingNavigation;
      }
      if (update.gitCwd !== undefined) transaction.gitCwd = update.gitCwd;
    },
    async finalizeBlock(toolCallId, reasonCode) {
      return (
        (await finalize(toolCallId, "block", reasonCode)) !== "unavailable"
      );
    },
    registerTail(tailPi, blockToolCall) {
      tailPi.on("tool_call", async (event) => {
        if (event.toolName !== "bash") return undefined;
        const result = await finalize(
          event.toolCallId,
          "release",
          "permission-chain-released",
        );
        if (result === "persisted") return undefined;
        return blockToolCall(
          result === "record-too-large"
            ? PERMISSION_AUDIT_RECORD_TOO_LARGE_REASON
            : PERMISSION_AUDIT_UNAVAILABLE_REASON,
        );
      });
      tailPi.on("session_shutdown", async () => {
        shuttingDown = true;
        for (const [toolCallId, transaction] of transactions) {
          if (transaction.finalization !== undefined) continue;
          transaction.stages.push({
            type: "error",
            component: "permission-audit",
            phase: "session-shutdown",
            verdict: "error",
            reasonCode: "session-shutdown",
          });
          await finalize(toolCallId, "block", "session-shutdown");
        }
        await writer.close().catch(() => {});
      });
    },
    childEnvironment(ctx, childInvocationId, childRunId) {
      return {
        [PERMISSION_AUDIT_LINEAGE_ENV]: lineage.lineageId,
        [PERMISSION_AUDIT_PARENT_SESSION_ENV]: sessionId(ctx),
        ...(validCorrelationId(childInvocationId) === undefined
          ? {}
          : {
              [PERMISSION_AUDIT_INVOCATION_ENV]: childInvocationId as string,
            }),
        ...(validCorrelationId(childRunId) === undefined
          ? {}
          : { [PERMISSION_AUDIT_RUN_ENV]: childRunId as string }),
      };
    },
  };
};
