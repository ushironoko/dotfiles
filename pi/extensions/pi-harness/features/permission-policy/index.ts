import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ActiveAbortSignal,
  createAbortController,
  isAbortSignal as isActiveAbortSignal,
} from "../../lib/abort";
import type { CtxLike, InputEvent, PiLike } from "../../lib/pi-like";
import {
  DEFAULT_PERMISSION_JUDGE_CONFIG,
  type HarnessConfig,
} from "../../config";
import type { BashExecutionBoundary } from "../bash-sandbox";
import { createPermissionBlocker, type PermissionBlockResult } from "./block";
import { appendCommandHygiene } from "./command-hygiene";
import {
  authorizeCodexStageEscalation,
  consumeCodexStageCapability,
  pinCodexStageCommand,
} from "./codex-stage-capability";
import type { CodexStageMode } from "../../lib/agent-md";
import {
  createPermissionTaskTracker,
  derivePermissionRunEvidence,
  discoverProjectContext,
  type PermissionLeadingNavigation,
  type PermissionProjectContext,
  type PermissionRunEvidence,
  type PermissionTaskTracker,
} from "./context";
import {
  createPermissionJudge,
  type JudgeOutcome,
  type PermissionJudge,
} from "./judge";
import { permissionJudgeRuntimeOptions } from "./judge-runtime";
import {
  evaluateCommandWithAudit,
  loadRules,
  type AllowRule,
  type AuditedVerdict,
  type LoadedRules,
} from "./rules";
import { routePermissionCommand } from "./routing";
import {
  createActiveSkillBashAllowResolver,
  evaluateCommandWithSkillAllows,
  parseSkillInvocation,
  skillGrantedGitCwd,
  type ActiveSkillBashAllowResolver,
  type SkillInvocation,
} from "./skill-allow";
import {
  PERMISSION_AUDIT_UNAVAILABLE_REASON,
  type PermissionAuditIntegration,
} from "../permission-audit/index";

const readPermissionRules = (): string | undefined => {
  try {
    const rulesFile = fileURLToPath(
      new URL("../../permission-rules.json", import.meta.url),
    );
    return readFileSync(rulesFile, "utf8");
  } catch {
    return undefined;
  }
};

const MALFORMED_REASON =
  "permission-policy: bash ツール入力が不正なため実行をブロックしました（command が文字列ではありません）";
const CODEX_JUDGE_ASK_FEEDBACK =
  "[pi-harness permission feedback] The Codex verifier returned ASK for this command. The user approved this one execution; do not treat that approval as an automatic ALLOW label for later commands.";

type PermissionConfirmationOutcome =
  | "accepted"
  | "rejected"
  | "timed-out"
  | "not-shown"
  | "aborted";

const signalIsAborted = (signal: ActiveAbortSignal | undefined): boolean =>
  signal?.aborted === true;

const requestPermissionConfirmation = async (
  ctx: CtxLike,
  title: string,
  message: string,
  timeoutMs: number,
): Promise<PermissionConfirmationOutcome> => {
  if (!ctx.hasUI) return "not-shown";
  const parentSignal = isActiveAbortSignal(ctx.signal) ? ctx.signal : undefined;
  if (signalIsAborted(parentSignal)) return "aborted";

  // Pi intentionally collapses UI rejection, cancellation, and timeout into
  // false. Own the deadline signal here so policy can distinguish an expired
  // prompt while preserving Pi's native countdown/timeout metadata.
  const confirmationController = createAbortController();
  let timedOut = false;
  const abortFromParent = (): void => confirmationController.abort();
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    confirmationController.abort();
  }, timeoutMs);

  try {
    const confirmed = await ctx.ui.confirm(title, message, {
      signal: confirmationController.signal,
      timeout: timeoutMs,
    });
    if (signalIsAborted(parentSignal)) return "aborted";
    if (timedOut) return "timed-out";
    return confirmed ? "accepted" : "rejected";
  } catch (error) {
    if (signalIsAborted(parentSignal)) return "aborted";
    if (timedOut) return "timed-out";
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
};

