import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai/compat";
import {
  buildSessionContext,
  createEventBus,
  type CreateAgentSessionOptions,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ModelRegistry,
  type RegisteredCommand,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import setupBtw, {
  ANSWER_MAX_BYTES,
  answerFromReadOnlyFork,
  BTW_DENIED_TOOLS,
  BtwCancellationController,
  type BtwForkDependencies,
  type BtwHistoryData,
  type BtwSnapshot,
  BTW_READ_ONLY_TOOLS,
  ERROR_MAX_BYTES,
  HISTORY_TYPE,
  parseBtwInvocation,
  QUESTION_MAX_BYTES,
  truncateUtf8,
} from "../../pi/extensions/pi-harness/features/btw/index";
import { loadConfig } from "../../pi/extensions/pi-harness/config";
import { setupHarness } from "../../pi/extensions/pi-harness/index";
import type { PiLike } from "../../pi/extensions/pi-harness/lib/pi-like";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { visibleWidth } from "../../pi/extensions/pi-harness/lib/terminal-text";
import { BtwAnswerPaneComponent } from "../../pi/extensions/pi-harness/features/btw/ui";
import { createFakePi } from "./fake-pi";

const parentModel = {
  provider: "test-provider",
  id: "test-model",
  name: "Test model",
} as NonNullable<ExtensionCommandContext["model"]>;

const userMessage = (text: string): UserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1,
});

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for BTW");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const assistantMessage = (
  text: string,
  stopReason: Extract<
    AgentMessage,
    { role: "assistant" }
  >["stopReason"] = "stop",
): Extract<AgentMessage, { role: "assistant" }> => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "test-provider",
  model: "test-model",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 2,
});

const toolResultMessage = (
  text: string,
): Extract<AgentMessage, { role: "toolResult" }> => ({
  role: "toolResult",
  toolCallId: "tool-1",
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 3,
});

interface ChildHarness {
  dependencies: BtwForkDependencies;
  child: {
    agent: { state: { messages: AgentMessage[] } };
    promptText?: string;
    promptOptions?: {
      expandPromptTemplates?: boolean;
      source?: "interactive" | "rpc" | "extension";
    };
    disposed: boolean;
    aborted: boolean;
    activeTools: string[];
    answer?: string;
    stopReason: Extract<AgentMessage, { role: "assistant" }>["stopReason"];
    emitAssistant: boolean;
    promptError?: Error;
  };
  loaderOptions: Record<string, unknown>[];
  createOptions: CreateAgentSessionOptions[];
  reloads: number;
}

const childHarness = (): ChildHarness => {
  const loaderOptions: Record<string, unknown>[] = [];
  const createOptions: CreateAgentSessionOptions[] = [];
  let reloads = 0;
  const child = {
    agent: { state: { messages: [] as AgentMessage[] } },
    promptText: undefined as string | undefined,
    promptOptions: undefined as
      | {
          expandPromptTemplates?: boolean;
          source?: "interactive" | "rpc" | "extension";
        }
      | undefined,
    disposed: false,
    aborted: false,
    activeTools: [...BTW_READ_ONLY_TOOLS],
    answer: "side answer" as string | undefined,
    stopReason: "stop" as const,
    emitAssistant: true,
    promptError: undefined as Error | undefined,
  };

  const dependencies: BtwForkDependencies = {
    getAgentDir: () => "/agent",
    createResourceLoader: (options) => {
      loaderOptions.push(options as unknown as Record<string, unknown>);
      return {
        reload: async () => {
          reloads += 1;
        },
      } as ResourceLoader;
    },
    createSessionManager: (cwd, options) =>
      SessionManager.inMemory(cwd, options),
    createSettingsManager: () =>
      SettingsManager.inMemory({ images: { blockImages: true } }),
    createSession: async (options) => {
      createOptions.push(options);
      child.agent.state.messages =
        options.sessionManager?.buildSessionContext().messages ?? [];
      let listener:
        | ((event: { type: string; message?: AgentMessage }) => void)
        | undefined;
      return {
        agent: child.agent,
        getActiveToolNames: () => [...child.activeTools],
        subscribe: (value) => {
          listener = value;
          return () => {
            listener = undefined;
          };
        },
        prompt: async (text, promptOptions) => {
          child.promptText = text;
          child.promptOptions = promptOptions;
          if (child.promptError) throw child.promptError;
          if (child.emitAssistant) {
            const message = assistantMessage(
              child.answer ?? "",
              child.stopReason,
            );
            child.agent.state.messages.push(message);
            listener?.({ type: "message_end", message });
          }
        },
        abort: async () => {
          child.aborted = true;
        },
        dispose: () => {
          child.disposed = true;
        },
      };
    },
  };

  return {
    dependencies,
    child,
    loaderOptions,
    createOptions,
    get reloads() {
      return reloads;
    },
  };
};

const snapshot = (): BtwSnapshot => ({
  cwd: "/repo",
  parentSession: "/sessions/parent.jsonl",
  systemPrompt: "parent system prompt",
  messages: [userMessage("parent context")],
  model: parentModel,
  modelRegistry: {} as ModelRegistry,
  thinkingLevel: "low",
});

describe("BTW invocation parser", () => {
  test("treats only a leading complete --wait token as settled mode", () => {
    expect(parseBtwInvocation("")).toEqual({
      mode: "parallel",
      question: "",
    });
    expect(parseBtwInvocation("  side question  ")).toEqual({
      mode: "parallel",
      question: "side question",
    });
    expect(parseBtwInvocation("--wait")).toEqual({
      mode: "settled",
      question: "",
    });
    expect(parseBtwInvocation("  --wait   settled question  ")).toEqual({
      mode: "settled",
      question: "settled question",
    });
    expect(parseBtwInvocation("--wait\nmultiline question")).toEqual({
      mode: "settled",
      question: "multiline question",
    });
    expect(parseBtwInvocation("--waiting is literal")).toEqual({
      mode: "parallel",
      question: "--waiting is literal",
    });
    expect(parseBtwInvocation("--wait=literal")).toEqual({
      mode: "parallel",
      question: "--wait=literal",
    });
    expect(parseBtwInvocation("question --wait")).toEqual({
      mode: "parallel",
      question: "question --wait",
    });
  });
});

