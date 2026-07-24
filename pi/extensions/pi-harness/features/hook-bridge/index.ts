import type { HarnessConfig } from "../../config";
import {
  interpretPostToolUse,
  interpretPreToolUse,
  interpretUserPromptSubmit,
  parseHookJson,
  type RawHookResult,
  makePostToolUseStdin,
  makePreToolUseStdin,
  makeUserPromptSubmitStdin,
} from "../../lib/claude-hook-io";
import type { CtxLike, PiLike } from "../../lib/pi-like";
import { runHook } from "../../lib/run-hook";
import { mapToolCall } from "../../lib/tool-map";
import { isTrustedRoot } from "../../lib/trust";
import {
  appendToolResultText,
  joinToolResultText,
  readTargetFilePath,
  readToolResultInput,
  selectMatchingSpecs,
} from "./mapping";
import type { PermissionBlockResult } from "../permission-policy/block";
import {
  PERMISSION_AUDIT_UNAVAILABLE_REASON,
  type PermissionAuditIntegration,
} from "../permission-audit/index";
import { buildRegistry, type BridgeHookSpec } from "./registry";

const hookContinueReasonCode = (raw: RawHookResult): string => {
  if (raw.timedOut) return "hook-timeout";
  if (raw.exitCode !== 0) return "hook-nonzero-exit";
  if (raw.stdout.trim() === "") return "hook-continue";
  const output = parseHookJson(raw.stdout);
  if (output === undefined) return "hook-malformed-output";
  const permissionDecision = output.hookSpecificOutput?.permissionDecision;
  return permissionDecision !== undefined &&
    !["allow", "ask", "deny"].includes(permissionDecision)
    ? "hook-unknown-permission-decision"
    : "hook-continue";
};