const confirmationBlockReason = (
  outcome: Exclude<PermissionConfirmationOutcome, "accepted">,
  reason: string,
): string => {
  let feedback: string;
  if (outcome === "timed-out") {
    feedback =
      "Permission confirmation timed out. The user is unavailable to respond. Do not wait for or request another confirmation; follow the system prompt instructions and continue handling the task without executing this command.";
  } else if (outcome === "rejected") {
    feedback =
      "Permission confirmation was denied by the user. Do not execute this command.";
  } else if (outcome === "aborted") {
    feedback =
      "The active pi operation was cancelled before permission was granted. Do not execute this command.";
  } else {
    feedback =
      "Permission confirmation could not be shown because interactive UI is unavailable. Do not execute this command.";
  }
  return `${feedback}\n\nConfirmation reason: ${reason}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

interface UserMessageEntry {
  readonly key: string;
  readonly text: string;
}

interface PendingInput {
  readonly sequence: number;
  readonly rawText: string;
  readonly invocation?: SkillInvocation;
}

const userMessageText = (value: unknown): string | undefined => {
  if (!isRecord(value) || value.role !== "user") return undefined;
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return undefined;
  const text: string[] = [];
  for (const block of value.content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      text.push(block.text);
    }
  }
  return text.length === 0 ? undefined : text.join("");
};

const userMessageEntries = (
  messages: readonly unknown[],
): readonly UserMessageEntry[] | undefined => {
  const entries: UserMessageEntry[] = [];
  const occurrences = new Map<string, number>();
  for (const message of messages) {
    const text = userMessageText(message);
    if (text === undefined) continue;
    if (!isRecord(message) || typeof message.timestamp !== "number") {
      return undefined;
    }
    const base = `${message.timestamp}\u0000${text}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    entries.push({ key: `${base}\u0000${occurrence}`, text });
  }
  return entries;
};

const trustedPendingInput = (
  event: InputEvent,
  sequence: number,
): PendingInput => {
  if (event.source !== "interactive" && event.source !== "rpc") {
    return { sequence, rawText: event.text };
  }
  const invocation = parseSkillInvocation(event.text);
  return invocation === undefined
    ? { sequence, rawText: event.text }
    : { sequence, rawText: event.text, invocation };
};

const JUDGE_WARNING_KINDS: ReadonlySet<JudgeOutcome["kind"]> = new Set([
  "timeout",
  "unavailable",
]);

const currentRunEvidence = (
  ctx: { sessionManager?: { getBranch(): unknown[] } },
  toolCallId: string,
): PermissionRunEvidence | undefined => {
  try {
    return derivePermissionRunEvidence(
      ctx.sessionManager?.getBranch() ?? [],
      toolCallId,
    );
  } catch {
    // Session evidence improves classification but is never required to keep
    // the mandatory permission boundary operational.
    return undefined;
  }
};

interface SetupPermissionPolicyOptions {
  permissionSignalToken?: string;
  rules?: LoadedRules;
  writePermissionSignal?: (text: string) => void;
  blockToolCall?: (reason: string) => PermissionBlockResult;
  discoverProject?: (
    cwd: string,
    signal?: AbortSignal,
    leadingCdTarget?: string,
  ) => Promise<PermissionProjectContext>;
  taskTracker?: PermissionTaskTracker;
  permissionAudit?: PermissionAuditIntegration;
  judge?: PermissionJudge;
  executionBoundary?: (toolName: string) => BashExecutionBoundary | undefined;
  codexStageModes?: ReadonlySet<CodexStageMode>;
  codexStageExecutablePath?: string;
}