describe("BTW read-only fork runner", () => {
  test("creates an extension-free in-memory child with an exact read-only tool set", async () => {
    const harness = childHarness();
    const parent = snapshot();

    await expect(
      answerFromReadOnlyFork(
        parent,
        "What does this do?",
        harness.dependencies,
      ),
    ).resolves.toBe("side answer");

    expect(harness.reloads).toBe(1);
    expect(harness.loaderOptions[0]).toMatchObject({
      cwd: "/repo",
      agentDir: "/agent",
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      appendSystemPrompt: [],
    });
    expect(String(harness.loaderOptions[0].systemPrompt)).toContain(
      "parent system prompt",
    );
    expect(String(harness.loaderOptions[0].systemPrompt)).toContain(
      "Never attempt to mutate files",
    );
    expect(harness.createOptions[0].tools).toEqual([...BTW_READ_ONLY_TOOLS]);
    expect(harness.createOptions[0].excludeTools).toEqual([
      ...BTW_DENIED_TOOLS,
    ]);
    expect(harness.createOptions[0].model).toBe(parentModel);
    expect(harness.createOptions[0].modelRegistry).toBe(parent.modelRegistry);
    expect(harness.createOptions[0].thinkingLevel).toBe("low");
    expect(harness.loaderOptions[0].settingsManager).toBe(
      harness.createOptions[0].settingsManager,
    );
    expect(harness.createOptions[0].settingsManager?.getBlockImages()).toBe(
      true,
    );
    expect(harness.child.promptText).toBe("What does this do?");
    expect(harness.child.promptOptions).toEqual({
      expandPromptTemplates: false,
      source: "extension",
    });
    expect(harness.child.agent.state.messages.slice(0, -1)).toEqual(
      parent.messages,
    );
    expect(
      harness.createOptions[0].sessionManager?.buildSessionContext().messages,
    ).toEqual(parent.messages);
    expect(harness.child.disposed).toBe(true);
  });

  test("injects a Hearth read override without enabling extensions", async () => {
    const harness = childHarness();
    const readTool = {
      name: "read",
      label: "read",
      description: "Hearth read",
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }),
    } as never;

    await answerFromReadOnlyFork(
      snapshot(),
      "question",
      harness.dependencies,
      readTool,
    );

    expect(harness.createOptions[0].customTools).toEqual([readTool]);
    expect(harness.createOptions[0].tools).toEqual([...BTW_READ_ONLY_TOOLS]);
    expect(harness.loaderOptions[0].noExtensions).toBe(true);
  });

  test("seeds compaction summaries into the recoverable child session", async () => {
    const harness = childHarness();
    const parent = snapshot();
    parent.messages = [
      {
        role: "compactionSummary",
        summary: "important compacted context",
        tokensBefore: 10_000,
        timestamp: 1,
      },
      userMessage("recent context"),
    ];

    await answerFromReadOnlyFork(parent, "question", harness.dependencies);
    const seeded =
      harness.createOptions[0].sessionManager?.buildSessionContext().messages;
    expect(seeded?.[0]?.role).toBe("custom");
    expect(JSON.stringify(seeded?.[0])).toContain(
      "important compacted context",
    );
    expect(seeded?.[1]).toEqual(userMessage("recent context"));
  });

  test("fails closed on an unexpected active tool and still disposes", async () => {
    const harness = childHarness();
    harness.child.activeTools.push("bash");

    await expect(
      answerFromReadOnlyFork(snapshot(), "question", harness.dependencies),
    ).rejects.toThrow("tool isolation failed");
    expect(harness.child.promptText).toBeUndefined();
    expect(harness.child.disposed).toBe(true);
  });

  test("aborts and disposes when the parent signal is already closed", async () => {
    const harness = childHarness();
    const parent = snapshot();
    const controller = new BtwCancellationController();
    controller.abort();
    parent.signal = controller.signal;

    await expect(
      answerFromReadOnlyFork(parent, "question", harness.dependencies),
    ).rejects.toThrow("parent session closed");
    expect(harness.child.aborted).toBe(true);
    expect(harness.child.promptText).toBeUndefined();
    expect(harness.child.disposed).toBe(true);
  });

  test("rejects incomplete or missing fresh assistant responses", async () => {
    const limited = childHarness();
    limited.child.stopReason = "length";
    await expect(
      answerFromReadOnlyFork(snapshot(), "question", limited.dependencies),
    ).rejects.toThrow("did not complete successfully (length)");
    expect(limited.child.disposed).toBe(true);

    const stale = childHarness();
    const parent = snapshot();
    parent.messages.push(assistantMessage("unrelated parent answer"));
    stale.child.emitAssistant = false;
    await expect(
      answerFromReadOnlyFork(parent, "question", stale.dependencies),
    ).rejects.toThrow("no response");
    expect(stale.child.disposed).toBe(true);
  });

  test("disposes when prompting fails or returns no text", async () => {
    const failed = childHarness();
    failed.child.promptError = new Error("provider failed");
    await expect(
      answerFromReadOnlyFork(snapshot(), "question", failed.dependencies),
    ).rejects.toThrow("provider failed");
    expect(failed.child.disposed).toBe(true);

    const empty = childHarness();
    empty.child.answer = "  ";
    await expect(
      answerFromReadOnlyFork(snapshot(), "question", empty.dependencies),
    ).rejects.toThrow("no text answer");
    expect(empty.child.disposed).toBe(true);
  });
});

interface CommandHarness {
  pi: PiLike;
  command: (name?: string) => RegisteredCommand;
  shortcut: (name: string) => (ctx: ExtensionContext) => Promise<void> | void;
  rendererRegistered(): boolean;
  entries: { customType: string; data: unknown }[];
  emitSessionBeforeTree(): Promise<void>;
  emitSessionCompact(ctx: ExtensionCommandContext): Promise<void>;
  emitSessionStart(): Promise<void>;
  emitSessionShutdown(): Promise<void>;
}

