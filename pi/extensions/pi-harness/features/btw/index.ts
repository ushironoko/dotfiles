import { randomUUID } from "node:crypto";
import type {
  AgentMessage,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  AuthStorage,
  buildSessionContext,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type CreateAgentSessionOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ModelRegistry,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { PiLike } from "../../lib/pi-like";
import { stripTerminalControls } from "../../lib/terminal-text";

const HISTORY_TYPE = "pi-harness:btw";
const STATUS_KEY = "pi-harness-btw";
const QUESTION_MAX_BYTES = 16 * 1024;
const ANSWER_MAX_BYTES = 64 * 1024;
const ERROR_MAX_BYTES = 4 * 1024;
const TRUNCATION_MARKER = "\n\n[BTW answer truncated in parent history.]";
const ERROR_TRUNCATION_MARKER = "…";

// pi's grep/find wrappers auto-install missing rg/fd binaries. Keep the BTW
// capability set to built-ins that never perform package or binary installs.
const BTW_READ_ONLY_TOOLS = ["read", "ls"] as const;
const BTW_DENIED_TOOLS = ["bash", "edit", "write"] as const;

const BTW_SYSTEM_SUFFIX = `You are answering one side question in a temporary fork of another pi session.
Treat the copied conversation as read-only background context. Answer only the side question; do not continue the parent task.
You may inspect the current workspace only through the available read-only tools. Never attempt to mutate files, execute shell commands, or cause other side effects.`;

class BtwCancellationSignal {
  aborted = false;
  private readonly listeners = new Set<() => void>();

  onAbort(listener: () => void): () => void {
    if (this.aborted) listener();
    else this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}

class BtwCancellationController {
  readonly signal = new BtwCancellationSignal();

  abort(): void {
    this.signal.abort();
  }
}

interface BtwHistoryData {
  version: 1;
  id: string;
  question: string;
  answer: string;
  answerTruncated: boolean;
  model: string;
  createdAt: number;
}

interface BtwSnapshot {
  cwd: string;
  parentSession?: string;
  systemPrompt: string;
  messages: AgentMessage[];
  model: NonNullable<ExtensionCommandContext["model"]>;
  modelRegistry: ModelRegistry;
  thinkingLevel: ThinkingLevel;
  signal?: BtwCancellationSignal;
}

interface ChildSessionEvent {
  type: string;
  message?: AgentMessage;
}

interface ChildSessionLike {
  agent: {
    state: {
      messages: AgentMessage[];
    };
  };
  prompt(
    text: string,
    options?: {
      expandPromptTemplates?: boolean;
      source?: "interactive" | "rpc" | "extension";
    },
  ): Promise<void>;
  getActiveToolNames(): string[];
  subscribe(listener: (event: ChildSessionEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
}

interface BtwForkDependencies {
  getAgentDir(): string;
  createResourceLoader(
    options: ConstructorParameters<typeof DefaultResourceLoader>[0],
  ): ResourceLoader;
  createSessionManager(
    cwd: string,
    options?: { parentSession?: string },
  ): SessionManager;
  createSettingsManager(): SettingsManager;
  createSession(options: CreateAgentSessionOptions): Promise<ChildSessionLike>;
}

const defaultForkDependencies: BtwForkDependencies = {
  getAgentDir,
  createResourceLoader: (options) => new DefaultResourceLoader(options),
  createSessionManager: (cwd, options) => SessionManager.inMemory(cwd, options),
  createSettingsManager: () =>
    SettingsManager.inMemory({ images: { blockImages: true } }),
  createSession: async (options) => {
    const result = await createAgentSession(options);
    return result.session;
  },
};

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

const truncateUtf8 = (
  value: string,
  maxBytes: number,
  marker = TRUNCATION_MARKER,
): { text: string; truncated: boolean } => {
  if (byteLength(value) <= maxBytes) {
    return { text: value, truncated: false };
  }

  const retainedMarker = byteLength(marker) <= maxBytes ? marker : "";
  const contentLimit = Math.max(0, maxBytes - byteLength(retainedMarker));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, middle)) <= contentLimit) low = middle;
    else high = middle - 1;
  }

  let end = low;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return {
    text: `${value.slice(0, Math.max(0, end))}${retainedMarker}`,
    truncated: true,
  };
};

