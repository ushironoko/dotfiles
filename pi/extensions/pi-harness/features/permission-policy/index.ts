import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PiLike } from "../../lib/pi-like";
import type { HarnessConfig } from "../../config";
import {
  createPermissionTaskTracker,
  discoverProjectContext,
  type PermissionProjectContext,
} from "./context";
import { createPermissionJudge, type JudgeOutcome } from "./judge";
import { evaluateCommand, loadRules } from "./rules";
import { resolveTrustedLeadingCd } from "./trusted-cd";

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

const JUDGE_WARNING_KINDS: ReadonlySet<JudgeOutcome["kind"]> = new Set([
  "timeout",
  "unavailable",
]);

interface SetupPermissionPolicyOptions {
  readonly discoverProject?: (
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<PermissionProjectContext>;
}

const setupPermissionPolicy = (
  pi: PiLike,
  config: HarnessConfig,
  options: SetupPermissionPolicyOptions = {},
): void => {
  const rules = loadRules(readPermissionRules());
  const judgeConfig = config.permissionJudge;
  const judge =
    judgeConfig?.enabled === true
      ? createPermissionJudge(judgeConfig)
      : undefined;
  let judgeWarningShown = false;
  const taskTracker = createPermissionTaskTracker();
  const discoverProject =
    options.discoverProject ??
    ((cwd: string, signal?: AbortSignal) =>
      discoverProjectContext(cwd, {}, signal));

  pi.on("input", (event) => {
    taskTracker.capture({
      text: event.text,
      source: event.source,
      ...(event.streamingBehavior === undefined
        ? {}
        : { streamingBehavior: event.streamingBehavior }),
    });
  });
  pi.on("before_agent_start", (event) => {
    taskTracker.activate(event.prompt);
  });
  pi.on("context", (event) => {
    // Steering/follow-up messages can enter an already-running agent without
    // another before_agent_start. Correlate their final user message with the
    // raw input record before the provider sees the next turn.
    taskTracker.activateFromMessages(event.messages);
  });
  pi.on("agent_settled", () => {
    taskTracker.settle();
  });
  pi.on("session_shutdown", () => {
    taskTracker.clear();
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
        return { block: true, reason: MALFORMED_REASON };
      }

      let result = evaluateCommand(command, rules);
      if (result.verdict === "deny") {
        return { block: true, reason: result.reason };
      }
      const signal = (
        ctx as typeof ctx & {
          signal?: AbortSignal;
        }
      ).signal;
      const isAborted = (): boolean =>
        signal !== undefined && "aborted" in signal && signal.aborted === true;
      const confirm = async (
        title: string,
        reason: string,
      ): Promise<{ block: true; reason: string } | undefined> => {
        if (!ctx.hasUI || isAborted()) return { block: true, reason };
        const confirmed = await ctx.ui.confirm(
          title,
          `${reason}\n\n${command}`,
          { signal },
        );
        return confirmed && !isAborted() ? undefined : { block: true, reason };
      };

      if (result.verdict === "ask") {
        return confirm("危険なコマンドを実行しますか？", result.reason);
      }
      if (result.verdict === "allow" || judge === undefined) return undefined;

      // Preserve deny/ask precedence above. Only a command that would
      // otherwise reach the local judge can gain the narrow same-repository
      // cd optimization.
      if (ctx.cwd !== undefined) {
        const trustedLeadingCdTarget = await resolveTrustedLeadingCd(
          command,
          ctx.cwd,
        );
        if (trustedLeadingCdTarget !== undefined) {
          result = evaluateCommand(command, rules, {
            trustedLeadingCdTarget,
          });
          if (result.verdict === "allow") return undefined;
        }
      }

      let project: PermissionProjectContext | undefined;
      if (ctx.cwd !== undefined) {
        try {
          project = await discoverProject(ctx.cwd, signal);
        } catch {
          // Project context improves classification but never grants on its
          // own. An adapter failure is represented as unverified context.
        }
      }
      const outcome = await judge.judge(command, {
        cwd: ctx.cwd,
        signal,
        task: taskTracker.current(),
        project,
      });
      if (outcome.kind === "allow") {
        if (!outcome.cached) judgeWarningShown = false;
        return undefined;
      }
      if (outcome.kind === "parent-aborted") {
        return { block: true, reason: outcome.reason };
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
      return {
        block: true,
        reason: `permission-policy: 評価中にエラーが発生したためブロックしました (${String(error)})`,
      };
    }
  });
};

export default setupPermissionPolicy;