const commandHarness = (
  onAppend?: (customType: string, data: unknown) => void,
): CommandHarness => {
  const commands = new Map<string, RegisteredCommand>();
  const shortcuts = new Map<
    string,
    (ctx: ExtensionContext) => Promise<void> | void
  >();
  let rendererRegistrations = 0;
  let compactHandler:
    | ((
        event: { type: string },
        ctx: ExtensionCommandContext,
      ) => Promise<void> | void)
    | undefined;
  let beforeTreeHandler: (() => Promise<void> | void) | undefined;
  let startHandler: (() => Promise<void> | void) | undefined;
  let shutdownHandler: (() => Promise<void> | void) | undefined;
  const entries: { customType: string; data: unknown }[] = [];
  const events = createEventBus();
  const pi = {
    events,
    on(event: string, handler: () => Promise<void> | void) {
      if (event === "session_compact") {
        compactHandler = handler as unknown as typeof compactHandler;
      }
      if (event === "session_before_tree") beforeTreeHandler = handler;
      if (event === "session_start") startHandler = handler;
      if (event === "session_shutdown") shutdownHandler = handler;
    },
    registerTool() {},
    registerCommand(
      name: string,
      options: Omit<RegisteredCommand, "name" | "sourceInfo">,
    ) {
      commands.set(name, {
        ...options,
        name,
        sourceInfo: {} as RegisteredCommand["sourceInfo"],
      });
    },
    registerShortcut(
      name: string,
      options: {
        handler: (ctx: ExtensionContext) => Promise<void> | void;
      },
    ) {
      shortcuts.set(name, options.handler);
    },
    registerEntryRenderer(customType: string) {
      if (customType === HISTORY_TYPE) rendererRegistrations += 1;
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
      onAppend?.(customType, data);
    },
    getThinkingLevel: () => "high" as const,
  } as unknown as PiLike;
  return {
    pi,
    command: (name = "btw") => {
      const command = commands.get(name);
      if (!command) throw new Error(`${name} command was not registered`);
      return command;
    },
    shortcut: (name) => {
      const shortcut = shortcuts.get(name);
      if (!shortcut) throw new Error(`${name} shortcut was not registered`);
      return shortcut;
    },
    rendererRegistered: () => rendererRegistrations > 0,
    entries,
    emitSessionBeforeTree: async () => {
      await beforeTreeHandler?.();
    },
    emitSessionCompact: async (ctx) => {
      await compactHandler?.({ type: "session_compact" }, ctx);
    },
    emitSessionStart: async () => {
      await startHandler?.();
    },
    emitSessionShutdown: async () => {
      await shutdownHandler?.();
    },
  };
};

interface FakeOverlayHandle {
  hide(): void;
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
  focus(): void;
  unfocus(): void;
  isFocused(): boolean;
}

interface CustomPaneCall {
  component: BtwAnswerPaneComponent;
  options: unknown;
  isClosed(): boolean;
  hasHandle(): boolean;
  isMounted(): boolean;
}

interface ContextHarness {
  ctx: ExtensionCommandContext;
  order: string[];
  notifications: { message: string; level?: string }[];
  statuses: { key: string; value: string | undefined }[];
  panes: CustomPaneCall[];
  mountForeignOverlay(): { isMounted(): boolean };
  sessionManager: SessionManager;
}

const commandContext = (
  options: {
    hasUI?: boolean;
    idle?: boolean;
    mode?: "tui" | "rpc" | "json" | "print";
    customUi?: boolean;
  } = {},
): ContextHarness => {
  const sessionManager = SessionManager.inMemory("/repo");
  sessionManager.appendMessage(userMessage("main question"));
  const order: string[] = [];
  const notifications: { message: string; level?: string }[] = [];
  const statuses: { key: string; value: string | undefined }[] = [];
  const panes: CustomPaneCall[] = [];
  const overlayStack: FakeOverlayHandle[] = [];
  const mounted = new Set<FakeOverlayHandle>();
  let focused: FakeOverlayHandle | undefined;
  let idle = options.idle ?? false;

  const showOverlay = (): FakeOverlayHandle => {
    let hidden = false;
    const handle: FakeOverlayHandle = {
      hide: () => {
        const index = overlayStack.indexOf(handle);
        if (index !== -1) overlayStack.splice(index, 1);
        mounted.delete(handle);
        if (focused === handle) focused = overlayStack.at(-1);
      },
      setHidden: (value) => {
        hidden = value;
      },
      isHidden: () => hidden,
      focus: () => {
        focused = handle;
      },
      unfocus: () => {
        if (focused === handle) focused = undefined;
      },
      isFocused: () => focused === handle,
    };
    overlayStack.push(handle);
    mounted.add(handle);
    focused = handle;
    return handle;
  };
  const hideTopOverlay = (): void => {
    const handle = overlayStack.at(-1);
    handle?.hide();
  };
  const tui = {
    terminal: { rows: 16 },
    requestRender: () => {},
    showOverlay: (_component: unknown, _options?: unknown) => showOverlay(),
  };
  const custom = <T>(
    factory: (
      value: typeof tui,
      theme: {
        fg(color: string, text: string): string;
        bg(color: string, text: string): string;
        bold(text: string): string;
      },
      keybindings: { matches(data: string, keybinding: string): boolean },
      done: (result: T) => void,
    ) => BtwAnswerPaneComponent,
    customOptions?: unknown,
  ): Promise<T> =>
    new Promise<T>((resolve) => {
      let closed = false;
      let ownedHandle: FakeOverlayHandle | undefined;
      const component = factory(
        tui,
        {
          fg: (_color, text) => text,
          bg: (_color, text) => text,
          bold: (text) => text,
        },
        { matches: () => false },
        (result) => {
          if (closed) return;
          closed = true;
          hideTopOverlay();
          resolve(result);
        },
      );
      panes.push({
        component,
        options: customOptions,
        isClosed: () => closed,
        hasHandle: () => ownedHandle !== undefined,
        isMounted: () => ownedHandle !== undefined && mounted.has(ownedHandle),
      });
      queueMicrotask(() => {
        if (closed) return;
        ownedHandle = showOverlay();
        const onHandle = (
          customOptions as
            | { onHandle?: (handle: FakeOverlayHandle) => void }
            | undefined
        )?.onHandle;
        onHandle?.(ownedHandle);
      });
    });
  const ctx = {
    cwd: "/repo",
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    model: parentModel,
    modelRegistry: {} as ModelRegistry,
    sessionManager,
    signal: undefined,
    ui: {
      input: async () => undefined,
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
      setStatus: (key: string, value: string | undefined) => {
        statuses.push({ key, value });
      },
      ...(options.customUi === false ? {} : { custom }),
    },
    isIdle: () => idle,
    waitForIdle: async () => {
      order.push("wait");
      idle = true;
    },
    getSystemPrompt: () => "current system",
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    order,
    notifications,
    statuses,
    panes,
    mountForeignOverlay: () => {
      const handle = showOverlay();
      return { isMounted: () => mounted.has(handle) };
    },
    sessionManager,
  };
};

const historyRecord = (
  id: string,
  question: string,
  answer: string,
  createdAt: number,
): BtwHistoryData => ({
  version: 1,
  id,
  question,
  answer,
  answerTruncated: false,
  model: "test-provider/test-model",
  createdAt,
});

const answerPane = (
  histories: BtwHistoryData[],
  selectedId?: string,
  rows = 10,
) => {
  let renders = 0;
  let closes = 0;
  const component = new BtwAnswerPaneComponent(
    histories,
    selectedId,
    {
      terminal: { rows },
      requestRender: () => {
        renders += 1;
      },
    },
    { matches: () => false },
    () => {
      closes += 1;
    },
  );
  return {
    component,
    renderCount: () => renders,
    closeCount: () => closes,
  };
};