const assertQuestion = (question: string): void => {
  if (question === "") throw new Error("BTW question is empty");
  if (byteLength(question) > QUESTION_MAX_BYTES) {
    throw new Error(`BTW question exceeds ${QUESTION_MAX_BYTES} bytes`);
  }
};

const seedSessionManager = (
  sessionManager: SessionManager,
  messages: AgentMessage[],
): void => {
  for (const source of messages) {
    const message = structuredClone(source);
    if (message.role === "compactionSummary") {
      sessionManager.appendCustomMessageEntry(
        "pi-harness:btw-compaction",
        `Compaction summary from the parent session:\n\n${message.summary}`,
        false,
      );
    } else if (message.role === "branchSummary") {
      sessionManager.appendCustomMessageEntry(
        "pi-harness:btw-branch-summary",
        `Branch summary from the parent session:\n\n${message.summary}`,
        false,
      );
    } else {
      sessionManager.appendMessage(message);
    }
  }
};

const assertReadOnlyTools = (activeTools: string[]): void => {
  const allowed = new Set<string>(BTW_READ_ONLY_TOOLS);
  if (
    activeTools.length !== allowed.size ||
    activeTools.some((tool) => !allowed.has(tool))
  ) {
    throw new Error(
      `BTW child tool isolation failed: active tools are ${activeTools.join(", ") || "(none)"}`,
    );
  }
};

const answerFromReadOnlyFork = async (
  snapshot: BtwSnapshot,
  question: string,
  dependencies: BtwForkDependencies = defaultForkDependencies,
): Promise<string> => {
  assertQuestion(question);
  const agentDir = dependencies.getAgentDir();
  // One in-memory settings instance is shared by the loader and child. This
  // leaves configured npm/git packages undiscovered (and therefore unable to
  // auto-install) and forces copied/read images out of provider context.
  const settingsManager = dependencies.createSettingsManager();
  const resourceLoader = dependencies.createResourceLoader({
    cwd: snapshot.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: `${snapshot.systemPrompt.trimEnd()}\n\n${BTW_SYSTEM_SUFFIX}`,
    appendSystemPrompt: [],
  });
  await resourceLoader.reload();

  const sessionManager = dependencies.createSessionManager(
    snapshot.cwd,
    snapshot.parentSession === undefined
      ? undefined
      : { parentSession: snapshot.parentSession },
  );
  seedSessionManager(sessionManager, snapshot.messages);
  const session = await dependencies.createSession({
    cwd: snapshot.cwd,
    agentDir,
    model: snapshot.model,
    modelRegistry: snapshot.modelRegistry,
    authStorage: AuthStorage.inMemory(),
    thinkingLevel: snapshot.thinkingLevel,
    tools: [...BTW_READ_ONLY_TOOLS],
    excludeTools: [...BTW_DENIED_TOOLS],
    resourceLoader,
    sessionManager,
    settingsManager,
  });

  let latestAssistant: Extract<AgentMessage, { role: "assistant" }> | undefined;
  const unsubscribeSession = session.subscribe((event) => {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      latestAssistant = event.message;
    }
  });
  let abortPromise: Promise<void> | undefined;
  const abortChild = (): void => {
    abortPromise ??= session.abort();
  };
  const unsubscribeAbort = snapshot.signal?.onAbort(abortChild);
  const parentClosed = (): boolean => snapshot.signal?.aborted ?? false;

  try {
    if (parentClosed()) {
      abortChild();
      throw new Error("BTW cancelled because the parent session closed");
    }
    assertReadOnlyTools(session.getActiveToolNames());
    await session.prompt(question, {
      expandPromptTemplates: false,
      source: "extension",
    });
    if (parentClosed()) {
      throw new Error("BTW cancelled because the parent session closed");
    }
    if (latestAssistant?.stopReason !== "stop") {
      throw new Error(
        `BTW child did not complete successfully (${latestAssistant?.stopReason ?? "no response"})`,
      );
    }
    const answer = latestAssistant.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (answer === "") throw new Error("BTW child returned no text answer");
    return answer;
  } finally {
    unsubscribeSession();
    unsubscribeAbort?.();
    try {
      await abortPromise;
    } finally {
      session.dispose();
    }
  }
};