const setupPermissionPolicy = (
  pi: PiLike,
  config: HarnessConfig,
  options: SetupPermissionPolicyOptions = {},
): void => {
  const rules = options.rules ?? loadRules(readPermissionRules());
  const judgeConfig = config.permissionJudge;
  const judge =
    options.judge ??
    (judgeConfig?.enabled === true
      ? createPermissionJudge(
          judgeConfig,
          permissionJudgeRuntimeOptions(config.paths.home),
        )
      : undefined);
  const taskTracker = options.taskTracker ?? createPermissionTaskTracker();
  const consumedCodexStageModes = consumeCodexStageCapability(config.isChild);
  const codexStageModes = options.codexStageModes ?? consumedCodexStageModes;
  const { permissionAudit } = options;
  const discoverProject =
    options.discoverProject ??
    ((cwd: string, signal?: AbortSignal, leadingCdTarget?: string) =>
      discoverProjectContext(
        cwd,
        leadingCdTarget === undefined ? {} : { leadingCdTarget },
        signal,
      ));
  let judgeWarningShown = false;
  const acceptedCodexJudgeAskCalls = new Map<string, string>();
  let activeSkillBashAllows: readonly AllowRule[] = [];
  let resolveActiveSkillBashAllows: ActiveSkillBashAllowResolver = () => [];
  let lifecycleEventsAvailable = false;
  let pendingIdleInput: PendingInput | undefined;
  let pendingInitial:
    | { readonly prompt: string; readonly grants: readonly AllowRule[] }
    | undefined;
  let lastUserMessageKey: string | undefined;
  const steeringInputs: PendingInput[] = [];
  const followUpInputs: PendingInput[] = [];
  let inputSequence = 0;
  let queueHealthy = true;

  const clearQueuedInputs = (): void => {
    steeringInputs.length = 0;
    followUpInputs.length = 0;
  };
  const clearSkillLifecycle = (): void => {
    activeSkillBashAllows = [];
    resolveActiveSkillBashAllows = () => [];
    pendingIdleInput = undefined;
    pendingInitial = undefined;
    lastUserMessageKey = undefined;
    clearQueuedInputs();
    inputSequence = 0;
    queueHealthy = true;
  };
  const enqueueInput = (queue: PendingInput[], input: PendingInput): void => {
    if (!queueHealthy) return;
    if (steeringInputs.length + followUpInputs.length >= 128) {
      clearQueuedInputs();
      queueHealthy = false;
      return;
    }
    queue.push(input);
  };
  const nextQueuedInput = (): PendingInput | undefined => {
    const newestSequence = Math.max(
      ...steeringInputs.map((input) => input.sequence),
      ...followUpInputs.map((input) => input.sequence),
    );
    const input = steeringInputs.shift() ?? followUpInputs.shift();
    if (input?.invocation !== undefined && input.sequence !== newestSequence) {
      // A later queued input may have replaced this message through Pi's
      // dequeue/edit flow. Only the newest queued capability can activate;
      // older records fail closed instead of authenticating replayed text.
      return { sequence: input.sequence, rawText: input.rawText };
    }
    return input;
  };

  try {
    pi.on("input", (event) => {
      taskTracker.capture({
        text: event.text,
        source: event.source,
        ...(event.streamingBehavior === undefined
          ? {}
          : { streamingBehavior: event.streamingBehavior }),
      });
      if (config.isChild) return;
      const input = trustedPendingInput(event, ++inputSequence);
      if (event.streamingBehavior === "steer") {
        enqueueInput(steeringInputs, input);
      } else if (event.streamingBehavior === "followUp") {
        enqueueInput(followUpInputs, input);
      } else {
        // Idle prompts are serialized; replacing this one-shot marker also
        // discards a prompt handled or rejected by a later input handler.
        pendingIdleInput = input;
      }
    });
    pi.on("context", (event) => {
      taskTracker.activateFromMessages(event.messages);
      const entries = userMessageEntries(event.messages);
      if (
        config.isChild ||
        !lifecycleEventsAvailable ||
        !queueHealthy ||
        entries === undefined ||
        entries.length === 0
      ) {
        activeSkillBashAllows = [];
        pendingInitial = undefined;
        return;
      }

      const latest = entries[entries.length - 1];
      if (latest === undefined) {
        activeSkillBashAllows = [];
        return;
      }
      if (pendingInitial !== undefined) {
        activeSkillBashAllows =
          latest.text === pendingInitial.prompt ? pendingInitial.grants : [];
        pendingInitial = undefined;
        lastUserMessageKey = latest.key;
        return;
      }
      if (lastUserMessageKey === undefined) {
        // A resumed/compacted context cannot be associated with a raw input.
        activeSkillBashAllows = [];
        clearQueuedInputs();
        queueHealthy = false;
        lastUserMessageKey = latest.key;
        return;
      }

      let previousIndex = -1;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index]?.key === lastUserMessageKey) {
          previousIndex = index;
          break;
        }
      }
      if (previousIndex === -1) {
        activeSkillBashAllows = [];
        clearQueuedInputs();
        queueHealthy = false;
        lastUserMessageKey = latest.key;
        return;
      }
      for (const entry of entries.slice(previousIndex + 1)) {
        const input = nextQueuedInput();
        activeSkillBashAllows =
          input?.invocation === undefined
            ? []
            : resolveActiveSkillBashAllows(entry.text, input.invocation);
      }
      lastUserMessageKey = latest.key;
    });
    lifecycleEventsAvailable = true;
  } catch {
    // Older/test adapters without both lifecycle events fail closed.
  }

  const blocked =
    options.blockToolCall ??
    createPermissionBlocker(config.isChild, {
      permissionSignalToken: options.permissionSignalToken,
      writePermissionSignal: options.writePermissionSignal,
    });
  const recordDeterministic = (
    toolCallId: string,
    phase: string,
    result: AuditedVerdict & { readonly grantedBySkill?: boolean },
  ): void => {
    permissionAudit?.addStage(toolCallId, {
      type: "deterministic",
      phase,
      verdict:
        result.verdict === "default-continue" ? "continue" : result.verdict,
      basis: result.audit.basis,
      reasonCode: result.audit.reasonCode,
      ...(result.verdict === "default-continue" || result.reason === undefined
        ? {}
        : { reason: result.reason }),
      ...(result.audit.ruleSource === undefined
        ? {}
        : { ruleSource: result.audit.ruleSource }),
      ...(result.grantedBySkill === true ? { grantedBySkill: true } : {}),
    });
  };
  const finalizeBlocked = async (
    toolCallId: string,
    reasonCode: string,
    reason: string,
  ): Promise<PermissionBlockResult> => {
    if (permissionAudit === undefined) return blocked(reason);
    return (await permissionAudit.finalizeBlock(toolCallId, reasonCode))
      ? blocked(reason)
      : blocked(PERMISSION_AUDIT_UNAVAILABLE_REASON);
  };

  pi.on("before_agent_start", (event) => {
    taskTracker.activate(event.prompt);
    activeSkillBashAllows = [];
    clearQueuedInputs();
    queueHealthy = true;
    resolveActiveSkillBashAllows =
      config.isChild || !lifecycleEventsAvailable
        ? () => []
        : createActiveSkillBashAllowResolver(event);
    const invocation = pendingIdleInput?.invocation;
    pendingIdleInput = undefined;
    pendingInitial = {
      prompt: event.prompt,
      grants:
        invocation === undefined
          ? []
          : resolveActiveSkillBashAllows(event.prompt, invocation),
    };
    return {
      systemPrompt: appendCommandHygiene(
        typeof event.systemPrompt === "string" ? event.systemPrompt : "",
      ),
    };
  });

  pi.on("agent_settled", () => {
    taskTracker.settle();
    clearSkillLifecycle();
  });

  pi.on("session_shutdown", () => {
    taskTracker.clear();
    clearSkillLifecycle();
    acceptedCodexJudgeAskCalls.clear();
    judge?.clear();
  });

  pi.on("tool_result", (event) => {
    if (
      (event.toolName !== "bash" && event.toolName !== "bash_escalated") ||
      event.toolCallId === undefined
    ) {
      return undefined;
    }
    const feedback = acceptedCodexJudgeAskCalls.get(event.toolCallId);
    if (feedback === undefined) return undefined;
    acceptedCodexJudgeAskCalls.delete(event.toolCallId);
    return {
      content: [{ type: "text", text: feedback }, ...(event.content ?? [])],
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" && event.toolName !== "bash_escalated") {
      return undefined;
    }
    const executionBoundary = options.executionBoundary?.(event.toolName);
    // Narrow tests and older adapters without the execution layer retain the
    // original strict Bash policy. Production always supplies a boundary.
    if (
      event.toolName === "bash_escalated" &&
      executionBoundary === undefined
    ) {
      return blocked(
        "bash_escalated is unavailable without an execution boundary",
      );
    }
    const effectSandboxed = executionBoundary?.mode === "sandboxed";
    const isEscalated = executionBoundary?.mode === "escalated";
    const evaluationRules = isEscalated ? { ...rules, allow: [] } : rules;
    const sandboxEvaluationOptions = {
      effectSandboxed,
      ...(effectSandboxed && executionBoundary?.writableWorktrees !== undefined
        ? { trustedWritableWorktrees: executionBoundary.writableWorktrees }
        : {}),
      ...(effectSandboxed &&
      executionBoundary?.worktreeCreateRoots !== undefined
        ? { trustedWorktreeCreateRoots: executionBoundary.worktreeCreateRoots }
        : {}),
    };

    try {
      const { input } = event;
      const command = isRecord(input) ? input.command : undefined;
      // A bash call whose command is missing or not a string is malformed;
      // the safety floor blocks it instead of letting it through (fail-closed).
      if (typeof command !== "string") {
        permissionAudit?.addStage(event.toolCallId, {
          type: "deterministic",
          phase: "malformed-input",
          verdict: "deny",
          basis: "parse-error",
          reasonCode: "malformed-input",
          reason: MALFORMED_REASON,
        });
        return finalizeBlocked(
          event.toolCallId,
          "malformed-input",
          MALFORMED_REASON,
        );
      }

      const { signal } = ctx as typeof ctx & {
        signal?: AbortSignal;
      };
      const isAborted = (): boolean =>
        signal !== undefined && "aborted" in signal && signal.aborted === true;

      let projectDiscovery: PermissionProjectContext | undefined;
      let projectResolved = false;
      let gitCwdNavigation: PermissionLeadingNavigation | undefined;
      let gitCwdResolved = false;
      let result = evaluateCommandWithSkillAllows(
        command,
        evaluationRules,
        isEscalated ? [] : activeSkillBashAllows,
        sandboxEvaluationOptions,
      );
      recordDeterministic(event.toolCallId, "initial", result);
      if (result.verdict === "allow" && result.grantedBySkill === true) {
        const gitCwd = skillGrantedGitCwd(command);
        if (
          gitCwd === undefined ||
          (gitCwd !== null && ctx.cwd === undefined)
        ) {
          result = evaluateCommandWithAudit(
            command,
            evaluationRules,
            sandboxEvaluationOptions,
          );
          recordDeterministic(event.toolCallId, "skill-fallback", result);
        } else if (gitCwd !== null && ctx.cwd !== undefined) {
          const candidate = resolve(ctx.cwd, gitCwd);
          projectDiscovery = await discoverProject(ctx.cwd, signal, candidate);
          projectResolved = true;
          gitCwdResolved = true;
          gitCwdNavigation = projectDiscovery.leadingNavigation;
          permissionAudit?.updateContext(event.toolCallId, {
            project: projectDiscovery,
            ...(gitCwdNavigation === undefined
              ? {}
              : { gitCwd: gitCwdNavigation }),
          });
          if (
            projectDiscovery.leadingNavigation?.scope !== "listed-worktree" ||
            !projectDiscovery.leadingNavigation.sameRepository
          ) {
            result = evaluateCommandWithAudit(
              command,
              evaluationRules,
              sandboxEvaluationOptions,
            );
            recordDeterministic(event.toolCallId, "skill-fallback", result);
          }
        }
      }
      if (isAborted()) {
        permissionAudit?.addStage(event.toolCallId, {
          type: "error",
          component: "permission-policy",
          phase: "cancelled",
          verdict: "error",
          reasonCode: "parent-aborted",
        });
        return finalizeBlocked(
          event.toolCallId,
          "parent-aborted",
          "the active pi operation was cancelled",
        );
      }
      if (result.verdict === "deny") {
        return finalizeBlocked(
          event.toolCallId,
          result.audit.reasonCode,
          result.reason,
        );
      }
      const codexStageAuthorization = isEscalated
        ? authorizeCodexStageEscalation(command, codexStageModes)
        : undefined;
      if (codexStageAuthorization !== undefined) {
        const pinnedCommand =
          options.codexStageExecutablePath === undefined
            ? command
            : pinCodexStageCommand(
                command,
                options.codexStageExecutablePath,
                codexStageAuthorization.wrapperIndex,
              );
        if (pinnedCommand === undefined) {
          return finalizeBlocked(
            event.toolCallId,
            "codex-stage-pin-failed",
            "codex-stage executable pin could not be applied",
          );
        }
        permissionAudit?.addStage(event.toolCallId, {
          type: "deterministic",
          phase: "codex-stage-capability",
          verdict: "allow",
          basis: "agent-capability",
          reasonCode: "codex-stage-capability",
        });
        event.input.command = pinnedCommand;
        return undefined;
      }
      const confirm = async (
        title: string,
        reason: string,
        reasonCode: string,
        challengeSource: string,
        feedbackOnAccept?: string,
      ): Promise<{ block: true; reason: string } | undefined> => {
        const status = await requestPermissionConfirmation(
          ctx,
          title,
          `${reason}\n\n${command}`,
          judgeConfig?.confirmTimeoutMs ??
            DEFAULT_PERMISSION_JUDGE_CONFIG.confirmTimeoutMs,
        );
        permissionAudit?.addStage(event.toolCallId, {
          type: "confirmation",
          phase: "permission-policy",
          challengeSource,
          status,
          reasonCode,
          reason,
        });
        if (status === "accepted") {
          if (feedbackOnAccept !== undefined) {
            if (acceptedCodexJudgeAskCalls.size >= 4096) {
              const oldest = acceptedCodexJudgeAskCalls.keys().next().value;
              if (oldest !== undefined)
                acceptedCodexJudgeAskCalls.delete(oldest);
            }
            acceptedCodexJudgeAskCalls.set(event.toolCallId, feedbackOnAccept);
          }
          return undefined;
        }
        return finalizeBlocked(
          event.toolCallId,
          reasonCode,
          confirmationBlockReason(status, reason),
        );
      };

      const route = () =>
        routePermissionCommand({
          command,
          rules,
          ...(executionBoundary === undefined
            ? {}
            : { boundary: executionBoundary }),
          judgeAvailable: judge !== undefined,
          initialResult: result,
          projectResolved,
          ...(projectDiscovery === undefined
            ? {}
            : { project: projectDiscovery }),
          ...(projectDiscovery?.leadingNavigation === undefined
            ? {}
            : { leadingNavigation: projectDiscovery.leadingNavigation }),
          gitCwdResolved,
          ...(gitCwdNavigation === undefined
            ? {}
            : { gitCwd: gitCwdNavigation }),
          onEvaluation: (phase, evaluated) => {
            result = evaluated;
            recordDeterministic(event.toolCallId, phase, evaluated);
          },
        });
      let routingDecision = route();
      while (routingDecision.route === "context") {
        const { requirement, target } = routingDecision;
        if (requirement === "git-c") {
          gitCwdResolved = true;
          if (ctx.cwd !== undefined && target !== undefined) {
            const candidate = resolve(ctx.cwd, target);
            projectDiscovery = await discoverProject(
              ctx.cwd,
              signal,
              candidate,
            );
            projectResolved = true;
            gitCwdNavigation = projectDiscovery.leadingNavigation;
            permissionAudit?.updateContext(event.toolCallId, {
              project: projectDiscovery,
              ...(gitCwdNavigation === undefined
                ? {}
                : { gitCwd: gitCwdNavigation }),
            });
          }
          if (isAborted()) {
            permissionAudit?.addStage(event.toolCallId, {
              type: "error",
              component: "permission-policy",
              phase: "git-c-discovery",
              verdict: "error",
              reasonCode: "parent-aborted",
            });
            return finalizeBlocked(
              event.toolCallId,
              "parent-aborted",
              "the active pi operation was cancelled",
            );
          }
          const verifiedGitCwd =
            gitCwdNavigation?.scope === "listed-worktree" &&
            gitCwdNavigation.sameRepository;
          if (verifiedGitCwd) {
            permissionAudit?.addStage(event.toolCallId, {
              type: "scope",
              phase: "git-c",
              verdict: "allow",
              reasonCode: "git-c-listed-worktree",
              navigation: gitCwdNavigation,
            });
          } else if (isEscalated) {
            permissionAudit?.addStage(event.toolCallId, {
              type: "scope",
              phase: "git-c",
              verdict: "ask",
              reasonCode: "git-c-unverified",
              reason:
                "git -C の対象を登録済みの同一リポジトリworktree内と確認できませんでした",
              ...(gitCwdNavigation === undefined
                ? {}
                : { navigation: gitCwdNavigation }),
            });
          }
        } else {
          projectResolved = true;
          if (ctx.cwd !== undefined) {
            projectDiscovery = await discoverProject(ctx.cwd, signal, target);
            permissionAudit?.updateContext(event.toolCallId, {
              project: projectDiscovery,
              ...(target === undefined ||
              projectDiscovery.leadingNavigation === undefined
                ? {}
                : { leadingNavigation: projectDiscovery.leadingNavigation }),
              ...(gitCwdNavigation === undefined
                ? {}
                : { gitCwd: gitCwdNavigation }),
            });
          }
          if (isAborted()) {
            permissionAudit?.addStage(event.toolCallId, {
              type: "error",
              component: "permission-policy",
              phase: "project-discovery",
              verdict: "error",
              reasonCode: "parent-aborted",
            });
            return finalizeBlocked(
              event.toolCallId,
              "parent-aborted",
              "the active pi operation was cancelled",
            );
          }
          if (target !== undefined) {
            const leadingNavigation = projectDiscovery?.leadingNavigation;
            const verifiedLeadingNavigation =
              leadingNavigation?.scope === "listed-worktree" &&
              leadingNavigation.sameRepository;
            if (verifiedLeadingNavigation) {
              permissionAudit?.addStage(event.toolCallId, {
                type: "scope",
                phase: "leading-navigation",
                verdict: "allow",
                reasonCode: "leading-navigation-listed-worktree",
                navigation: leadingNavigation,
              });
            } else if (isEscalated) {
              permissionAudit?.addStage(event.toolCallId, {
                type: "scope",
                phase: "leading-navigation",
                verdict: "ask",
                reasonCode: "leading-navigation-unverified",
                reason:
                  "登録済みの同一リポジトリworktreeへの移動と確認できませんでした",
                ...(leadingNavigation === undefined
                  ? {}
                  : { navigation: leadingNavigation }),
              });
            }
          }
        }
        routingDecision = route();
      }
      if (routingDecision.route === "mechanical") {
        if (
          routingDecision.phase === "git-c" ||
          routingDecision.phase === "mutation-navigation" ||
          routingDecision.phase === "leading-navigation" ||
          routingDecision.phase === "project-mutation"
        ) {
          let navigation: PermissionLeadingNavigation | undefined;
          if (routingDecision.phase === "git-c") {
            navigation = gitCwdNavigation;
          } else if (routingDecision.phase === "leading-navigation") {
            navigation = projectDiscovery?.leadingNavigation;
          }
          permissionAudit?.addStage(event.toolCallId, {
            type: "scope",
            phase: routingDecision.phase,
            verdict: routingDecision.verdict,
            reasonCode: routingDecision.reasonCode,
            reason: routingDecision.reason,
            ...(navigation === undefined ? {} : { navigation }),
          });
        }
        if (routingDecision.verdict === "deny") {
          return finalizeBlocked(
            event.toolCallId,
            routingDecision.reasonCode,
            routingDecision.reason,
          );
        }
        if (routingDecision.verdict === "allow") return undefined;
        let confirmation = {
          title: "危険なコマンドを実行しますか？",
          challengeSource: "deterministic-policy",
        };
        switch (routingDecision.phase) {
          case "git-c": {
            confirmation = {
              title: "検証できないGit作業場所を使用しますか？",
              challengeSource: "git-c-scope",
            };
            break;
          }
          case "mutation-navigation": {
            confirmation = {
              title: "検証できない移動後のプロジェクト変更を実行しますか？",
              challengeSource: "mutation-navigation",
            };
            break;
          }
          case "leading-navigation": {
            confirmation = {
              title: "プロジェクト外へ移動するコマンドを実行しますか？",
              challengeSource: "leading-navigation",
            };
            break;
          }
          case "project-mutation": {
            confirmation = {
              title: "検証できないプロジェクト変更を実行しますか？",
              challengeSource: "project-mutation",
            };
            break;
          }
          case "codex-judge": {
            confirmation = {
              title:
                routingDecision.reasonCode === "judge-disabled"
                  ? "Sandbox外実行を確認しますか？"
                  : "動的なsandbox内コマンドを実行しますか？",
              challengeSource: "codex-judge",
            };
            break;
          }
        }
        return confirm(
          confirmation.title,
          routingDecision.reason,
          routingDecision.reasonCode,
          confirmation.challengeSource,
        );
      }

      const {
        project,
        leadingNavigation,
        gitCwd: routedGitCwd,
      } = routingDecision;
      if (judge === undefined) {
        throw new Error("permission routing selected an unavailable judge");
      }

      const trackedTask = taskTracker.current();
      const runEvidence = currentRunEvidence(ctx, event.toolCallId);
      const outcome = await judge.judge(command, {
        cwd: ctx.cwd,
        signal,
        ...(trackedTask.correlation === "task"
          ? { task: trackedTask.task }
          : {}),
        taskCorrelation: trackedTask.correlation,
        ...(runEvidence === undefined ? {} : { runEvidence }),
        project,
        ...(leadingNavigation === undefined ? {} : { leadingNavigation }),
        ...(routedGitCwd === undefined ? {} : { gitCwd: routedGitCwd }),
        ...(executionBoundary === undefined
          ? {}
          : {
              executionBoundary: {
                mode: executionBoundary.mode,
                network: executionBoundary.network,
                profileFingerprint: executionBoundary.profileFingerprint,
              },
            }),
        cacheAllowed: !isEscalated,
      });
      let verdict: "allow" | "ask" | "error" = "error";
      if (outcome.kind === "allow") verdict = "allow";
      else if (outcome.kind === "ask") verdict = "ask";
      permissionAudit?.addStage(event.toolCallId, {
        type: "judge",
        phase: "fallback",
        verdict,
        reasonCode: `judge-${outcome.kind}`,
        ...(outcome.kind === "allow" ? {} : { reason: outcome.reason }),
        outcome: outcome.kind,
        ...(outcome.audit === undefined
          ? {}
          : {
              source: outcome.audit.source,
              gates: outcome.audit.gates,
              backend: outcome.audit.backend,
              model: outcome.audit.model,
              reasoningEffort: outcome.audit.reasoningEffort,
              policyVersion: outcome.audit.policyVersion,
            }),
      });
      if (outcome.kind === "allow") {
        if (!outcome.cached) judgeWarningShown = false;
        return undefined;
      }
      if (outcome.kind === "parent-aborted") {
        return finalizeBlocked(
          event.toolCallId,
          "judge-parent-aborted",
          outcome.reason,
        );
      }
      if (outcome.kind === "ask" || outcome.kind === "invalid-response") {
        // A live backend response ends the previous unavailable period even
        // when its verdict still requires confirmation.
        judgeWarningShown = false;
      }
      if (
        JUDGE_WARNING_KINDS.has(outcome.kind) &&
        ctx.hasUI &&
        !judgeWarningShown
      ) {
        judgeWarningShown = true;
        ctx.ui.notify(
          `Codexコマンド判定器を利用できません: ${outcome.reason}`,
          "warning",
        );
      }
      return confirm(
        "Codex判定器が自動承認しませんでした",
        outcome.reason,
        `judge-${outcome.kind}`,
        "codex-judge",
        outcome.kind === "ask" ? CODEX_JUDGE_ASK_FEEDBACK : undefined,
      );
    } catch (error) {
      // Any evaluation or audit-integration failure blocks rather than failing open.
      const reason = `permission-policy: 評価中にエラーが発生したためブロックしました (${String(error)})`;
      permissionAudit?.addStage(event.toolCallId, {
        type: "error",
        component: "permission-policy",
        phase: "evaluation",
        verdict: "error",
        reasonCode: "policy-error",
        message: String(error),
      });
      return finalizeBlocked(event.toolCallId, "policy-error", reason);
    }
  });
};

export default setupPermissionPolicy;
