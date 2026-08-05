import { randomUUID } from "node:crypto";
import type {
  AgentMessage,
  AgentTool,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
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
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { PiLike } from "../../lib/pi-like";
import { stripTerminalControls } from "../../lib/terminal-text";
import { BtwAnswerPaneComponent } from "./ui";

const HISTORY_TYPE = "pi-harness:btw";
const STATUS_KEY = "pi-harness-btw";
const HEARTH_SERVICE_READY = "pi-hearth-tools:service-ready:v1";
const HEARTH_SERVICE_REQUEST = "pi-hearth-tools:service-request:v1";
const QUESTION_MAX_BYTES = 16 * 1024;
const ANSWER_MAX_BYTES = 64 * 1024;
const ERROR_MAX_BYTES = 4 * 1024;
const TRUNCATION_MARKER = "\n\n[BTW answer truncated in parent history.]";
const ERROR_TRUNCATION_MARKER = "…";
const EMPTY_OVERLAY_COMPONENT: Component = {
  render: () => [],
  invalidate: () => {},
};

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

interface BtwInvocation {
  mode: "parallel" | "settled";
  question: string;
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

// Pi 0.80 accepts ModelRegistry directly. Pi 0.83 requires the ModelRuntime
// behind that extension-facing compatibility facade, so validate its nominal
// runtime type before sharing the parent's provider/auth state with the child.
const getParentModelRuntime = async (modelRegistry: ModelRegistry) => {
  const codingAgentSdk = await import("@earendil-works/pi-coding-agent");
  if (!("ModelRuntime" in codingAgentSdk)) return undefined;
  const { ModelRuntime } = codingAgentSdk;
  if (typeof ModelRuntime !== "function") {
    throw new Error("BTW cannot identify the pi ModelRuntime constructor");
  }
  const modelRuntime: unknown = Reflect.get(modelRegistry, "runtime");
  if (!(modelRuntime instanceof ModelRuntime)) {
    throw new Error("BTW cannot access the parent pi model runtime");
  }
  return modelRuntime;
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
  if (last >= 55_296 && last <= 56_319) end -= 1;
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

const parseBtwInvocation = (args: string): BtwInvocation => {
  const trimmed = args.trim();
  const settled = /^--wait(?:\s+([\s\S]*))?$/u.exec(trimmed);
  if (settled !== null) {
    return { mode: "settled", question: settled[1]?.trim() ?? "" };
  }
  return { mode: "parallel", question: trimmed };
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
  hearthReadTool?: AgentTool<TSchema, unknown>,
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
  const modelRuntime = await getParentModelRuntime(snapshot.modelRegistry);
  const sessionOptions = {
    cwd: snapshot.cwd,
    agentDir,
    model: snapshot.model,
    modelRegistry: snapshot.modelRegistry,
    ...(modelRuntime === undefined ? {} : { modelRuntime }),
    thinkingLevel: snapshot.thinkingLevel,
    tools: [...BTW_READ_ONLY_TOOLS],
    excludeTools: [...BTW_DENIED_TOOLS],
    ...(hearthReadTool === undefined ? {} : { customTools: [hearthReadTool] }),
    resourceLoader,
    sessionManager,
    settingsManager,
  };
  const session = await dependencies.createSession(sessionOptions);

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

interface HearthReadService {
  generation: string;
  createReadTool(cwd: string): AgentTool<TSchema, unknown>;
}

const isHearthReadService = (value: unknown): value is HearthReadService => {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<HearthReadService>;
  return (
    typeof candidate.generation === "string" &&
    typeof candidate.createReadTool === "function"
  );
};

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

const captureSnapshot = (
  pi: PiLike,
  ctx: ExtensionCommandContext,
  signal: BtwCancellationSignal,
): BtwSnapshot => {
  const { model } = ctx;
  if (!model) throw new Error("No model selected for BTW");

  // Keep all parent reads in one synchronous section. In particular, clone the
  // resolved messages before the parent can append its in-flight response.
  const parentSession = ctx.sessionManager.getSessionFile();
  const parentEntries = ctx.sessionManager.getEntries();
  const leafId = ctx.sessionManager.getLeafId();
  const resolved = buildSessionContext(parentEntries, leafId);
  const systemPrompt = ctx.getSystemPrompt();
  const thinkingLevel = pi.getThinkingLevel();
  const hasAssistant = parentEntries.some(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  if (parentSession !== undefined && !hasAssistant) {
    throw new Error(
      "BTW history is not durable until the parent completes its first assistant response",
    );
  }

  return {
    cwd: ctx.cwd,
    parentSession,
    systemPrompt,
    messages: structuredClone(resolved.messages),
    model,
    modelRegistry: ctx.modelRegistry,
    thinkingLevel,
    signal,
  };
};

const readQuestion = async (
  ctx: ExtensionCommandContext,
  cancellation: BtwCancellationSignal,
): Promise<string | undefined> => {
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
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? randomUUID;
  const runtime = pi as unknown as ExtensionAPI;
  let hearthService: HearthReadService | undefined;
  const acceptHearthService = (value: unknown): void => {
    if (isHearthReadService(value)) hearthService = value;
  };
  const unsubscribeHearthReady = runtime.events.on(
    HEARTH_SERVICE_READY,
    acceptHearthService,
  );
  const requestHearthService = (): void => {
    const requestId = randomUUID();
    runtime.events.emit(HEARTH_SERVICE_REQUEST, {
      requestId,
      accept(service: unknown, responseId: string) {
        if (responseId === requestId) acceptHearthService(service);
      },
    });
  };
  requestHearthService();
  const answerQuestion =
    dependencies.answerQuestion ??
    ((snapshot: BtwSnapshot, question: string) => {
      if (hearthService === undefined) {
        throw new Error("Hearth read service is unavailable");
      }
      return answerFromReadOnlyFork(
        snapshot,
        question,
        defaultForkDependencies,
        hearthService.createReadTool(snapshot.cwd),
      );
    });
  let running = false;
  let activeAbort: BtwCancellationController | undefined;
  let activeOperation: Promise<void> | undefined;
  let paneClose: (() => void) | undefined;
  let paneHandle: OverlayHandle | undefined;
  let paneTui: TUI | undefined;
  let panePromise: Promise<void> | undefined;
  let sessionGeneration = 0;
  let branchGeneration = 0;

  const closePane = (): void => {
    const close = paneClose;
    const handle = paneHandle;
    const tui = paneTui;
    paneClose = undefined;
    paneHandle = undefined;
    paneTui = undefined;
    if (close === undefined) return;
    if (handle === undefined || tui === undefined) {
      close();
      return;
    }

    // Pi 0.80's custom-overlay done callback always pops the newest overlay,
    // not the overlay that owns the callback. Remove our owned overlay by
    // handle and temporarily put a sentinel on top for done() to consume, so a
    // newer unrelated overlay survives while Pi still resolves/disposes the
    // custom component normally.
    const sentinel = tui.showOverlay(EMPTY_OVERLAY_COMPONENT, {
      nonCapturing: true,
    });
    try {
      handle.hide();
      close();
    } finally {
      sentinel.hide();
    }
  };
  const openPane = (
    ctx: ExtensionCommandContext,
    selected?: BtwHistoryData,
  ): void => {
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
    if (selected !== undefined) histories.set(selected.id, selected);
    const ordered = [...histories.values()];

    const { ui } = ctx;
    const selectedRecord = selected ?? ordered.at(-1);
    if (selectedRecord === undefined) {
      ui.notify("No BTW answers are available on this branch.", "warning");
      return;
    }
    if (typeof ui.custom !== "function") {
      ui.notify("BTW answer pane requires custom TUI support.", "warning");
      return;
    }
    closePane();

    let detailPromise: Promise<void>;
    try {
      detailPromise = ui.custom<void>(
        (tui, theme, keybindings, done) => {
          let closed = false;
          const close = (): void => {
            if (closed) return;
            closed = true;
            if (paneClose === close) {
              paneClose = undefined;
              paneHandle = undefined;
              paneTui = undefined;
            }
            done(undefined);
          };
          paneClose = close;
          paneTui = tui;
          return new BtwAnswerPaneComponent(
            ordered,
            selectedRecord.id,
            tui,
            keybindings,
            closePane,
            theme,
          );
        },
        {
          overlay: true,
          overlayOptions: {
            width: "100%",
            maxHeight: "100%",
            anchor: "center",
            margin: 0,
          },
          onHandle: (handle) => {
            if (panePromise === detailPromise) paneHandle = handle;
          },
        },
      );
    } catch (error) {
      ui.notify(
        `BTW answer pane could not open: ${errorText(error)}`,
        "warning",
      );
      return;
    }

    panePromise = detailPromise;
    void detailPromise
      .catch((error) => {
        ui.notify(
          `BTW answer pane could not open: ${errorText(error)}`,
          "warning",
        );
      })
      .finally(() => {
        if (panePromise !== detailPromise) return;
        panePromise = undefined;
        paneClose = undefined;
        paneHandle = undefined;
        paneTui = undefined;
      });
  };

  pi.on("session_start", () => {
    sessionGeneration += 1;
    activeAbort?.abort();
    closePane();
    requestHearthService();
  });
  pi.on("session_before_tree", () => {
    // Invalidate before navigation changes the active leaf. Cancelling even if
    // a later handler vetoes navigation is the conservative outcome: a BTW
    // answer must never move from its snapshotted branch to another branch.
    branchGeneration += 1;
    activeAbort?.abort();
    closePane();
  });
  pi.on("session_shutdown", async () => {
    sessionGeneration += 1;
    activeAbort?.abort();
    closePane();
    const operation = activeOperation;
    await operation;
    unsubscribeHearthReady();
    hearthService = undefined;
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
  pi.registerCommand("btw-history", {
    description: "Open BTW answer history for the active branch",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (!ctx.hasUI) {
          throw new Error("BTW answer history requires TUI mode");
        }
        ctx.ui.notify("BTW answer history requires TUI mode.", "warning");
        return;
      }
      openPane(ctx);
    },
  });

  pi.registerCommand("btw", {
    description:
      "Ask a parallel read-only side question (--wait for settled context)",
    handler: async (args, ctx) => {
      const { hasUI, ui, mode: uiMode } = ctx;
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

      const invocation = parseBtwInvocation(args);
      let question: string;
      let parallelSnapshot: BtwSnapshot | undefined;
      try {
        if (!hasUI) throw new Error("BTW requires TUI or RPC UI mode");
        const input =
          invocation.question === ""
            ? await readQuestion(ctx, invocationAbort.signal)
            : invocation.question;
        if (input === undefined) {
          releaseInvocation();
          return;
        }
        if (invocationAbort.signal.aborted || invocationIsStale()) {
          releaseInvocation();
          return;
        }
        question = stripTerminalControls(input).trim();
        assertQuestion(question);
        if (!ctx.model) throw new Error("No model selected for BTW");
        if (invocation.mode === "parallel") {
          parallelSnapshot = captureSnapshot(pi, ctx, invocationAbort.signal);
        }
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
          let snapshot = parallelSnapshot;
          if (invocation.mode === "settled") {
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
            snapshot = captureSnapshot(pi, ctx, invocationAbort.signal);
          } else if (invocationAbort.signal.aborted || invocationIsStale()) {
            return;
          }
          if (snapshot === undefined) {
            throw new Error("BTW snapshot is unavailable");
          }

          ui.setStatus(STATUS_KEY, "btw: answering");
          statusSet = true;
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
          if (uiMode === "rpc") {
            ui.notify(`BTW\nQ: ${record.question}\n\n${record.answer}`, "info");
          } else if (uiMode === "tui") {
            openPane(ctx, record);
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
  type BtwInvocation,
  type BtwForkDependencies,
  type BtwHistoryData,
  type BtwSnapshot,
  BTW_READ_ONLY_TOOLS,
  captureSnapshot,
  ERROR_MAX_BYTES,
  HISTORY_TYPE,
  parseBtwInvocation,
  QUESTION_MAX_BYTES,
  setupBtw as default,
  truncateUtf8,
};