export default function setupHookBridge(
  pi: PiLike,
  config: HarnessConfig,
  options?: {
    registry?: BridgeHookSpec[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    blockToolCall?: (reason: string) => PermissionBlockResult;
    permissionAudit?: PermissionAuditIntegration;
    auditPhase?: "preflight" | "remaining";
  },
): void {
  const fullRegistry = options?.registry ?? buildRegistry(config.paths);
  // Child pi processes keep only the deny-side (tool_call) bridge hooks;
  // post-tool and prompt hooks would duplicate the parent's behavior.
  const registry = config.isChild
    ? fullRegistry.filter((spec) => spec.stage === "tool_call")
    : fullRegistry;
  // Resolve the working directory per event, not once at setup: on a resumed
  // session the init-time process.cwd() can point at a different repository
  // than the one the event fired in, which would run trust checks, path
  // resolution, and formatter/typecheck hooks against the wrong tree
  // (review finding).
  const resolveCwd = (ctx: CtxLike): string =>
    ctx.cwd ?? options?.cwd ?? process.cwd();

  pi.on("tool_call", async (event, ctx) => {
    const audit =
      event.toolName === "bash" ? options?.permissionAudit : undefined;
    const auditPhase = options?.auditPhase ?? "remaining";
    const signalAborted = (): boolean =>
      ctx.signal !== undefined &&
      "aborted" in ctx.signal &&
      ctx.signal.aborted === true;
    const block = (reason: string): PermissionBlockResult =>
      options?.blockToolCall?.(reason) ?? { block: true, reason };
    const finalizeBlock = async (
      reasonCode: string,
      reason: string,
    ): Promise<PermissionBlockResult> => {
      if (audit === undefined) return block(reason);
      return (await audit.finalizeBlock(event.toolCallId, reasonCode))
        ? block(reason)
        : block(PERMISSION_AUDIT_UNAVAILABLE_REASON);
    };

    try {
      const cwd = resolveCwd(ctx);
      const invocation = mapToolCall(event.toolName, event.input);
      const specs = selectMatchingSpecs(
        registry,
        "tool_call",
        invocation.toolName,
      );

      for (const spec of specs) {
        const raw = await runHook(
          spec.script,
          JSON.stringify(makePreToolUseStdin(invocation, cwd)),
          {
            cwd,
            env: options?.env,
            timeoutMs: spec.timeoutMs,
            maxOutputBytes: spec.maxOutputBytes,
          },
        );
        const outcome = interpretPreToolUse(raw);
        if (outcome.notify !== undefined) {
          ctx.ui.notify(outcome.notify.message, outcome.notify.level);
        }
        if (outcome.kind === "block") {
          const reason =
            outcome.reason ?? "A PreToolUse hook blocked this tool call.";
          audit?.addStage(event.toolCallId, {
            type: "hook",
            phase: auditPhase,
            hookId: spec.id,
            verdict: "deny",
            reasonCode: "hook-deny",
            reason,
          });
          return finalizeBlock("hook-deny", reason);
        }
        if (outcome.kind === "ask") {
          const reason =
            outcome.reason ?? "A PreToolUse hook requires confirmation.";
          audit?.addStage(event.toolCallId, {
            type: "hook",
            phase: auditPhase,
            hookId: spec.id,
            verdict: "ask",
            reasonCode: "hook-ask",
            reason,
          });
          const confirmed = ctx.hasUI
            ? await ctx.ui.confirm("Hook permission request", reason, {
                signal: ctx.signal,
              })
            : false;
          const status = !ctx.hasUI
            ? ("not-shown" as const)
            : signalAborted()
              ? ("aborted" as const)
              : confirmed
                ? ("accepted" as const)
                : ("rejected" as const);
          audit?.addStage(event.toolCallId, {
            type: "confirmation",
            phase: auditPhase,
            challengeSource: `hook:${spec.id}`,
            status,
            reasonCode: "hook-ask",
            reason,
          });
          if (!confirmed || signalAborted()) {
            return finalizeBlock("hook-ask", reason);
          }
          continue;
        }
        const reasonCode = hookContinueReasonCode(raw);
        const reason =
          outcome.reason ??
          (reasonCode === "hook-continue"
            ? undefined
            : outcome.notify?.message);
        audit?.addStage(event.toolCallId, {
          type: "hook",
          phase: auditPhase,
          hookId: spec.id,
          verdict: "continue",
          reasonCode,
          ...(reason === undefined ? {} : { reason }),
        });
      }

      return undefined;
    } catch (error) {
      const reason = `PreToolUse hook failed: ${String(error)}`;
      audit?.addStage(event.toolCallId, {
        type: "error",
        component: "hook-bridge",
        phase: auditPhase,
        verdict: "error",
        reasonCode: "hook-error",
        message: String(error),
      });
      return finalizeBlock("hook-error", reason);
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return undefined;

    const cwd = resolveCwd(ctx);
    const invocation = mapToolCall(event.toolName, readToolResultInput(event));
    const specs = selectMatchingSpecs(
      registry,
      "tool_result",
      invocation.toolName,
    );
    const response = {
      content: joinToolResultText(event.content),
      isError: false,
    };
    const additions: string[] = [];

    // Trust must hold for BOTH the session cwd and the edited file's own
    // location: hooks like coding_cycle discover package.json upward from
    // the target file, so a write into an untrusted directory from a
    // trusted cwd would otherwise execute that directory's scripts.
    const targetPath = readTargetFilePath(invocation.toolInput, cwd);
    const trusted =
      isTrustedRoot(cwd, config.trust) &&
      (targetPath === undefined || isTrustedRoot(targetPath, config.trust));

    for (const spec of specs) {
      if (spec.requiresTrust && !trusted) continue;
      const raw = await runHook(
        spec.script,
        JSON.stringify(makePostToolUseStdin(invocation, cwd, response)),
        {
          cwd,
          env: options?.env,
          timeoutMs: spec.timeoutMs,
          maxOutputBytes: spec.maxOutputBytes,
        },
      );
      const outcome = interpretPostToolUse(raw);
      if (outcome.notify !== undefined) {
        ctx.ui.notify(outcome.notify.message, outcome.notify.level);
      }
      if (outcome.additionalText !== undefined) {
        additions.push(outcome.additionalText);
      }
    }

    return appendToolResultText(event.content, additions);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = resolveCwd(ctx);
    const specs = selectMatchingSpecs(registry, "before_agent_start");
    for (const spec of specs) {
      const raw = await runHook(
        spec.script,
        JSON.stringify(makeUserPromptSubmitStdin(event.prompt, cwd)),
        {
          cwd,
          env: options?.env,
          timeoutMs: spec.timeoutMs,
          maxOutputBytes: spec.maxOutputBytes,
        },
      );
      const outcome = interpretUserPromptSubmit(raw);
      if (outcome.additionalContext !== undefined) {
        return {
          message: {
            customType: "pi-harness-hook-bridge",
            content: outcome.additionalContext,
            display: false,
          },
        };
      }
    }

    return undefined;
  });
}
