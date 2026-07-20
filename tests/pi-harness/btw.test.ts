import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai/compat";
import {
  buildSessionContext,
  type CreateAgentSessionOptions,
  type EntryRenderer,
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
  HISTORY_TYPE,
  QUESTION_MAX_BYTES,
  truncateUtf8,
} from "../../pi/extensions/pi-harness/features/btw/index";
import { loadConfig } from "../../pi/extensions/pi-harness/config";
import { setupHarness } from "../../pi/extensions/pi-harness/index";
import type { PiLike } from "../../pi/extensions/pi-harness/lib/pi-like";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
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
  renderer: () => EntryRenderer<BtwHistoryData>;
  entries: { customType: string; data: unknown }[];
  emitSessionCompact(ctx: ExtensionCommandContext): Promise<void>;
  emitSessionStart(): Promise<void>;
  emitSessionShutdown(): Promise<void>;
}

const commandHarness = (): CommandHarness => {
  const commands = new Map<string, RegisteredCommand>();
  const shortcuts = new Map<
    string,
    (ctx: ExtensionContext) => Promise<void> | void
  >();
  let renderer: EntryRenderer<BtwHistoryData> | undefined;
  let compactHandler:
    | ((
        event: { type: string },
        ctx: ExtensionCommandContext,
      ) => Promise<void> | void)
    | undefined;
  let startHandler: (() => Promise<void> | void) | undefined;
  let shutdownHandler: (() => Promise<void> | void) | undefined;
  const entries: { customType: string; data: unknown }[] = [];
  const pi = {
    on(event: string, handler: () => Promise<void> | void) {
      if (event === "session_compact") {
        compactHandler = handler as unknown as typeof compactHandler;
      }
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
    registerEntryRenderer(
      customType: string,
      value: EntryRenderer<BtwHistoryData>,
    ) {
      if (customType === HISTORY_TYPE) renderer = value;
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
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
    renderer: () => {
      if (!renderer) throw new Error("renderer was not registered");
      return renderer;
    },
    entries,
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

interface ContextHarness {
  ctx: ExtensionCommandContext;
  order: string[];
  notifications: { message: string; level?: string }[];
  statuses: { key: string; value: string | undefined }[];
  sessionManager: SessionManager;
}

const commandContext = (
  options: {
    hasUI?: boolean;
    idle?: boolean;
    mode?: "tui" | "rpc";
  } = {},
): ContextHarness => {
  const sessionManager = SessionManager.inMemory("/repo");
  sessionManager.appendMessage(userMessage("main question"));
  const order: string[] = [];
  const notifications: { message: string; level?: string }[] = [];
  const statuses: { key: string; value: string | undefined }[] = [];
  let idle = options.idle ?? false;
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
    },
    isIdle: () => idle,
    waitForIdle: async () => {
      order.push("wait");
      idle = true;
    },
    getSystemPrompt: () => "current system",
  } as unknown as ExtensionCommandContext;
  return { ctx, order, notifications, statuses, sessionManager };
};

describe("BTW parent command", () => {
  test("waits for a stable snapshot and retains Q/A only as a parent custom entry", async () => {
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

    expect(context.order).toEqual(["wait", "answer"]);
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

    // Custom entries are durable/renderable session state, not LLM messages.
    context.sessionManager.appendCustomEntry(
      HISTORY_TYPE,
      harness.entries[0].data,
    );
    expect(
      buildSessionContext(context.sessionManager.getEntries()).messages,
    ).toEqual([userMessage("main question")]);
  });

  test("replays hidden history after parent compaction", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: true });
    setupBtw(harness.pi, {
      createId: () => "btw-compacted",
      answerQuestion: async () => "kept answer",
    });
    await harness.command().handler("kept question", context.ctx);
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
    context.ctx.ui.input = async () => "from dialog";
    let questions: string[] = [];
    setupBtw(harness.pi, {
      answerQuestion: async (_snapshot, question) => {
        questions.push(question);
        return "ok";
      },
    });
    await harness.command().handler("", context.ctx);
    expect(questions).toEqual(["from dialog"]);

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

  test("rechecks idleness before taking the synchronous snapshot", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: false });
    let waits = 0;
    context.ctx.waitForIdle = async () => {
      waits += 1;
      context.order.push("wait");
    };
    context.ctx.isIdle = () => waits >= 2;
    setupBtw(harness.pi, {
      answerQuestion: async () => {
        context.order.push("answer");
        return "ok";
      },
    });

    await harness.command().handler("question", context.ctx);
    expect(context.order).toEqual(["wait", "wait", "answer"]);
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
      if (cancel === "command") {
        await harness.command("btw-cancel").handler("", context.ctx);
      } else {
        await harness.shortcut("ctrl+alt+b")(context.ctx);
      }
      await invocation;

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
    await harness.emitSessionShutdown();
    await harness.emitSessionStart();
    release("late answer");
    await invocation;

    expect(harness.entries).toHaveLength(0);
    expect(oldContext.notifications).toHaveLength(0);

    const newContext = commandContext({ idle: true, mode: "rpc" });
    await harness.command().handler("new question", newContext.ctx);
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
    expect(harness.entries).toHaveLength(1);
    expect(
      context.notifications.some(({ message }) =>
        message.includes("rpc answer"),
      ),
    ).toBe(true);
  });

  test("sanitizes terminal controls before persistence and rendering", async () => {
    const harness = commandHarness();
    const context = commandContext({ idle: true });
    setupBtw(harness.pi, {
      createId: () => "safe-id",
      answerQuestion: async () => "answer\u001b]2;owned\u0007safe",
    });
    await harness.command().handler("question\u001b[31mred", context.ctx);
    const data = harness.entries[0].data as BtwHistoryData;
    expect(JSON.stringify(data)).not.toContain("\u001b");

    const component = harness.renderer()(
      {
        data: {
          ...data,
          answer: "raw\u001b[31mcontrol",
          model: "model\u001b]2;owned\u0007",
        },
      } as never,
      { expanded: true },
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
    );
    expect(component?.render(80).join("\n")).not.toContain("\u001b");

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
    await emptyHarness.command().handler("visible", emptyContext.ctx);
    expect(calls).toBe(1);
    expect(emptyHarness.entries).toHaveLength(0);
  });

  test("renders malformed resumed history defensively", () => {
    const harness = commandHarness();
    setupBtw(harness.pi);
    const renderer = harness.renderer();
    const component = renderer({ data: null } as never, { expanded: false }, {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never);
    expect(component?.render(80).join("\n")).toContain("malformed");
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
    expect(parent.commands.has("btw-cancel")).toBe(true);
    expect(parent.shortcuts.has("ctrl+alt+b")).toBe(true);

    const child = createFakePi();
    const childConfig = loadConfig({ PI_HARNESS_CHILD: "1" }, paths);
    childConfig.features.subagent = false;
    childConfig.features.workflow = false;
    setupHarness(child, childConfig);
    expect(child.commands.has("btw")).toBe(false);
  });
});