const isHistoryData = (value: unknown): value is BtwHistoryData => {
  if (value === null || typeof value !== "object") return false;
  const data = value as Partial<BtwHistoryData>;
  return (
    data.version === 1 &&
    typeof data.id === "string" &&
    typeof data.question === "string" &&
    typeof data.answer === "string" &&
    typeof data.answerTruncated === "boolean" &&
    typeof data.model === "string" &&
    typeof data.createdAt === "number" &&
    Number.isFinite(data.createdAt)
  );
};

const errorText = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  return truncateUtf8(
    stripTerminalControls(raw),
    ERROR_MAX_BYTES,
    ERROR_TRUNCATION_MARKER,
  ).text;
};

interface BtwFeatureDependencies {
  answerQuestion?: typeof answerFromReadOnlyFork;
  now?: () => number;
  createId?: () => string;
}

interface NativeAbortControllerLike {
  readonly signal: AbortSignal;
  abort(): void;
}

const createNativeAbortController = (): NativeAbortControllerLike =>
  new AbortController() as unknown as NativeAbortControllerLike;

const waitForIdleOrAbort = async (
  ctx: ExtensionCommandContext,
  cancellation: BtwCancellationSignal,
): Promise<boolean> => {
  if (cancellation.aborted) return true;
  let unsubscribe = (): void => {};
  const aborted = new Promise<true>((resolve) => {
    unsubscribe = cancellation.onAbort(() => resolve(true));
  });
  const idle = Promise.resolve()
    .then(() => ctx.waitForIdle())
    .then(() => false as const);
  try {
    return await Promise.race([idle, aborted]);
  } finally {
    unsubscribe();
  }
};

const readQuestion = async (
  args: string,
  ctx: ExtensionCommandContext,
  cancellation: BtwCancellationSignal,
): Promise<string | undefined> => {
  const inline = args.trim();
  if (inline !== "") return inline;
  if (!ctx.hasUI) {
    throw new Error("Usage: /btw <question> (interactive input unavailable)");
  }
  const controller = createNativeAbortController();
  const unsubscribe = cancellation.onAbort(() => controller.abort());
  try {
    const question = await ctx.ui.input(
      "BTW question",
      "Ask without changing parent context",
      { signal: controller.signal },
    );
    return question?.trim();
  } finally {
    unsubscribe();
  }
};

