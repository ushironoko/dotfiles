import type { HarnessConfig } from "../../config";
import {
  interpretPostToolUse,
  interpretPreToolUse,
  interpretUserPromptSubmit,
  makePostToolUseStdin,
  makePreToolUseStdin,
  makeUserPromptSubmitStdin,
} from "../../lib/claude-hook-io";
import type { PiLike } from "../../lib/pi-like";
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
import { buildRegistry, type BridgeHookSpec } from "./registry";

export default function setupHookBridge(
  pi: PiLike,
  config: HarnessConfig,
  options?: {
    registry?: BridgeHookSpec[];
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
): void {
  const fullRegistry = options?.registry ?? buildRegistry(config.paths);
  // Child pi processes keep only the deny-side (tool_call) bridge hooks;
  // post-tool and prompt hooks would duplicate the parent's behavior.
  const registry = config.isChild
    ? fullRegistry.filter((spec) => spec.stage === "tool_call")
    : fullRegistry;
  const cwd = options?.cwd ?? process.cwd();

  pi.on("tool_call", async (event, ctx) => {
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
        return {
          block: true,
          reason: outcome.reason ?? "A PreToolUse hook blocked this tool call.",
        };
      }
      if (outcome.kind === "ask") {
        const reason =
          outcome.reason ?? "A PreToolUse hook requires confirmation.";
        const confirmed = ctx.hasUI
          ? await ctx.ui.confirm("Hook permission request", reason)
          : false;
        if (!confirmed) return { block: true, reason };
      }
    }

    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return undefined;

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

  pi.on("before_agent_start", async (event) => {
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
