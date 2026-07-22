import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InputEvent, PiLike } from "../../lib/pi-like";
import type { HarnessConfig } from "../../config";
import { createPermissionBlocker, type PermissionBlockResult } from "./block";
import { appendCommandHygiene } from "./command-hygiene";
import {
  createPermissionTaskTracker,
  derivePermissionRunEvidence,
  discoverProjectContext,
  type PermissionLeadingNavigation,
  type PermissionProjectContext,
  type PermissionRunEvidence,
} from "./context";
import { createPermissionJudge, type JudgeOutcome } from "./judge";
import {
  evaluateCommand,
  gitReadCwdTarget,
  hasProjectSensitiveMutation,
  hasUnverifiedProjectMutationNavigation,
  loadRules,
  type AllowRule,
  type LoadedRules,
} from "./rules";
import {
  createActiveSkillBashAllowResolver,
  evaluateCommandWithSkillAllows,
  parseSkillInvocation,
  skillGrantedGitCwd,
  type ActiveSkillBashAllowResolver,
  type SkillInvocation,
} from "./skill-allow";
import { leadingTrustedCdTarget } from "./trusted-cd";

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
}

const setupPermissionPolicy = (
  pi: PiLike,
  config: HarnessConfig,
  options: SetupPermissionPolicyOptions = {},
): void => {
  const rules = options.rules ?? loadRules(readPermissionRules());
  const judgeConfig = config.permissionJudge;
  const judge =
    judgeConfig?.enabled === true
      ? createPermissionJudge(judgeConfig)
      : undefined;
  const taskTracker = createPermissionTaskTracker();
  const discoverProject =
    options.discoverProject ??
    ((cwd: string, signal?: AbortSignal, leadingCdTarget?: string) =>
      discoverProjectContext(
        cwd,
        leadingCdTarget === undefined ? {} : { leadingCdTarget },
        signal,
      ));
  let judgeWarningShown = false;
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
    return typeof event.systemPrompt === "string"
      ? { systemPrompt: appendCommandHygiene(event.systemPrompt) }
      : undefined;
  });

  pi.on("agent_settled", () => {
    taskTracker.settle();
    clearSkillLifecycle();
  });

  pi.on("session_shutdown", () => {
    taskTracker.clear();
    clearSkillLifecycle();
    judge?.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    try {
      const input: unknown = event.input;
      const command = isRecord(input) ? input.command : undefined;
      // A bash call whose command is missing or not a string is malformed;
      // the safety floor blocks it instead of letting it through (fail-closed).
      if (typeof command !== "string") {
        return blocked(MALFORMED_REASON);
      }

      const signal = (
        ctx as typeof ctx & {
          signal?: AbortSignal;
        }
      ).signal;
      const isAborted = (): boolean =>
        signal !== undefined && "aborted" in signal && signal.aborted === true;

      let projectDiscovery: PermissionProjectContext | undefined;
      let gitCwdNavigation: PermissionLeadingNavigation | undefined;
      let trustedGitReadCwdTarget: string | undefined;
      let result = evaluateCommandWithSkillAllows(
        command,
        rules,
        activeSkillBashAllows,
      );
      if (result.verdict === "allow" && result.grantedBySkill === true) {
        const gitCwd = skillGrantedGitCwd(command);
        if (
          gitCwd === undefined ||
          (gitCwd !== null && ctx.cwd === undefined)
        ) {
          result = evaluateCommand(command, rules);
        } else if (gitCwd !== null && ctx.cwd !== undefined) {
          const candidate = resolve(ctx.cwd, gitCwd);
          projectDiscovery = await discoverProject(ctx.cwd, signal, candidate);
          if (
            projectDiscovery.leadingNavigation?.scope !== "listed-worktree" ||
            !projectDiscovery.leadingNavigation.sameRepository
          ) {
            result = evaluateCommand(command, rules);
          }
        }
      }
      if (isAborted()) {
        return blocked("the active pi operation was cancelled");
      }
      if (result.verdict === "deny") {
        return blocked(result.reason);
      }
      const confirm = async (
        title: string,
        reason: string,
      ): Promise<{ block: true; reason: string } | undefined> => {
        if (!ctx.hasUI || isAborted()) return blocked(reason);
        const confirmed = await ctx.ui.confirm(
          title,
          `${reason}\n\n${command}`,
          { signal },
        );
        return confirmed && !isAborted() ? undefined : blocked(reason);
      };

      if (result.verdict === "ask") {
        const readCwdTarget = gitReadCwdTarget(command);
        if (readCwdTarget !== undefined && ctx.cwd !== undefined) {
          const candidate = resolve(ctx.cwd, readCwdTarget);
          projectDiscovery = await discoverProject(ctx.cwd, signal, candidate);
          if (isAborted()) {
            return blocked("the active pi operation was cancelled");
          }
          gitCwdNavigation = projectDiscovery.leadingNavigation;
          if (
            gitCwdNavigation?.scope !== "listed-worktree" ||
            !gitCwdNavigation.sameRepository
          ) {
            return confirm(
              "検証できないGit作業場所を使用しますか？",
              "git -C の対象を登録済みの同一リポジトリworktree内と確認できませんでした",
            );
          }
          trustedGitReadCwdTarget = readCwdTarget;
          result = evaluateCommand(command, rules, {
            trustedGitCwdTarget: readCwdTarget,
          });
        }
      }
      if (result.verdict === "deny") return blocked(result.reason);
      if (result.verdict === "ask") {
        return confirm("危険なコマンドを実行しますか？", result.reason);
      }

      const leadingCdTarget = leadingTrustedCdTarget(command);
      const projectSensitiveMutation = hasProjectSensitiveMutation(command);
      const unverifiedMutationNavigation =
        hasUnverifiedProjectMutationNavigation(
          command,
          leadingCdTarget !== undefined,
        );
      if (unverifiedMutationNavigation) {
        return confirm(
          "検証できない移動後のプロジェクト変更を実行しますか？",
          "プロジェクト変更前の作業場所を検証できないため確認が必要です",
        );
      }
      // Context-free allows remain cheap, but an allow cannot bypass verified
      // leading navigation or the verified-project floor for a Git mutation.
      if (
        result.verdict === "allow" &&
        leadingCdTarget === undefined &&
        !projectSensitiveMutation
      ) {
        return undefined;
      }
      if (
        judge === undefined &&
        leadingCdTarget === undefined &&
        !projectSensitiveMutation
      ) {
        return undefined;
      }
      const project =
        ctx.cwd === undefined
          ? undefined
          : (projectDiscovery ??
            (await discoverProject(ctx.cwd, signal, leadingCdTarget)));
      if (isAborted()) {
        return blocked("the active pi operation was cancelled");
      }
      const leadingNavigation =
        leadingCdTarget === undefined ? undefined : project?.leadingNavigation;
      if (
        leadingCdTarget !== undefined &&
        (leadingNavigation?.scope !== "listed-worktree" ||
          !leadingNavigation.sameRepository)
      ) {
        return confirm(
          "プロジェクト外へ移動するコマンドを実行しますか？",
          "登録済みの同一リポジトリworktreeへの移動と確認できませんでした",
        );
      }
      if (
        projectSensitiveMutation &&
        (project === undefined || project.kind === "unavailable")
      ) {
        return confirm(
          "検証できないプロジェクト変更を実行しますか？",
          "プロジェクト境界を検証できないため変更コマンドには確認が必要です",
        );
      }
      if (result.verdict === "allow") return undefined;

      const trustedLeadingCdTarget =
        leadingCdTarget !== undefined &&
        leadingNavigation?.scope === "listed-worktree" &&
        leadingNavigation.sameRepository
          ? leadingCdTarget
          : undefined;
      const trustedReadContext =
        project?.kind === "git"
          ? {
              cwd: trustedLeadingCdTarget ?? project.cwd,
              navigableRoots: project.navigableRoots,
            }
          : undefined;
      if (
        trustedLeadingCdTarget !== undefined ||
        trustedReadContext !== undefined
      ) {
        result = evaluateCommand(command, rules, {
          ...(trustedLeadingCdTarget === undefined
            ? {}
            : { trustedLeadingCdTarget }),
          ...(trustedGitReadCwdTarget === undefined
            ? {}
            : { trustedGitCwdTarget: trustedGitReadCwdTarget }),
          ...(trustedReadContext === undefined ? {} : { trustedReadContext }),
        });
        if (result.verdict === "deny") return blocked(result.reason);
        if (result.verdict === "ask") {
          return confirm("危険なコマンドを実行しますか？", result.reason);
        }
        if (result.verdict === "allow") return undefined;
      }
      if (judge === undefined) return undefined;

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
        ...(gitCwdNavigation === undefined ? {} : { gitCwd: gitCwdNavigation }),
      });
      if (outcome.kind === "allow") {
        if (!outcome.cached) judgeWarningShown = false;
        return undefined;
      }
      if (outcome.kind === "parent-aborted") {
        return blocked(outcome.reason);
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
          `ローカルコマンド判定器を利用できません: ${outcome.reason}`,
          "warning",
        );
      }
      return confirm("ローカル判定器が自動承認しませんでした", outcome.reason);
    } catch (error) {
      // Any evaluation failure blocks rather than failing open.
      return blocked(
        `permission-policy: 評価中にエラーが発生したためブロックしました (${String(error)})`,
      );
    }
  });
};

export default setupPermissionPolicy;
