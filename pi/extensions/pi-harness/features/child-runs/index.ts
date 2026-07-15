import type { CtxLike, PiLike } from "../../lib/pi-like";
import {
  attachChildRunsDetails,
  extractPersistedChildRuns,
} from "./persistence";
import { ChildRunRegistry } from "./registry";
import { ChildRunsOverlayController, type BrowserContextLike } from "./ui";

interface RuntimeContextLike extends BrowserContextLike {
  sessionManager?: {
    getBranch(): unknown[];
  };
}

interface RuntimeToolResultEvent {
  type: "tool_result";
  toolName: string;
  toolCallId?: string;
  details?: unknown;
  isError?: boolean;
}

interface RuntimePiLike {
  on(
    event: string,
    handler: (event: unknown, ctx: RuntimeContextLike) => unknown,
  ): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: RuntimeContextLike) => Promise<void>;
    },
  ): void;
  registerShortcut(
    shortcut: string,
    options: {
      description?: string;
      handler: (ctx: RuntimeContextLike) => Promise<void> | void;
    },
  ): void;
}

export interface ChildRunsIntegration {
  registry: ChildRunRegistry;
  ensureVisible(ctx: CtxLike): void;
}

const replayBranch = (
  registry: ChildRunRegistry,
  ctx: RuntimeContextLike,
): void => {
  const branch = ctx.sessionManager?.getBranch();
  if (branch === undefined) return;
  registry.replacePersistedHistory(extractPersistedChildRuns(branch));
};

const setupChildRuns = (pi: PiLike): ChildRunsIntegration => {
  const runtime = pi as unknown as RuntimePiLike;
  const registry = new ChildRunRegistry();
  const overlay = new ChildRunsOverlayController(registry);

  runtime.registerCommand("subagents", {
    description: "Show and focus the live child-session browser",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "The child-session browser requires TUI mode.",
            "warning",
          );
        }
        return;
      }
      await overlay.showAndFocus(ctx);
    },
  });

  runtime.registerShortcut("ctrl+alt+s", {
    description: "Show and focus child sessions",
    handler: async (ctx) => {
      await overlay.showAndFocus(ctx);
    },
  });

  runtime.on("tool_result", (rawEvent) => {
    const event = rawEvent as RuntimeToolResultEvent;
    if (
      (event.toolName !== "subagent" && event.toolName !== "workflow") ||
      typeof event.toolCallId !== "string"
    ) {
      return undefined;
    }
    const invocationId = registry.getInvocationIdForToolCall(event.toolCallId);
    if (invocationId === undefined) return undefined;
    registry.terminalizeInvocation(
      invocationId,
      { status: "skipped", reason: "dependency-failed" },
      { status: "failed", reason: "setup-error" },
    );
    const childRuns = registry.completeToolCall(event.toolCallId);
    if (childRuns === undefined) return undefined;
    return {
      details: attachChildRunsDetails(event.details, childRuns),
    };
  });

  runtime.on("session_start", (_event, ctx) => replayBranch(registry, ctx));
  runtime.on("session_tree", (_event, ctx) => replayBranch(registry, ctx));
  runtime.on("session_shutdown", () => {
    overlay.dispose();
    registry.dispose();
  });

  return {
    registry,
    ensureVisible(ctx) {
      overlay.ensureVisible(ctx as RuntimeContextLike);
    },
  };
};

export default setupChildRuns;