describe("BTW answer pane", () => {
  test("starts on the selected latest answer and switches history with Up/Down", () => {
    const oldest = historyRecord("oldest", "old question", "old answer", 1);
    const middle = historyRecord(
      "middle",
      "middle question",
      "middle answer",
      2,
    );
    const latest = historyRecord(
      "latest",
      "latest question",
      "latest answer",
      3,
    );
    const pane = answerPane([oldest, middle, latest], latest.id);

    expect(pane.component.getSelectedId()).toBe("latest");
    expect(pane.component.render(60).join("\n")).toContain("latest answer");

    pane.component.handleInput("up");
    expect(pane.component.getSelectedId()).toBe("middle");
    expect(pane.component.render(60).join("\n")).toContain("middle answer");

    pane.component.handleInput("up");
    pane.component.handleInput("up");
    expect(pane.component.getSelectedId()).toBe("oldest");
    pane.component.handleInput("down");
    expect(pane.component.getSelectedId()).toBe("middle");
    expect(pane.renderCount()).toBe(3);
  });

  test("scrolls long answers with page and boundary keys and resets on history change", () => {
    const long = historyRecord(
      "long",
      "long question",
      Array.from({ length: 30 }, (_, index) => `answer line ${index}`).join(
        "\n",
      ),
      2,
    );
    const pane = answerPane(
      [historyRecord("short", "short question", "short answer", 1), long],
      long.id,
      8,
    );
    pane.component.render(40);

    pane.component.handleInput("pagedown");
    expect(pane.component.getOffset()).toBeGreaterThan(0);
    pane.component.handleInput("end");
    expect(pane.component.render(40).join("\n")).toContain("answer line 29");
    pane.component.handleInput("home");
    expect(pane.component.getOffset()).toBe(0);

    pane.component.handleInput("pagedown");
    pane.component.handleInput("up");
    expect(pane.component.getSelectedId()).toBe("short");
    expect(pane.component.getOffset()).toBe(0);
  });

  test("sanitizes and width-bounds content and supports detail-view close keys", () => {
    const unsafe = historyRecord(
      "unsafe",
      "question\u001b]2;owned\u0007safe",
      "answer\u001b[31m red\u001b[0m 界😀".repeat(8),
      1,
    );
    const pane = answerPane([unsafe], unsafe.id, 12);
    const lines = pane.component.render(24);
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.join("\n")).toContain("questionsafe");
    expect(lines.every((item) => visibleWidth(item) <= 24)).toBe(true);

    pane.component.handleInput("escape");
    pane.component.handleInput("left");
    pane.component.handleInput("b");
    pane.component.handleInput("q");
    expect(pane.closeCount()).toBe(4);
  });
});

