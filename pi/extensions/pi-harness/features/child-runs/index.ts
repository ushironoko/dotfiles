import type { CtxLike, PiLike } from "../../lib/pi-like";
import { BitIssueCli } from "../bit-issues/cli";
import { BitIssueRegistry } from "../bit-issues/registry";
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
  isIdle?: () => boolean;
}

interface RuntimeToolResultEvent {
  type: "tool_result";
  toolName: string;
  toolCallId?: string;
  details?: unknown;
  isError?: boolean;
}

interface RuntimeBeforeAgentStartEvent {
  systemPrompt?: unknown;
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

interface RuntimeSessionBeforeTreeEvent {
  type: "session_before_tree";
  signal?: AbortSignal;
}

interface PendingTreeTransition {
  token: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  aborted: boolean;
  released: boolean;
}

const completionInvocationId = (details: unknown): string | undefined => {
  if (typeof details !== "object" || details === null) return undefined;
  const invocationId = (details as { invocationId?: unknown }).invocationId;
  return typeof invocationId === "string" ? invocationId : undefined;
};

const BACKGROUND_AGENT_SYSTEM_PROMPT = `## Background agent completion

The subagent and workflow tools run child agents asynchronously. After either tool accepts a background invocation, never use sleep, shell polling, repeated status checks, or any other blocking or waiting call to wait for it. Pi delivers completion automatically as a new message and starts the continuation turn. Continue only work that is independent of the child; otherwise end the current response and return control to Pi.`;

const appendBackgroundAgentSystemPrompt = (systemPrompt: string): string =>
  systemPrompt === ""
    ? BACKGROUND_AGENT_SYSTEM_PROMPT
    : `${systemPrompt}\n\n${BACKGROUND_AGENT_SYSTEM_PROMPT}`;

export interface ChildRunsIntegration {
  registry: ChildRunRegistry;
  bitIssues?: BitIssueRegistry;
  background?: BackgroundInvocationManager;
  ensureVisible(ctx: CtxLike): void;
}

export interface SetupChildRunsOptions {
  readonly bitIssues?: boolean;
  readonly bitIssueCli?: BitIssueCli;
  readonly childExecution?: boolean;
}

const replayBranch = (
  registry: ChildRunRegistry,
  ctx: RuntimeContextLike,
): void => {
  const branch = ctx.sessionManager?.getBranch();
  if (branch === undefined) return;
  registry.replacePersistedHistory(extractPersistedChildRuns(branch));
};

const setupChildRuns = (
  pi: PiLike,
  options: SetupChildRunsOptions = {},
): ChildRunsIntegration => {
  const runtime = pi as unknown as RuntimePiLike;
  const registry = new ChildRunRegistry();
  const bitIssues = options.bitIssues
    ? new BitIssueRegistry({ cli: options.bitIssueCli })
    : undefined;
  let activeContext: RuntimeContextLike | undefined;
  let lastExplicitWarning: string | undefined;
  const refreshBitIssues = async (
    ctx: RuntimeContextLike,
    explicit: boolean = false,
  ): Promise<void> => {
    if (bitIssues === undefined) return;
    const cwd = ctx.cwd ?? process.cwd();
    const outcome = await bitIssues.refresh(cwd);
    if (outcome.ok) {
      lastExplicitWarning = undefined;
      if (outcome.count > 0) panel.ensureVisibleForIssues(ctx);
      return;
    }
    if (explicit) {
      const warning = `${outcome.kind}:${outcome.message}`;
      if (warning !== lastExplicitWarning) {
        lastExplicitWarning = warning;
        ctx.ui.notify(
          `Open bit issues unavailable: ${outcome.message}`,
          "warning",
        );
      }
    }
  };
  const panel = new ChildRunsPanelController(registry, {
    bitIssues,
    refreshBitIssues: async () => {
      if (activeContext !== undefined) await refreshBitIssues(activeContext);
    },
  });
  const background =
    options.childExecution !== false &&
    typeof runtime.appendEntry === "function" &&
    typeof runtime.sendMessage === "function"
      ? new BackgroundInvocationManager(registry, {
          appendEntry: runtime.appendEntry.bind(runtime),
          sendMessage: runtime.sendMessage.bind(runtime),
        })
      : undefined;
  const pendingTreeTransitions: PendingTreeTransition[] = [];
  const releaseTreeTransition = (entry: PendingTreeTransition): void => {
    if (entry.released) return;
    entry.released = true;
    if (
      entry.signal !== undefined &&
      entry.onAbort !== undefined &&
      "removeEventListener" in entry.signal &&
      typeof entry.signal.removeEventListener === "function"
    ) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    const index = pendingTreeTransitions.indexOf(entry);
    if (index !== -1) pendingTreeTransitions.splice(index, 1);
    background?.completeBranchTransition(entry.token);
  };
  const clearTreeTransitions = (): void => {
    while (pendingTreeTransitions.length > 0) {
      const entry = pendingTreeTransitions.at(-1);
      if (entry === undefined) break;
      releaseTreeTransition(entry);
    }
    background?.resetBranchTransitions();
  };

  runtime.registerCommand("subagents", {
    description: "Show and focus the live child-session browser",
    handler: async (_args, ctx) => {
      activeContext = ctx;
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "The child-session browser requires TUI mode.",
            "warning",
          );
        }
        return;
      }
      await panel.showAndFocus(ctx, "child");
    },
  });

  runtime.registerShortcut("ctrl+alt+s", {
    description: "Show and focus child sessions",
    handler: async (ctx) => {
      activeContext = ctx;
      await panel.showAndFocus(ctx, "child");
    },
  });

  if (bitIssues !== undefined) {
    runtime.registerCommand("bit-issues", {
      description: "Refresh, show, and focus open local bit issues",
      handler: async (_args, ctx) => {
        activeContext = ctx;
        if (ctx.mode !== "tui") {
          if (ctx.hasUI) {
            ctx.ui.notify(
              "The bit issue browser requires TUI mode.",
              "warning",
            );
          }
          return;
        }
        await refreshBitIssues(ctx, true);
        await panel.showAndFocus(ctx, "issue", false);
      },
    });

    runtime.registerShortcut("ctrl+alt+i", {
      description: "Refresh, show, and focus open local bit issues",
      handler: async (ctx) => {
        activeContext = ctx;
        await refreshBitIssues(ctx, true);
        await panel.showAndFocus(ctx, "issue", false);
      },
    });
  }

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
  runtime.on("before_agent_start", (rawEvent) => {
    background?.markAgentPreflightStarted();
    if (background === undefined) return undefined;

    const event = rawEvent as RuntimeBeforeAgentStartEvent;
    if (typeof event.systemPrompt !== "string") return undefined;
    return {
      systemPrompt: appendBackgroundAgentSystemPrompt(event.systemPrompt),
    };
  });
  runtime.on("agent_start", () => background?.markAgentStarted());
  runtime.on("agent_settled", (_event, ctx) => {
    activeContext = ctx;
    const idle = typeof ctx.isIdle !== "function" || ctx.isIdle();
    background?.markAgentSettled(idle);
    void refreshBitIssues(ctx);
  });
  runtime.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    clearTreeTransitions();
    replayBranch(registry, ctx);
    if (bitIssues !== undefined) {
      bitIssues.beginSession(ctx.cwd ?? process.cwd());
      void refreshBitIssues(ctx);
    }
  });
  runtime.on("session_before_tree", async (rawEvent) => {
    // Serialize navigation boundaries. Pi does not correlate session_tree with
    // its originating pre-tree event, so admitting an overlapping transition
    // would make exact guard release impossible.
    if (pendingTreeTransitions.length > 0) return { cancel: true };

    // This is the last lifecycle point still bound to the old branch, so the
    // abort must happen here to persist there. Unsent completions are dropped.
    // Pi has no extension API for retracting an already handed-off message, so
    // keep the branch fixed until that notification-triggered turn settles.
    const event = rawEvent as RuntimeSessionBeforeTreeEvent;
    const token = background?.beginBranchTransition();
    const pending: PendingTreeTransition | undefined =
      token === undefined
        ? undefined
        : {
            token,
            signal: event.signal,
            aborted: false,
            released: false,
          };
    if (
      pending !== undefined &&
      pending.signal !== undefined &&
      "addEventListener" in pending.signal &&
      typeof pending.signal.addEventListener === "function"
    ) {
      // Signal abort is only a request while later pre-tree handlers may still
      // provide a custom summary and commit navigation. Keep the token until
      // this handler can return cancel or session_tree confirms the outcome.
      pending.onAbort = () => {
        pending.aborted = true;
      };
      pending.signal.addEventListener("abort", pending.onAbort, { once: true });
      if ("aborted" in pending.signal && pending.signal.aborted === true) {
        pending.onAbort();
      }
    }
    if (pending !== undefined && !pending.released) {
      pendingTreeTransitions.push(pending);
    }

    await background?.abortAndDrain("branch-change", {
      suppressNotification: true,
      branchTransitionToken: token,
    });
    if (pending?.aborted) {
      releaseTreeTransition(pending);
      return { cancel: true };
    }
    if (pending?.released) return { cancel: true };
    if (background?.shouldCancelBranchNavigation()) {
      if (pending !== undefined) releaseTreeTransition(pending);
      return { cancel: true };
    }
    return undefined;
  });
  runtime.on("session_tree", (_event, ctx) => {
    replayBranch(registry, ctx);
    const [pending] = pendingTreeTransitions;
    if (pending !== undefined) releaseTreeTransition(pending);
    else background?.completeBranchTransition();
  });
  runtime.on("session_shutdown", async () => {
    activeContext = undefined;
    clearTreeTransitions();
    await background?.shutdown();
    panel.dispose();
    bitIssues?.dispose();
    registry.dispose();
  });

  return {
    registry,
    bitIssues,
    background,
    ensureVisible(ctx) {
      panel.ensureVisible(ctx as RuntimeContextLike);
    },
  };
};

export default setupChildRuns;
