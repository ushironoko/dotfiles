import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PiLike } from "../../lib/pi-like";
import {
  DEFAULT_PERMISSION_JUDGE_CONFIG,
  type HarnessConfig,
} from "../../config";
import {
  CHILD_PERMISSION_SIGNAL_ENV,
  formatChildPermissionSignal,
} from "./block";
import { createPermissionJudge, type JudgeOutcome } from "./judge";
import { evaluateCommand, loadRules } from "./rules";

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
  permissionSignalToken?: string;
  writePermissionSignal?: (text: string) => void;
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
  const permissionSignalToken =
    options.permissionSignalToken ?? process.env[CHILD_PERMISSION_SIGNAL_ENV];
  if (config.isChild && options.permissionSignalToken === undefined) {
    // Keep the per-spawn token in this closure; child tools and grandchildren
    // must not inherit the diagnostic authenticator from process.env.
    delete process.env[CHILD_PERMISSION_SIGNAL_ENV];
  }
  const writePermissionSignal =
    options.writePermissionSignal ?? ((text: string) => writeSync(2, text));
  const blocked = (reason: string): { block: true; reason: string } => {
    if (config.isChild) {
      const signal = formatChildPermissionSignal(permissionSignalToken);
      if (signal !== undefined) {
        try {
          writePermissionSignal(`${signal}\n`);
        } catch {
          // A diagnostic side-channel failure must never unblock the command.
        }
      }
    }
    return { block: true, reason };
  };

  pi.on("session_shutdown", () => {
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

      const result = evaluateCommand(command, rules);
      if (result.verdict === "deny") {
        return blocked(result.reason);
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
        if (!ctx.hasUI || isAborted()) return blocked(reason);
        const confirmed = await ctx.ui.confirm(
          title,
          `${reason}\n\n${command}`,
          {
            signal,
            timeout:
              judgeConfig?.confirmTimeoutMs ??
              DEFAULT_PERMISSION_JUDGE_CONFIG.confirmTimeoutMs,
          },
        );
        return confirmed && !isAborted() ? undefined : blocked(reason);
      };

      if (result.verdict === "ask") {
        return confirm("危険なコマンドを実行しますか？", result.reason);
      }
      if (result.verdict === "allow" || judge === undefined) return undefined;

      const outcome = await judge.judge(command, {
        cwd: ctx.cwd,
        signal,
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
