import type { CtxLike, PiLike } from "../../lib/pi-like";
import {
  CHILD_RUN_COMPLETION_ENTRY,
  BackgroundInvocationManager,
  type BackgroundHost,
} from "./background";
import {
  attachChildRunsDetails,
  extractPersistedChildRuns,
} from "./persistence";
import { ChildRunRegistry } from "./registry";
import { ChildRunsPanelController, type BrowserContextLike } from "./ui";

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
  appendEntry?: BackgroundHost["appendEntry"];
  sendMessage?: BackgroundHost["sendMessage"];
}

interface RuntimeMessageEvent {
  type: "message_start" | "message_end";
  message?: {
    role?: string;
    toolCallId?: string;
    customType?: string;
    details?: unknown;
  };
}

const completionInvocationId = (details: unknown): string | undefined => {
  if (typeof details !== "object" || details === null) return undefined;
  const invocationId = (details as { invocationId?: unknown }).invocationId;
  return typeof invocationId === "string" ? invocationId : undefined;
};

export interface ChildRunsIntegration {
  registry: ChildRunRegistry;
  background?: BackgroundInvocationManager;
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
  const panel = new ChildRunsPanelController(registry);
  const background =
    typeof runtime.appendEntry === "function" &&
    typeof runtime.sendMessage === "function"
      ? new BackgroundInvocationManager(registry, {
          appendEntry: runtime.appendEntry.bind(runtime),
          sendMessage: runtime.sendMessage.bind(runtime),
        })
      : undefined;

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
      await panel.showAndFocus(ctx);
    },
  });

  runtime.registerShortcut("ctrl+alt+s", {
    description: "Show and focus child sessions",
    handler: async (ctx) => {
      await panel.showAndFocus(ctx);
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
    // A background tool result means "accepted", not "completed". The
    // manager archives it only after both child settlement and message_end.
    if (background?.ownsToolCall(event.toolCallId)) return undefined;
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

  runtime.on("message_start", (rawEvent) => {
    const event = rawEvent as RuntimeMessageEvent;
    if (
      event.message?.role === "custom" &&
      event.message.customType === CHILD_RUN_COMPLETION_ENTRY
    ) {
      const invocationId = completionInvocationId(event.message.details);
      if (invocationId !== undefined) {
        background?.acknowledgeNotificationDelivery(invocationId);
      }
    }
  });
  runtime.on("message_end", (rawEvent) => {
    const event = rawEvent as RuntimeMessageEvent;
    if (
      event.message?.role === "toolResult" &&
      typeof event.message.toolCallId === "string"
    ) {
      background?.acknowledgeToolResult(event.message.toolCallId);
    }
  });
  runtime.on("agent_start", () => background?.markAgentStarted());
  runtime.on("agent_settled", () => background?.markAgentSettled());
  runtime.on("session_start", (_event, ctx) => replayBranch(registry, ctx));
  runtime.on("session_before_tree", async () => {
    // This is the last lifecycle point still bound to the old branch, so the
    // abort must happen here to persist there. If a later handler cancels tree
    // navigation, the abort intentionally remains effective.
    await background?.abortAndDrain("branch-change", {
      suppressNotification: true,
    });
  });
  runtime.on("session_tree", (_event, ctx) => replayBranch(registry, ctx));
  runtime.on("session_shutdown", async () => {
    await background?.shutdown();
    panel.dispose();
    registry.dispose();
  });

  return {
    registry,
    background,
    ensureVisible(ctx) {
      panel.ensureVisible(ctx as RuntimeContextLike);
    },
  };
};

export default setupChildRuns;