const setupBtw = (
  pi: PiLike,
  dependencies: BtwFeatureDependencies = {},
): void => {
  const answerQuestion = dependencies.answerQuestion ?? answerFromReadOnlyFork;
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? randomUUID;
  const runtime = pi as unknown as ExtensionAPI;
  let running = false;
  let activeAbort: BtwCancellationController | undefined;
  let activeOperation: Promise<void> | undefined;
  let sessionGeneration = 0;
  let branchGeneration = 0;

  pi.on("session_start", () => {
    sessionGeneration += 1;
  });
  pi.on("session_before_tree", () => {
    // Invalidate before navigation changes the active leaf. Cancelling even if
    // a later handler vetoes navigation is the conservative outcome: a BTW
    // answer must never move from its snapshotted branch to another branch.
    branchGeneration += 1;
    activeAbort?.abort();
  });
  pi.on("session_shutdown", async () => {
    sessionGeneration += 1;
    activeAbort?.abort();
    const operation = activeOperation;
    await operation;
  });
  runtime.on("session_compact", (_event, ctx) => {
    const visibleIds = new Set<string>();
    for (const entry of ctx.sessionManager.buildContextEntries()) {
      if (
        entry.type === "custom" &&
        entry.customType === HISTORY_TYPE &&
        isHistoryData(entry.data)
      ) {
        visibleIds.add(entry.data.id);
      }
    }

    const histories = new Map<string, BtwHistoryData>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom" &&
        entry.customType === HISTORY_TYPE &&
        isHistoryData(entry.data)
      ) {
        histories.set(entry.data.id, entry.data);
      }
    }
    for (const [id, data] of histories) {
      if (!visibleIds.has(id)) {
        pi.appendEntry<BtwHistoryData>(HISTORY_TYPE, data);
      }
    }
  });

  const cancelActive = (ctx: ExtensionContext): void => {
    if (activeAbort === undefined) {
      if (ctx.hasUI) ctx.ui.notify("No BTW question is running", "warning");
      return;
    }
    activeAbort.abort();
    if (ctx.hasUI) ctx.ui.notify("BTW cancellation requested", "info");
  };
  pi.registerCommand("btw-cancel", {
    description: "Cancel the active BTW side question",
    handler: async (_args, ctx) => cancelActive(ctx),
  });
  pi.registerShortcut("ctrl+alt+b", {
    description: "Cancel the active BTW side question",
    handler: cancelActive,
  });

  pi.registerEntryRenderer<BtwHistoryData>(
    HISTORY_TYPE,
    (entry, { expanded }, theme) => {
      if (!isHistoryData(entry.data)) {
        return new Text(
          theme.fg("warning", "BTW history entry is malformed"),
          1,
          0,
        );
      }
      const { data } = entry;
      const question = stripTerminalControls(data.question);
      const answer = stripTerminalControls(data.answer);
      const model = stripTerminalControls(data.model);
      let text = `${theme.fg("accent", theme.bold("BTW"))}\n`;
      text += `${theme.fg("muted", "Q:")} ${question}\n\n${answer}`;
      if (expanded) {
        text += `\n\n${theme.fg(
          "dim",
          `${model} · ${new Date(data.createdAt).toLocaleString()}${
            data.answerTruncated ? " · retained answer truncated" : ""
          }`,
        )}`;
      }
      return new Text(text, 1, 0);
    },
  );

  pi.registerCommand("btw", {
    description:
      "Ask a read-only side question without changing parent context",
    handler: async (args, ctx) => {
      const hasUI = ctx.hasUI;
      const ui = ctx.ui;
      const mode = ctx.mode;
      if (running) {
        if (hasUI) ui.notify("A BTW question is already running", "warning");
        return;
      }

      running = true;
      const invocationSessionGeneration = sessionGeneration;
      const invocationBranchGeneration = branchGeneration;
      const sessionContextIsStale = (): boolean =>
        invocationSessionGeneration !== sessionGeneration;
      const invocationIsStale = (): boolean =>
        sessionContextIsStale() ||
        invocationBranchGeneration !== branchGeneration;
      const invocationAbort = new BtwCancellationController();
      activeAbort = invocationAbort;
      const releaseInvocation = (): void => {
        if (activeAbort === invocationAbort) activeAbort = undefined;
        running = false;
      };

      let question: string;
      try {
        if (!hasUI) throw new Error("BTW requires TUI or RPC UI mode");
        const input = await readQuestion(args, ctx, invocationAbort.signal);
        if (input === undefined) {
          releaseInvocation();
          return;
        }
        question = stripTerminalControls(input).trim();
        assertQuestion(question);
        if (!ctx.model) throw new Error("No model selected for BTW");
      } catch (error) {
        releaseInvocation();
        if (!hasUI) throw error;
        if (!invocationIsStale() && !invocationAbort.signal.aborted) {
          ui.notify(`BTW failed: ${errorText(error)}`, "error");
        }
        return;
      }

      // Return control to Pi after input validation so `/btw-cancel` can be
      // dispatched while the side question is running. The generation and
      // cancellation guards below own the detached operation's whole lifetime.
      const operation = Promise.resolve().then(async () => {
        let statusSet = false;
        try {
          if (!ctx.isIdle()) {
            ui.notify("Waiting for the parent session to settle...", "info");
          }
          while (!ctx.isIdle()) {
            const aborted = await waitForIdleOrAbort(
              ctx,
              invocationAbort.signal,
            );
            if (aborted || invocationIsStale()) return;
          }
          if (invocationAbort.signal.aborted || invocationIsStale()) return;
          if (!ctx.model) throw new Error("No model selected for BTW");

          const parentSession = ctx.sessionManager.getSessionFile();
          const parentEntries = ctx.sessionManager.getEntries();
          const hasAssistant = parentEntries.some(
            (entry) =>
              entry.type === "message" && entry.message.role === "assistant",
          );
          if (parentSession !== undefined && !hasAssistant) {
            throw new Error(
              "BTW history is not durable until the parent completes its first assistant response",
            );
          }

          ui.setStatus(STATUS_KEY, "btw: answering");
          statusSet = true;
          const resolved = buildSessionContext(
            parentEntries,
            ctx.sessionManager.getLeafId(),
          );
          const snapshot: BtwSnapshot = {
            cwd: ctx.cwd,
            parentSession,
            systemPrompt: ctx.getSystemPrompt(),
            messages: structuredClone(resolved.messages),
            model: ctx.model,
            modelRegistry: ctx.modelRegistry,
            thinkingLevel: pi.getThinkingLevel(),
            signal: invocationAbort.signal,
          };
          const rawAnswer = await answerQuestion(snapshot, question);
          if (invocationAbort.signal.aborted || invocationIsStale()) return;
          const answer = stripTerminalControls(rawAnswer.trim()).trim();
          if (answer === "") {
            throw new Error("BTW child returned no displayable text answer");
          }
          const retained = truncateUtf8(answer, ANSWER_MAX_BYTES);
          const record: BtwHistoryData = {
            version: 1,
            id: createId(),
            question: stripTerminalControls(question),
            answer: retained.text,
            answerTruncated: retained.truncated,
            model: stripTerminalControls(
              `${snapshot.model.provider}/${snapshot.model.id}`,
            ),
            createdAt: now(),
          };
          pi.appendEntry<BtwHistoryData>(HISTORY_TYPE, record);
          if (mode === "rpc") {
            ui.notify(`BTW\nQ: ${record.question}\n\n${record.answer}`, "info");
          }
        } catch (error) {
          if (!invocationIsStale() && !invocationAbort.signal.aborted) {
            ui.notify(`BTW failed: ${errorText(error)}`, "error");
          }
        } finally {
          if (statusSet && !sessionContextIsStale()) {
            try {
              ui.setStatus(STATUS_KEY, undefined);
            } catch {
              // Pi can invalidate a command UI context during session replacement.
            }
          }
          releaseInvocation();
          if (activeOperation === operation) activeOperation = undefined;
        }
      });
      activeOperation = operation;
      void operation;
    },
  });
};

export {
  ANSWER_MAX_BYTES,
  answerFromReadOnlyFork,
  BTW_DENIED_TOOLS,
  BtwCancellationController,
  type BtwFeatureDependencies,
  type BtwForkDependencies,
  type BtwHistoryData,
  type BtwSnapshot,
  BTW_READ_ONLY_TOOLS,
  ERROR_MAX_BYTES,
  HISTORY_TYPE,
  QUESTION_MAX_BYTES,
  setupBtw as default,
  truncateUtf8,
};