describe("BTW parent command", () => {
  test("starts from an immediate snapshot and retains Q/A only as a parent custom entry", async () => {
    const harness = commandHarness();
    const context = commandContext();
    let received: BtwSnapshot | undefined;
    setupBtw(harness.pi, {
      now: () => 1234,
      createId: () => "btw-1",
      answerQuestion: async (value) => {
        context.order.push("answer");
        received = value;
        return "answer text";
      },
    });

    await harness.command().handler("  side question  ", context.ctx);
    await waitFor(() => harness.entries.length === 1);

    expect(context.order).toEqual(["answer"]);
    expect(received?.messages).toEqual([userMessage("main question")]);
    expect(received?.systemPrompt).toBe("current system");
    expect(received?.thinkingLevel).toBe("high");
    expect(harness.entries).toEqual([
      {
        customType: HISTORY_TYPE,
        data: {
          version: 1,
          id: "btw-1",
          question: "side question",
          answer: "answer text",
          answerTruncated: false,
          model: "test-provider/test-model",
          createdAt: 1234,
        },
      },
    ]);

    expect(harness.rendererRegistered()).toBe(false);
    expect(context.panes).toHaveLength(1);
    expect(context.panes[0]?.component.getSelectedId()).toBe("btw-1");
    expect(context.panes[0]?.options).toMatchObject({
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        anchor: "center",
        margin: 0,
      },
    });

    // Custom entries are durable hidden session state, not LLM messages.
    context.sessionManager.appendCustomEntry(
      HISTORY_TYPE,
      harness.entries[0].data,
    );
    expect(
      buildSessionContext(context.sessionManager.getEntries()).messages,
    ).toEqual([userMessage("main question")]);
  });

  test("loads branch history into the pane and closes it on tree and session changes", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: true });
    context.sessionManager.appendCustomEntry(
      HISTORY_TYPE,
      historyRecord("older", "older question", "older answer", 1),
    );
    context.sessionManager.appendCustomEntry(HISTORY_TYPE, {
      version: 1,
      id: "malformed",
      question: "ignored",
    });
    let invocation = 0;
    setupBtw(harness.pi, {
      now: () => 10 + invocation,
      createId: () => `current-${++invocation}`,
      answerQuestion: async () => `current answer ${invocation + 1}`,
    });

    await harness.command().handler("current question", context.ctx);
    await waitFor(() => context.panes.length === 1);
    const [firstPane] = context.panes;
    await waitFor(() => firstPane?.hasHandle() === true);
    expect(firstPane?.component.getSelectedId()).toBe("current-1");
    firstPane?.component.handleInput("up");
    expect(firstPane?.component.getSelectedId()).toBe("older");
    expect(firstPane?.component.render(60).join("\n")).toContain(
      "older answer",
    );

    const foreignOverlay = context.mountForeignOverlay();
    expect(foreignOverlay.isMounted()).toBe(true);
    await harness.emitSessionBeforeTree();
    expect(firstPane?.isClosed()).toBe(true);
    expect(firstPane?.isMounted()).toBe(false);
    expect(foreignOverlay.isMounted()).toBe(true);

    await harness.command().handler("another question", context.ctx);
    await waitFor(() => context.panes.length === 2);
    const [, secondPane] = context.panes;
    await waitFor(() => secondPane?.hasHandle() === true);
    expect(secondPane?.isClosed()).toBe(false);
    await harness.emitSessionStart();
    expect(secondPane?.isClosed()).toBe(true);
    expect(secondPane?.isMounted()).toBe(false);
    expect(foreignOverlay.isMounted()).toBe(true);
  });

  test("reopens persisted history without a model call and preserves branch order", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: true });
    context.sessionManager.appendCustomEntry(
      HISTORY_TYPE,
      historyRecord("first", "first question", "first answer", 100),
    );
    context.sessionManager.appendCustomEntry(
      HISTORY_TYPE,
      historyRecord("second", "second question", "second answer", 1),
    );
    let answerCalls = 0;
    setupBtw(harness.pi, {
      answerQuestion: async () => {
        answerCalls += 1;
        return "unexpected";
      },
    });

    await harness.command("btw-history").handler("", context.ctx);
    expect(context.panes).toHaveLength(1);
    const [firstPane] = context.panes;
    expect(firstPane?.component.getSelectedId()).toBe("second");
    firstPane?.component.handleInput("up");
    expect(firstPane?.component.getSelectedId()).toBe("first");
    firstPane?.component.handleInput("b");
    expect(firstPane?.isClosed()).toBe(true);

    await harness.command("btw-history").handler("", context.ctx);
    expect(context.panes).toHaveLength(2);
    expect(context.panes[1]?.component.getSelectedId()).toBe("second");
    expect(answerCalls).toBe(0);
  });

  test("reports unavailable or unsupported BTW history without opening a pane", async () => {
    const emptyHarness = commandHarness();
    const emptyContext = commandContext({ idle: true });
    setupBtw(emptyHarness.pi);
    await emptyHarness.command("btw-history").handler("", emptyContext.ctx);
    expect(emptyContext.panes).toHaveLength(0);
    expect(emptyContext.notifications.at(-1)).toEqual({
      message: "No BTW answers are available on this branch.",
      level: "warning",
    });

    const rpcHarness = commandHarness();
    const rpcContext = commandContext({ idle: true, mode: "rpc" });
    rpcContext.sessionManager.appendCustomEntry(
      HISTORY_TYPE,
      historyRecord("saved", "question", "answer", 1),
    );
    setupBtw(rpcHarness.pi);
    await rpcHarness.command("btw-history").handler("", rpcContext.ctx);
    expect(rpcContext.panes).toHaveLength(0);
    expect(rpcContext.notifications.at(-1)).toEqual({
      message: "BTW answer history requires TUI mode.",
      level: "warning",
    });

    const printHarness = commandHarness();
    const printContext = commandContext({
      idle: true,
      mode: "print",
      hasUI: false,
    });
    setupBtw(printHarness.pi);
    await expect(
      printHarness.command("btw-history").handler("", printContext.ctx),
    ).rejects.toThrow("BTW answer history requires TUI mode");
  });

  test("warns without mixing the answer into notifications when custom TUI is unavailable", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: true, customUi: false });
    setupBtw(harness.pi, {
      answerQuestion: async () => "pane-only answer",
    });

    await harness.command().handler("question", context.ctx);
    await waitFor(() => harness.entries.length === 1);
    expect(context.panes).toHaveLength(0);
    expect(context.notifications).toEqual([
      {
        message: "BTW answer pane requires custom TUI support.",
        level: "warning",
      },
    ]);
  });

  test("freezes an inline default snapshot before yielding to parent updates", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: false });
    let received: BtwSnapshot | undefined;
    setupBtw(harness.pi, {
      answerQuestion: async (value) => {
        received = value;
        return "frozen answer";
      },
    });

    const invocation = harness.command().handler("question", context.ctx);
    context.sessionManager.appendMessage(
      assistantMessage("assistant completed after acceptance"),
    );
    context.sessionManager.appendMessage(
      toolResultMessage("tool result completed after acceptance"),
    );
    context.sessionManager.appendMessage(
      userMessage("follow-up added after acceptance"),
    );
    await invocation;
    await waitFor(() => harness.entries.length === 1);

    expect(received?.messages).toEqual([userMessage("main question")]);
    expect(context.order).toEqual([]);
  });

  test("replays hidden history after parent compaction", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: true });
    setupBtw(harness.pi, {
      createId: () => "btw-compacted",
      answerQuestion: async () => "kept answer",
    });
    await harness.command().handler("kept question", context.ctx);
    await waitFor(() => harness.entries.length === 1);
    const [{ data }] = harness.entries;

    context.sessionManager.appendCustomEntry(HISTORY_TYPE, data);
    const firstKeptId = context.sessionManager.appendMessage(
      userMessage("newer parent context"),
    );
    context.sessionManager.appendCompaction(
      "parent summary",
      firstKeptId,
      10_000,
    );
    harness.entries.length = 0;

    await harness.emitSessionCompact(context.ctx);
    expect(harness.entries).toEqual([{ customType: HISTORY_TYPE, data }]);
  });

  test("uses UI input when args are empty and reports missing model without running", async () => {
    const harness = commandHarness();
    const context = commandContext();
    context.ctx.ui.input = async () => "--wait remains a literal question";
    let questions: string[] = [];
    setupBtw(harness.pi, {
      answerQuestion: async (_snapshot, question) => {
        questions.push(question);
        return "ok";
      },
    });
    await harness.command().handler("", context.ctx);
    await waitFor(() => questions.length === 1);
    expect(questions).toEqual(["--wait remains a literal question"]);
    expect(context.order).toEqual([]);

    const settledHarness = commandHarness();
    const settled = commandContext({ idle: false });
    settled.ctx.ui.input = async () => "settled from dialog";
    const settledQuestions: string[] = [];
    setupBtw(settledHarness.pi, {
      answerQuestion: async (_snapshot, question) => {
        settled.order.push("answer");
        settledQuestions.push(question);
        return "ok";
      },
    });
    await settledHarness.command().handler("--wait", settled.ctx);
    await waitFor(() => settledQuestions.length === 1);
    expect(settledQuestions).toEqual(["settled from dialog"]);
    expect(settled.order).toEqual(["wait", "answer"]);

    const noModelHarness = commandHarness();
    const noModel = commandContext();
    noModel.ctx.model = undefined;
    questions = [];
    setupBtw(noModelHarness.pi, {
      answerQuestion: async (_snapshot, question) => {
        questions.push(question);
        return "never";
      },
    });
    await noModelHarness.command().handler("question", noModel.ctx);
    expect(questions).toEqual([]);
    expect(noModel.notifications[0]?.message).toContain("No model selected");

    const noUiHarness = commandHarness();
    const noUi = commandContext({ hasUI: false });
    setupBtw(noUiHarness.pi, {
      answerQuestion: async () => "never",
    });
    await expect(
      noUiHarness.command().handler("question", noUi.ctx),
    ).rejects.toThrow("requires TUI or RPC");
    expect(noUiHarness.entries).toHaveLength(0);
  });

  test("settled mode rechecks idleness before taking its snapshot", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: false });
    let waits = 0;
    context.ctx.waitForIdle = async () => {
      waits += 1;
      context.order.push("wait");
      if (waits === 2) {
        context.sessionManager.appendMessage(
          userMessage("added while settling"),
        );
      }
    };
    context.ctx.isIdle = () => waits >= 2;
    let received: BtwSnapshot | undefined;
    setupBtw(harness.pi, {
      answerQuestion: async (snapshot) => {
        received = snapshot;
        context.order.push("answer");
        return "ok";
      },
    });

    await harness.command().handler("--wait question", context.ctx);
    await waitFor(() => context.order.includes("answer"));
    expect(context.order).toEqual(["wait", "wait", "answer"]);
    expect(received?.messages).toEqual([
      userMessage("main question"),
      userMessage("added while settling"),
    ]);
  });

  test("cancellation releases a permanently pending idle wait", async () => {
    for (const trigger of ["command", "shutdown"] as const) {
      const harness = commandHarness();
      const context = commandContext({ idle: false });
      let waiting!: () => void;
      const waitStarted = new Promise<void>((resolve) => {
        waiting = resolve;
      });
      context.ctx.waitForIdle = () => {
        waiting();
        return new Promise<void>(() => {});
      };
      let answerCalls = 0;
      setupBtw(harness.pi, {
        answerQuestion: async () => {
          answerCalls += 1;
          return "never";
        },
      });

      await harness.command().handler("--wait question", context.ctx);
      await waitStarted;
      const completion =
        trigger === "command"
          ? (async () => {
              await harness.command("btw-cancel").handler("", context.ctx);
              await harness.emitSessionShutdown();
            })()
          : harness.emitSessionShutdown();
      await Promise.race([
        completion,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("BTW cancellation hung")), 250);
        }),
      ]);

      expect(answerCalls).toBe(0);
      expect(harness.entries).toHaveLength(0);
    }
  });

  test("rejects overlapping invocations and releases the guard after completion", async () => {
    const harness = commandHarness();
    const firstContext = commandContext({ idle: true });
    const secondContext = commandContext({ idle: true });
    let release!: (value: string) => void;
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    setupBtw(harness.pi, {
      answerQuestion: async () => {
        started();
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
    });

    const first = harness.command().handler("first", firstContext.ctx);
    await hasStarted;
    await harness.command().handler("second", secondContext.ctx);
    expect(secondContext.notifications[0]?.message).toContain(
      "already running",
    );
    expect(harness.entries).toHaveLength(0);

    release("done");
    await first;
    await waitFor(() => harness.entries.length === 1);
    expect(harness.entries).toHaveLength(1);
  });

  test("cancels an in-flight child through the command and shortcut", async () => {
    for (const cancel of ["command", "shortcut"] as const) {
      const harness = commandHarness();
      const context = commandContext({ idle: true });
      let started!: () => void;
      const hasStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      setupBtw(harness.pi, {
        answerQuestion: async (value) => {
          started();
          return new Promise<string>((_resolve, reject) => {
            value.signal?.onAbort(() => reject(new Error("cancelled")));
          });
        },
      });

      const invocation = harness.command().handler("question", context.ctx);
      await hasStarted;
      // The main command must return while its child is still running so the
      // TUI can dispatch the cancellation slash command.
      await invocation;
      if (cancel === "command") {
        await harness.command("btw-cancel").handler("", context.ctx);
      } else {
        await harness.shortcut("ctrl+alt+b")(context.ctx);
      }
      await waitFor(() => context.statuses.at(-1)?.value === undefined);

      expect(harness.entries).toHaveLength(0);
      expect(context.statuses.at(-1)).toEqual({
        key: "pi-harness-btw",
        value: undefined,
      });
      expect(
        context.notifications.some(({ message }) =>
          message.includes("cancellation requested"),
        ),
      ).toBe(true);
    }
  });

  test("waits for detached cleanup during parent shutdown", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: true });
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupFinished = false;
    setupBtw(harness.pi, {
      answerQuestion: async (value) => {
        started();
        return new Promise<string>((_resolve, reject) => {
          value.signal?.onAbort(() => {
            void cleanupGate.then(() => {
              cleanupFinished = true;
              reject(new Error("cancelled after cleanup"));
            });
          });
        });
      },
    });

    const invocation = harness.command().handler("question", context.ctx);
    await hasStarted;
    await invocation;
    let shutdownSettled = false;
    const shutdown = harness.emitSessionShutdown().then(() => {
      shutdownSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shutdownSettled).toBe(false);

    releaseCleanup();
    await shutdown;
    expect(cleanupFinished).toBe(true);
    expect(harness.entries).toHaveLength(0);
  });

  test("aborts an in-flight child when a replacement session starts", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: false });
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    let calls = 0;
    setupBtw(harness.pi, {
      answerQuestion: async (snapshot) => {
        calls += 1;
        if (calls > 1) return "fresh answer";
        started();
        return new Promise<string>((_resolve, reject) => {
          snapshot.signal?.onAbort(() => {
            aborted = true;
            reject(new Error("replaced"));
          });
        });
      },
    });

    const invocation = harness.command().handler("question", context.ctx);
    await hasStarted;
    await invocation;
    await harness.emitSessionStart();
    await waitFor(() => aborted);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.entries).toHaveLength(0);

    const freshContext = commandContext({ idle: true });
    await harness.command().handler("fresh question", freshContext.ctx);
    await waitFor(() => harness.entries.length === 1);
    expect(calls).toBe(2);
  });

  test("drops an answer when parent tree navigation changes the active branch", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: true });
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (answer: string) => void;
    setupBtw(harness.pi, {
      answerQuestion: async () => {
        started();
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
    });

    const invocation = harness.command().handler("branch A", context.ctx);
    await hasStarted;
    await invocation;
    await harness.emitSessionBeforeTree();
    release("late branch A answer");
    await waitFor(() => context.statuses.at(-1)?.value === undefined);

    expect(harness.entries).toHaveLength(0);
  });

  test("requires a durable parent before retaining resumable history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-btw-session-"));
    try {
      const sessionManager = SessionManager.create("/repo", directory);
      sessionManager.appendMessage(userMessage("first parent prompt"));
      const context = commandContext({ idle: true });
      Object.assign(context.ctx, { sessionManager });
      const harness = commandHarness((customType, data) => {
        sessionManager.appendCustomEntry(customType, data);
      });
      let calls = 0;
      setupBtw(harness.pi, {
        answerQuestion: async () => {
          calls += 1;
          return "durable answer";
        },
      });

      await harness.command().handler("too early", context.ctx);
      await waitFor(() => context.notifications.length > 0);
      expect(calls).toBe(0);
      expect(context.notifications.at(-1)?.message).toContain(
        "not durable until the parent completes",
      );
      expect(harness.entries).toHaveLength(0);

      sessionManager.appendMessage(assistantMessage("parent answer"));
      await harness.command().handler("now durable", context.ctx);
      await waitFor(() => harness.entries.length === 1);

      const sessionFile = sessionManager.getSessionFile();
      if (sessionFile === undefined) throw new Error("missing session file");
      const persisted = await readFile(sessionFile, "utf8");
      expect(persisted).toContain(`"customType":"${HISTORY_TYPE}"`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps a real parent session linear when BTW finishes during streaming", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-btw-concurrent-"));
    try {
      const sessionManager = SessionManager.create("/repo", directory);
      sessionManager.appendMessage(userMessage("completed parent prompt"));
      sessionManager.appendMessage(assistantMessage("completed parent answer"));
      const streamingPromptId = sessionManager.appendMessage(
        userMessage("streaming parent prompt"),
      );
      const beforeBtw = structuredClone(
        sessionManager.buildSessionContext().messages,
      );

      const context = commandContext({ idle: false });
      Object.assign(context.ctx, { sessionManager });
      const harness = commandHarness((customType, data) => {
        sessionManager.appendCustomEntry(customType, data);
      });
      let received: BtwSnapshot | undefined;
      setupBtw(harness.pi, {
        answerQuestion: async (snapshot) => {
          received = snapshot;
          return "concurrent side answer";
        },
      });

      await harness.command().handler("parallel side question", context.ctx);
      await waitFor(() => harness.entries.length === 1);

      expect(context.order).toEqual([]);
      expect(received?.messages).toEqual(beforeBtw);
      expect(sessionManager.buildSessionContext().messages).toEqual(beforeBtw);
      const customEntry = sessionManager.getBranch().at(-1);
      if (customEntry?.type !== "custom") {
        throw new Error("missing concurrent BTW history entry");
      }
      expect(customEntry.parentId).toBe(streamingPromptId);
      const history = customEntry.data as BtwHistoryData;

      const completedStreamingAnswer = assistantMessage(
        "completed streaming answer",
      );
      const parentAnswerId = sessionManager.appendMessage(
        completedStreamingAnswer,
      );
      const completedToolResult = toolResultMessage(
        "completed streaming tool result",
      );
      const toolResultId = sessionManager.appendMessage(completedToolResult);
      const branch = sessionManager.getBranch();
      const parentAnswerEntry = sessionManager.getEntry(parentAnswerId);
      expect(parentAnswerEntry?.parentId).toBe(customEntry.id);
      expect(sessionManager.getEntry(toolResultId)?.parentId).toBe(
        parentAnswerId,
      );
      expect(sessionManager.getLeafId()).toBe(toolResultId);
      expect(branch.map((entry) => entry.type)).toEqual([
        "message",
        "message",
        "message",
        "custom",
        "message",
        "message",
      ]);
      expect(
        branch.flatMap((entry) =>
          entry.type === "message" ? [entry.message] : [],
        ),
      ).toEqual([...beforeBtw, completedStreamingAnswer, completedToolResult]);
      const parentContext = sessionManager.buildSessionContext().messages;
      expect(parentContext).toEqual([
        ...beforeBtw,
        completedStreamingAnswer,
        completedToolResult,
      ]);
      expect(JSON.stringify(parentContext)).not.toContain(
        "parallel side question",
      );
      expect(JSON.stringify(parentContext)).not.toContain(
        "concurrent side answer",
      );

      const tree = sessionManager.getTree();
      expect(tree).toHaveLength(1);
      let [node] = tree;
      let nodeCount = 0;
      while (node !== undefined) {
        nodeCount += 1;
        expect(node.children.length).toBeLessThanOrEqual(1);
        [node] = node.children;
      }
      expect(nodeCount).toBe(branch.length);

      const sessionFile = sessionManager.getSessionFile();
      if (sessionFile === undefined) throw new Error("missing session file");
      const resumed = SessionManager.open(sessionFile, directory);
      expect(
        resumed
          .getBranch()
          .map(({ id, parentId, type }) => ({ id, parentId, type })),
      ).toEqual(
        branch.map(({ id, parentId, type }) => ({ id, parentId, type })),
      );
      expect(resumed.getLeafId()).toBe(toolResultId);
      expect(resumed.buildSessionContext().messages).toEqual(parentContext);
      expect(
        resumed
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom" && entry.customType === HISTORY_TYPE,
          ),
      ).toHaveLength(1);

      sessionManager.appendCompaction(
        "compacted parent context",
        parentAnswerId,
        10_000,
      );
      harness.entries.length = 0;
      await harness.emitSessionCompact(context.ctx);
      expect(harness.entries).toHaveLength(1);

      const visibleHistories = sessionManager
        .buildContextEntries()
        .filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === HISTORY_TYPE &&
            (entry.data as BtwHistoryData | undefined)?.id === history.id,
        );
      const rawHistories = sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === HISTORY_TYPE &&
            (entry.data as BtwHistoryData | undefined)?.id === history.id,
        );
      expect(visibleHistories).toHaveLength(1);
      expect(rawHistories).toHaveLength(2);
      const compactedContext = sessionManager.buildSessionContext().messages;
      expect(JSON.stringify(compactedContext)).not.toContain(
        "parallel side question",
      );
      expect(JSON.stringify(compactedContext)).not.toContain(
        "concurrent side answer",
      );

      const resumedCompacted = SessionManager.open(sessionFile, directory);
      expect(
        resumedCompacted
          .buildContextEntries()
          .filter(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === HISTORY_TYPE &&
              (entry.data as BtwHistoryData | undefined)?.id === history.id,
          ),
      ).toHaveLength(1);
      expect(
        resumedCompacted
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === HISTORY_TYPE &&
              (entry.data as BtwHistoryData | undefined)?.id === history.id,
          ),
      ).toHaveLength(2);
      expect(resumedCompacted.buildSessionContext().messages).toEqual(
        compactedContext,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("aborts an argument-less dialog when the parent shuts down", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: true });
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    context.ctx.ui.input = async (_title, _placeholder, options) => {
      started();
      return new Promise<string | undefined>((resolve) => {
        const signal = options?.signal as unknown as {
          aborted: boolean;
          addEventListener(
            type: "abort",
            listener: () => void,
            options?: { once?: boolean },
          ): void;
        };
        if (signal.aborted) resolve(undefined);
        else {
          signal.addEventListener("abort", () => resolve(undefined), {
            once: true,
          });
        }
      });
    };
    setupBtw(harness.pi, { answerQuestion: async () => "never" });

    const invocation = harness.command().handler("", context.ctx);
    await hasStarted;
    await harness.emitSessionShutdown();
    await invocation;
    expect(harness.entries).toHaveLength(0);
  });

  test("drops a late old-session answer without stale context access", async () => {
    const harness = commandHarness();
    const oldContext = commandContext({ idle: true, mode: "rpc" });
    let stale = false;
    for (const property of ["hasUI", "ui", "mode"] as const) {
      const value = oldContext.ctx[property];
      Object.defineProperty(oldContext.ctx, property, {
        get: () => {
          if (stale) throw new Error("stale command context");
          return value;
        },
      });
    }
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (answer: string) => void;
    let calls = 0;
    setupBtw(harness.pi, {
      answerQuestion: async (value) => {
        calls += 1;
        if (calls > 1) return "fresh answer";
        started();
        value.signal?.onAbort(() => {
          stale = true;
        });
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
    });

    const invocation = harness
      .command()
      .handler("old question", oldContext.ctx);
    await hasStarted;
    const shutdown = harness.emitSessionShutdown();
    release("late answer");
    await shutdown;
    await harness.emitSessionStart();
    await invocation;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.entries).toHaveLength(0);
    expect(oldContext.notifications).toHaveLength(0);

    const newContext = commandContext({ idle: true, mode: "rpc" });
    await harness.command().handler("new question", newContext.ctx);
    await waitFor(() => harness.entries.length === 1);
    expect(calls).toBe(2);
    expect(harness.entries).toHaveLength(1);
    expect(harness.entries[0].data).toMatchObject({ answer: "fresh answer" });
    expect(newContext.notifications.at(-1)?.message).toContain("fresh answer");
  });

  test("bounds questions and retained answers without splitting UTF-8", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: true });
    let calls = 0;
    setupBtw(harness.pi, {
      answerQuestion: async () => {
        calls += 1;
        return "😀".repeat(ANSWER_MAX_BYTES);
      },
    });

    await harness
      .command()
      .handler("x".repeat(QUESTION_MAX_BYTES + 1), context.ctx);
    expect(calls).toBe(0);
    expect(context.notifications[0]?.message).toContain("exceeds");

    await harness.command().handler("bounded", context.ctx);
    await waitFor(() => harness.entries.length === 1);
    const data = harness.entries[0].data as BtwHistoryData;
    expect(data.answerTruncated).toBe(true);
    expect(Buffer.byteLength(data.answer, "utf8")).toBeLessThanOrEqual(
      ANSWER_MAX_BYTES,
    );
    expect(data.answer).not.toContain("�");

    expect(truncateUtf8("short", ANSWER_MAX_BYTES)).toEqual({
      text: "short",
      truncated: false,
    });
  });

  test("returns the answer through RPC UI as well as parent history", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: true, mode: "rpc" });
    setupBtw(harness.pi, {
      answerQuestion: async () => "rpc answer",
    });

    await harness.command().handler("rpc question", context.ctx);
    await waitFor(() => harness.entries.length === 1);
    expect(harness.entries).toHaveLength(1);
    expect(
      context.notifications.some(({ message }) =>
        message.includes("rpc answer"),
      ),
    ).toBe(true);
  });

  test("sanitizes terminal controls before persistence and pane rendering", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: true });
    setupBtw(harness.pi, {
      createId: () => "safe-id",
      answerQuestion: async () => "answer\u001b]2;owned\u0007safe",
    });
    await harness.command().handler("question\u001b[31mred", context.ctx);
    await waitFor(() => harness.entries.length === 1);
    const data = harness.entries[0].data as BtwHistoryData;
    expect(JSON.stringify(data)).not.toContain("\u001b");

    await waitFor(() => context.panes.length === 1);
    const rendered = context.panes[0]?.component.render(80).join("\n") ?? "";
    expect(rendered).not.toContain("\u001b");
    expect(rendered).toContain("answersafe");

    const emptyHarness = commandHarness();
    const emptyContext = commandContext({ idle: true });
    let calls = 0;
    setupBtw(emptyHarness.pi, {
      answerQuestion: async () => {
        calls += 1;
        return "\u001b[31m";
      },
    });
    await emptyHarness.command().handler("\u001b[31m", emptyContext.ctx);
    expect(calls).toBe(0);
    const notificationCount = emptyContext.notifications.length;
    await emptyHarness.command().handler("visible", emptyContext.ctx);
    await waitFor(() => emptyContext.notifications.length > notificationCount);
    expect(emptyContext.notifications.at(-1)?.message).toContain(
      "no displayable text answer",
    );
    expect(calls).toBe(1);
    expect(emptyHarness.entries).toHaveLength(0);
  });

  test("sanitizes and bounds failures from input and child execution", async () => {
    const rawError = `bad\u001b]2;owned\u0007${"x".repeat(
      ERROR_MAX_BYTES * 2,
    )}`;
    for (const source of ["input", "child"] as const) {
      const harness = commandHarness();
      const context = commandContext({ idle: true });
      if (source === "input") {
        context.ctx.ui.input = async () => {
          throw new Error(rawError);
        };
      }
      setupBtw(harness.pi, {
        answerQuestion: async () => {
          throw new Error(rawError);
        },
      });

      await harness
        .command()
        .handler(source === "input" ? "" : "question", context.ctx);
      await waitFor(() => context.notifications.length > 0);
      const message = context.notifications.at(-1)?.message ?? "";
      expect(message).not.toContain("\u001b");
      expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(
        ERROR_MAX_BYTES + Buffer.byteLength("BTW failed: ", "utf8"),
      );
      expect(message).toEndWith("…");
    }
  });

  test("does not register a transcript renderer for persisted BTW history", () => {
    const harness = commandHarness();
    setupBtw(harness.pi);
    expect(harness.rendererRegistered()).toBe(false);
  });
});

describe("BTW umbrella lifecycle", () => {
  test("registers only in parent harness profiles", () => {
    const paths = resolvePaths("/tmp/pi-btw-config");
    const parent = createFakePi();
    const parentConfig = loadConfig({}, paths);
    parentConfig.features.subagent = false;
    parentConfig.features.workflow = false;
    setupHarness(parent, parentConfig);
    expect(parent.commands.has("btw")).toBe(true);
    expect(parent.commands.has("btw-history")).toBe(true);
    expect(parent.commands.has("btw-cancel")).toBe(true);
    expect(parent.shortcuts.has("ctrl+alt+b")).toBe(true);

    const child = createFakePi();
    const childConfig = loadConfig({ PI_HARNESS_CHILD: "1" }, paths);
    childConfig.features.subagent = false;
    childConfig.features.workflow = false;
    setupHarness(child, childConfig);
    expect(child.commands.has("btw")).toBe(false);
    expect(child.commands.has("btw-history")).toBe(false);
  });
});
