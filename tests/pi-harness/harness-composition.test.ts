import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
  loadConfig,
  type HarnessConfig,
} from "../../pi/extensions/pi-harness/config";
import type { MemoryAggregate } from "../../pi/extensions/pi-harness/features/agent-memory/cli";
import {
  AgentMemoryRegistry,
  type AgentMemoryDataSource,
} from "../../pi/extensions/pi-harness/features/agent-memory/registry";
import {
  BitIssueCli,
  BoundedCommandError,
  type BoundedCommandResult,
  type RunBoundedCommand,
} from "../../pi/extensions/pi-harness/features/bit-issues/cli";
import setupChildRuns from "../../pi/extensions/pi-harness/features/child-runs/index";
import { setupHarness } from "../../pi/extensions/pi-harness/index";
import type { PiLike } from "../../pi/extensions/pi-harness/lib/pi-like";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { createFakePi } from "./fake-pi";
import { createSdkExtensionRunner } from "./sdk-extension-runner";

const config = (
  name: string,
  features: Pick<
    HarnessConfig["features"],
    "bit-task" | "subagent" | "workflow"
  >,
): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": false,
    subagent: features.subagent,
    workflow: features.workflow,
    "bit-task": features["bit-task"],
    "agent-memory": false,
    statusline: false,
    "provider-log": false,
    "asuku-notify": false,
    "ask-user-question": false,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths(`/tmp/${name}`),
});

const harnessInstances: ReturnType<typeof createFakePi>[] = [];
const harnessHomes: string[] = [];

const temporaryHarnessPaths = async (prefix: string) => {
  const home = await fs.mkdtemp(join(tmpdir(), `${prefix}-`));
  harnessHomes.push(home);
  return resolvePaths(home);
};

const registration = (value: HarnessConfig) => {
  const pi = createFakePi({ cwd: value.paths.home });
  harnessInstances.push(pi);
  const commandCalls: Parameters<PiLike["registerCommand"]>[] = [];
  const api: PiLike = {
    ...pi,
    registerCommand(...args) {
      commandCalls.push(args);
      pi.registerCommand(...args);
    },
  };
  setupHarness(api, value);
  return {
    pi,
    commands: pi.commands,
    commandCalls,
    shortcuts: pi.shortcuts,
    tools: pi.tools.map((tool) => tool.name),
  };
};

describe("pi-harness coordination browser composition", () => {
  afterEach(async () => {
    await Promise.all(
      harnessInstances.splice(0).map((pi) => pi.emitSessionShutdown()),
    );
    await Promise.all(
      harnessHomes
        .splice(0)
        .map((home) => fs.rm(home, { recursive: true, force: true })),
    );
  });

  test("mounts the shared browser surface for bit-task only", async () => {
    const registered = registration(
      config("pi-composition-bit", {
        subagent: false,
        workflow: false,
        "bit-task": true,
      }),
    );
    expect(registered.commands.has("subagents")).toBe(true);
    expect(registered.commands.has("bit-issues")).toBe(true);
    expect(registered.shortcuts.has("ctrl+alt+s")).toBe(true);
    expect(registered.shortcuts.has("ctrl+alt+i")).toBe(true);
    expect(registered.tools).toContain("task_completed");
    expect(registered.tools).not.toContain("subagent");
    expect(registered.tools).not.toContain("subagent_status");
    expect(registered.tools).not.toContain("workflow");
    const injection = await registered.pi.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "inspect local issues",
      systemPrompt: "base",
    });
    expect(injection?.systemPrompt).not.toContain(
      "Background agent completion",
    );
  });

  test("does not register the bit source for child-only composition", () => {
    const registered = registration(
      config("pi-composition-child", {
        subagent: true,
        workflow: false,
        "bit-task": false,
      }),
    );
    expect(registered.commands.has("subagents")).toBe(true);
    expect(registered.commands.has("bit-issues")).toBe(false);
    expect(registered.shortcuts.has("ctrl+alt+i")).toBe(false);
    expect(registered.tools).toContain("subagent");
    expect(registered.tools).toContain("subagent_status");
  });

  test("registers one shared command pair when both sources are enabled", () => {
    const registered = registration(
      config("pi-composition-both", {
        subagent: true,
        workflow: true,
        "bit-task": true,
      }),
    );
    expect(
      registered.commandCalls
        .map(([name]) => name)
        .filter((name) => name === "subagents" || name === "bit-issues"),
    ).toEqual(["subagents", "bit-issues"]);
    expect(registered.tools).toEqual(
      expect.arrayContaining([
        "subagent",
        "subagent_status",
        "workflow",
        "worktree_create",
        "worktree_remove",
        "task_completed",
      ]),
    );
  });

  test("keeps the safety floor while invalid child-run config disables orchestrators", async () => {
    const value = config("pi-composition-invalid-child-runs", {
      subagent: true,
      workflow: true,
      "bit-task": false,
    });
    value.paths = await temporaryHarnessPaths(
      "pi-composition-invalid-child-runs",
    );
    value.childRuns = {
      maxConcurrent: 32,
      configurationError: "invalid childRuns fields: maxConcurrent",
    };
    const registered = registration(value);

    expect(
      await registered.pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "invalid-child-runs-safety",
        input: { command: "rm -rf /" },
      }),
    ).toEqual({ block: true, reason: expect.any(String) });

    const invoke = (name: "subagent" | "workflow", params: unknown) => {
      const tool = registered.pi.tools.find(
        (candidate) => candidate.name === name,
      );
      if (tool === undefined) throw new Error(`missing ${name} tool`);
      return Promise.resolve(
        Reflect.apply(tool.execute, undefined, [
          `invalid-child-runs-${name}`,
          params,
          undefined,
          undefined,
          registered.pi.ctx,
        ]),
      );
    };
    await expect(
      invoke("subagent", { agent: "worker", task: "must not run" }),
    ).rejects.toThrow(
      "pi-harness childRuns configuration error: invalid childRuns fields: maxConcurrent",
    );
    await expect(
      invoke("workflow", {
        stages: [
          {
            mode: "single",
            tasks: [{ agentType: "worker", task: "must not run" }],
          },
        ],
      }),
    ).rejects.toThrow(
      "pi-harness childRuns configuration error: invalid childRuns fields: maxConcurrent",
    );
  });

  test("omits the browser when all three sources are disabled", () => {
    const registered = registration(
      config("pi-composition-disabled", {
        subagent: false,
        workflow: false,
        "bit-task": false,
      }),
    );
    expect(registered.commands.has("subagents")).toBe(false);
    expect(registered.commands.has("bit-issues")).toBe(false);
    expect(registered.shortcuts.has("ctrl+alt+s")).toBe(false);
    expect(registered.shortcuts.has("ctrl+alt+i")).toBe(false);
    expect(registered.tools).not.toContain("subagent_status");
  });

  test("registers startup trust onboarding only for the parent profile", () => {
    const parentConfig = config("pi-composition-trust-parent", {
      subagent: false,
      workflow: false,
      "bit-task": false,
    });
    let registrations = 0;
    setupHarness(createFakePi({ cwd: parentConfig.paths.home }), parentConfig, {
      setupTrustPrompt: () => {
        registrations += 1;
      },
    });

    setupHarness(
      createFakePi({ cwd: parentConfig.paths.home }),
      { ...parentConfig, isChild: true },
      {
        setupTrustPrompt: () => {
          registrations += 1;
        },
      },
    );

    expect(registrations).toBe(1);
  });

  test("keeps the mandatory permission policy when Codex launcher pinning fails", async () => {
    const value = {
      ...config("pi-composition-codex-pin-failure", {
        subagent: false,
        workflow: false,
        "bit-task": false,
      }),
      isChild: true,
    };
    value.paths = await temporaryHarnessPaths(
      "pi-composition-codex-pin-failure",
    );
    const pi = createFakePi({ cwd: value.paths.home, hasUI: false });
    harnessInstances.push(pi);
    let pinAttempts = 0;

    expect(() =>
      setupHarness(pi, value, {
        consumeCodexStageCapability: () => new Set(["review"] as const),
        createCodexStageExecutablePin: () => {
          pinAttempts += 1;
          throw new Error("simulated pin failure");
        },
      }),
    ).not.toThrow();
    expect(pinAttempts).toBe(1);
    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "bash_escalated",
        toolCallId: "codex-pin-failure",
        input: {
          command: "~/.claude/hooks/lib/codex-stage.sh review --uncommitted",
        },
      }),
    ).toEqual({ block: true, reason: expect.any(String) });
  });

  test("registers project-memory write only for the parent profile", () => {
    const parentConfig = config("pi-composition-memory-parent", {
      subagent: false,
      workflow: false,
      "bit-task": false,
    });
    parentConfig.features["agent-memory"] = true;
    const parent = registration(parentConfig);
    expect(parent.tools).toContain("memory_recall");
    expect(parent.tools).toContain("memory_update");
    expect(parent.commands.has("subagents")).toBe(true);
    expect(parent.commands.has("project-memory")).toBe(true);
    expect(parent.shortcuts.has("ctrl+alt+m")).toBe(true);

    const child = registration({ ...parentConfig, isChild: true });
    expect(child.tools).toContain("memory_recall");
    expect(child.tools).not.toContain("memory_update");
    expect(child.commands.has("subagents")).toBe(false);
    expect(child.commands.has("project-memory")).toBe(false);
  });

  test("PI_HARNESS_CHILD=1 keeps read-only memory but disables resident sources", () => {
    const childConfig = loadConfig(
      { PI_HARNESS_CHILD: "1" },
      resolvePaths("/tmp/pi-composition-child-profile"),
    );
    const registered = registration(childConfig);
    expect(childConfig.features.subagent).toBe(false);
    expect(childConfig.features.workflow).toBe(false);
    expect(childConfig.features["bit-task"]).toBe(false);
    expect(childConfig.features["agent-memory"]).toBe(true);
    expect(registered.commands.has("subagents")).toBe(false);
    expect(registered.commands.has("bit-issues")).toBe(false);
    expect(registered.tools).not.toContain("subagent_status");
    expect(registered.tools).toContain("memory_recall");
    expect(registered.tools).not.toContain("memory_update");
  });
});

interface RuntimeComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput?(data: string): void;
  dispose?(): void;
}

const commandResult = (stdout: string): BoundedCommandResult => ({
  exitCode: 0,
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
  stdoutTruncated: false,
});

const createIssueRuntime = () => {
  const handlers = new Map<
    string,
    ((event: unknown, ctx: typeof context) => unknown)[]
  >();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: typeof context) => Promise<void> }
  >();
  const shortcuts = new Map<
    string,
    { handler: (ctx: typeof context) => Promise<void> | void }
  >();
  const keybindings = {
    matches(data: string, key: string) {
      const map: Record<string, string> = {
        "tui.editor.cursorDown": "down",
        "tui.select.confirm": "enter",
        "tui.select.cancel": "escape",
        "tui.select.up": "up",
        "tui.select.down": "down",
      };
      return map[key] === data;
    },
  };
  const editor: RuntimeComponent & {
    keybindings: typeof keybindings;
    getText(): string;
    getCursor(): { line: number; col: number };
  } = {
    keybindings,
    render: () => ["editor"],
    invalidate() {},
    handleInput() {},
    getText: () => "",
    getCursor: () => ({ line: 0, col: 0 }),
  };
  const tui = {
    terminal: { rows: 24 },
    focusedComponent: editor as RuntimeComponent | null,
    setFocus(component: RuntimeComponent | null) {
      this.focusedComponent = component;
    },
    requestRender() {},
  };
  let component: RuntimeComponent | undefined;
  let terminalInput:
    | ((data: string) => { consume?: boolean; data?: string } | undefined)
    | undefined;
  const notifications: string[] = [];
  const context = {
    cwd: "/repo",
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getBranch: () => [] },
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: (message: string) => notifications.push(message),
      setWidget(
        _key: string,
        factory:
          | ((runtimeTui: typeof tui, theme: unknown) => RuntimeComponent)
          | undefined,
      ) {
        component?.dispose?.();
        component = factory?.(tui, {});
        if (component === undefined && tui.focusedComponent !== editor) {
          tui.setFocus(editor);
        }
      },
      onTerminalInput(
        handler: (
          data: string,
        ) => { consume?: boolean; data?: string } | undefined,
      ) {
        terminalInput = handler;
        return () => {
          if (terminalInput === handler) terminalInput = undefined;
        };
      },
    },
  };
  const pi = {
    on(
      event: string,
      handler: (event: unknown, eventContext: typeof context) => unknown,
    ) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(
      name: string,
      options: {
        handler: (args: string, ctx: typeof context) => Promise<void>;
      },
    ) {
      commands.set(name, options);
    },
    registerShortcut(
      name: string,
      options: { handler: (ctx: typeof context) => Promise<void> | void },
    ) {
      shortcuts.set(name, options);
    },
  } as unknown as PiLike;
  return {
    pi,
    context,
    commands,
    shortcuts,
    tui,
    notifications,
    getComponent: () => component,
    hasTerminalInput: () => terminalInput !== undefined,
    async emit(event: string) {
      for (const handler of handlers.get(event) ?? []) {
        await handler({ type: event }, context);
      }
    },
  };
};

describe("open bit issue browser lifecycle", () => {
  test("gates child background guidance independently from the bit browser", async () => {
    const bitOnly = createFakePi({ cwd: "/repo" });
    Object.assign(bitOnly, { sendMessage() {} });
    setupChildRuns(bitOnly, { bitIssues: true, childExecution: false });
    const bitOnlyInjection = await bitOnly.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "inspect issues",
      systemPrompt: "base",
    });
    expect(bitOnlyInjection?.systemPrompt).toBeUndefined();

    const withChildren = createFakePi({ cwd: "/repo" });
    Object.assign(withChildren, { sendMessage() {} });
    setupChildRuns(withChildren, { bitIssues: true, childExecution: true });
    const childInjection = await withChildren.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "run child",
      systemPrompt: "base",
    });
    expect(childInjection?.systemPrompt).toContain(
      "Background agent completion",
    );
  });

  test("keeps automatic missing-bit failure silent and deduplicates explicit warnings", async () => {
    const runtime = createIssueRuntime();
    const runCommand: RunBoundedCommand = async (command) => {
      if (command === "git") return commandResult("/repo/.git\n");
      throw new BoundedCommandError("missing", "bit", "bit is unavailable");
    };
    const cli = new BitIssueCli({
      runCommand,
      realpath: async (path) => path,
    });
    setupChildRuns(runtime.pi, { bitIssues: true, bitIssueCli: cli });

    await runtime.emit("session_start");
    await Bun.sleep(0);
    expect(runtime.notifications).toEqual([]);
    const command = runtime.commands.get("bit-issues");
    if (command === undefined) throw new Error("bit-issues command missing");
    await command.handler("", runtime.context);
    await command.handler("", runtime.context);
    expect(runtime.notifications).toEqual([
      "Open bit issues unavailable: bit is unavailable",
    ]);
  });

  test("background-mounts, focuses explicitly, refreshes, honors q, and disposes", async () => {
    const runtime = createIssueRuntime();
    let listCalls = 0;
    const runCommand: RunBoundedCommand = async (command, args) => {
      if (command === "git") return commandResult("/repo/.git\n");
      if (args[1] === "list") {
        listCalls += 1;
        return commandResult(
          JSON.stringify([
            {
              id: "issue-a",
              title: "[task:test#1:1] issue a",
              state: "open",
              author: "Pi Tester",
              created_at: 10,
              updated_at: 20,
              body: "body",
              labels: ["session:test"],
            },
          ]),
        );
      }
      throw new Error(`unexpected bit argv: ${args.join(" ")}`);
    };
    const cli = new BitIssueCli({
      runCommand,
      realpath: async (path) => path,
    });
    setupChildRuns(runtime.pi, { bitIssues: true, bitIssueCli: cli });

    await runtime.emit("session_start");
    await Bun.sleep(0);
    const mounted = runtime.getComponent();
    expect(mounted).toBeDefined();
    expect(mounted?.render(80)[0]).toContain("#issue-a");
    expect(mounted?.render(80).join("\n")).not.toContain("Open bit issues");
    expect(runtime.tui.focusedComponent).not.toBe(mounted ?? null);

    const bitIssuesCommand = runtime.commands.get("bit-issues");
    if (bitIssuesCommand === undefined)
      throw new Error("bit-issues command missing");
    const callsBeforeCommand = listCalls;
    await bitIssuesCommand.handler("", runtime.context);
    await Bun.sleep(0);
    expect(listCalls).toBe(callsBeforeCommand + 1);
    const focused = runtime.getComponent();
    expect(focused).toBeDefined();
    expect(runtime.tui.focusedComponent).toBe(focused ?? null);
    expect(
      (
        runtime.getComponent() as RuntimeComponent & {
          getSelectedIssueId(): string | undefined;
        }
      ).getSelectedIssueId(),
    ).toBe("issue-a");

    const callsBeforeR = listCalls;
    runtime.getComponent()?.handleInput?.("r");
    await Bun.sleep(0);
    expect(listCalls).toBeGreaterThan(callsBeforeR);

    runtime.getComponent()?.handleInput?.("q");
    expect(runtime.getComponent()).toBeUndefined();
    await runtime.emit("agent_settled");
    await Bun.sleep(0);
    expect(runtime.getComponent()).toBeUndefined();

    const bitIssuesShortcut = runtime.shortcuts.get("ctrl+alt+i");
    if (bitIssuesShortcut === undefined)
      throw new Error("bit-issues shortcut missing");
    await bitIssuesShortcut.handler(runtime.context);
    expect(runtime.getComponent()).toBeDefined();
    await runtime.emit("session_shutdown");
    expect(runtime.getComponent()).toBeUndefined();
    expect(runtime.hasTerminalInput()).toBe(false);
  });
});

describe("project memory browser lifecycle", () => {
  test("keeps automatic failures silent and deduplicates explicit warnings", async () => {
    const runtime = createIssueRuntime();
    const source: AgentMemoryDataSource = {
      aggregate: async () => {
        throw new Error("memory is unavailable");
      },
      update: async () => {
        throw new Error("unused");
      },
    };
    const memory = new AgentMemoryRegistry({
      cli: source,
      trust: { trustedRoots: ["/repo"] },
    });
    setupChildRuns(runtime.pi, {
      agentMemory: memory,
      childExecution: false,
    });

    await runtime.emit("session_start");
    await Bun.sleep(0);
    expect(runtime.notifications).toEqual([]);
    const command = runtime.commands.get("project-memory");
    if (command === undefined)
      throw new Error("project-memory command missing");
    await command.handler("", runtime.context);
    await command.handler("", runtime.context);
    expect(runtime.notifications).toEqual([
      "Project memory unavailable: memory is unavailable",
    ]);
  });

  test("background-mounts, focuses, refreshes, and disposes memory-only state", async () => {
    const runtime = createIssueRuntime();
    let aggregateCalls = 0;
    const aggregate: MemoryAggregate = {
      repository: {
        cwd: "/repo",
        topLevel: "/repo",
        commonDir: "/repo/.git",
        objectFormat: "sha1",
        trustSource: "direct",
      },
      merged: {
        entries: new Map([
          [
            "project/architecture.md",
            {
              record: {
                version: 1,
                path: "project/architecture.md",
                description: "Architecture decision",
                updatedAt: "2026-08-03T08:00:00.000Z",
                deleted: false,
                content: "Use the shared registry.",
              },
              sourceRef: `refs/notes/pi-agent-memory/sessions/${"a".repeat(64)}/writers/${"b".repeat(64)}`,
              targetOid: "c".repeat(40),
            },
          ],
        ]),
        deleted: new Map(),
      },
      refs: [],
      diagnostics: [],
      truncated: false,
    };
    const source: AgentMemoryDataSource = {
      aggregate: async () => {
        aggregateCalls += 1;
        return aggregate;
      },
      update: async () => {
        throw new Error("unused");
      },
    };
    const memory = new AgentMemoryRegistry({
      cli: source,
      trust: { trustedRoots: ["/repo"] },
    });
    setupChildRuns(runtime.pi, {
      agentMemory: memory,
      childExecution: false,
    });

    await runtime.emit("session_start");
    await Bun.sleep(0);
    expect(runtime.getComponent()?.render(100)[0]).toContain(
      "project/architecture.md",
    );
    expect(runtime.getComponent()?.render(100).join("\n")).not.toContain(
      "Project memory",
    );

    const callsAfterSessionStart = aggregateCalls;
    await runtime.emit("agent_settled");
    await Bun.sleep(0);
    expect(aggregateCalls).toBe(callsAfterSessionStart);
    const subagents = runtime.commands.get("subagents");
    if (subagents === undefined) throw new Error("subagents command missing");
    await subagents.handler("", runtime.context);
    expect(aggregateCalls).toBe(callsAfterSessionStart);

    const command = runtime.commands.get("project-memory");
    if (command === undefined)
      throw new Error("project-memory command missing");
    const callsBeforeCommand = aggregateCalls;
    await command.handler("", runtime.context);
    expect(aggregateCalls).toBe(callsBeforeCommand + 1);
    expect(
      (
        runtime.getComponent() as RuntimeComponent & {
          getSelectedMemoryPath(): string | undefined;
        }
      ).getSelectedMemoryPath(),
    ).toBe("project/architecture.md");
    expect(runtime.tui.focusedComponent).toBe(runtime.getComponent() ?? null);

    const callsBeforeR = aggregateCalls;
    runtime.getComponent()?.handleInput?.("r");
    await Bun.sleep(0);
    expect(aggregateCalls).toBeGreaterThan(callsBeforeR);

    await runtime.emit("session_shutdown");
    expect(runtime.getComponent()).toBeUndefined();
    expect(runtime.hasTerminalInput()).toBe(false);
  });
});

describe("public SDK composition authority", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  test("accumulates before-agent messages and chains the exact system prompt", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "sdk-before-agent-"));
    directories.push(directory);
    const fakeSeen: string[] = [];
    const sdkSeen: string[] = [];
    const first = (pi: PiLike, seen: string[]) => {
      pi.on("before_agent_start", (event) => {
        seen.push(event.systemPrompt ?? "");
        return {
          message: {
            customType: "first",
            content: "first context",
            display: false,
          },
          systemPrompt: `${event.systemPrompt}:first`,
        };
      });
    };
    const second = (pi: PiLike, seen: string[]) => {
      pi.on("before_agent_start", (event) => {
        seen.push(event.systemPrompt ?? "");
        return {
          message: {
            customType: "second",
            content: "second context",
            display: false,
          },
          systemPrompt: `${event.systemPrompt}:second`,
        };
      });
    };
    const fake = createFakePi();
    first(fake, fakeSeen);
    second(fake, fakeSeen);
    const sdk = await createSdkExtensionRunner(
      [
        (api) => first(api, sdkSeen),
        (api) => second(api, sdkSeen),
        (api) => {
          api.on("before_agent_start", (event, ctx) => {
            expect(ctx.getSystemPrompt()).toBe("base:first:second");
            expect(event.systemPrompt).toBe(ctx.getSystemPrompt());
          });
        },
      ],
      directory,
    );
    const expected = [
      { customType: "first", content: "first context", display: false },
      { customType: "second", content: "second context", display: false },
    ];
    const actual = await sdk.runner.emitBeforeAgentStart("request", undefined, {
      cwd: directory,
      forceSystemPrompt: "base",
    });
    const aggregate = await fake.emitBeforeAgentStartAggregate({
      type: "before_agent_start",
      prompt: "request",
      systemPrompt: "base",
    });
    expect(actual.messages).toEqual(expected);
    expect(actual.messages).toEqual(aggregate.messages);
    expect(actual.systemPromptOptions.forceSystemPrompt).toBe(
      "base:first:second",
    );
    expect({ systemPrompt: aggregate.systemPrompt }).toEqual({
      systemPrompt: actual.systemPromptOptions.forceSystemPrompt,
    });
    expect(fakeSeen).toEqual(["base", "base:first"]);
    expect(sdkSeen).toEqual(fakeSeen);
    expect(sdk.sessionManager.getEntries()).toEqual([]);
    expect(sdk.errors).toEqual([]);

    const partial = await fake.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "request",
      systemPrompt: "base",
    });
    expect(partial).toEqual({
      message: expected[1],
      systemPrompt: "base:first:second",
    });
    const empty = createFakePi();
    expect(
      await empty.emitBeforeAgentStart({
        type: "before_agent_start",
        prompt: "request",
      }),
    ).toBeUndefined();
    expect(
      await empty.emitBeforeAgentStartAggregate({
        type: "before_agent_start",
        prompt: "request",
        systemPrompt: "base",
      }),
    ).toEqual({ messages: [], systemPrompt: "base" });
  });

  test("composes the supported tool-result fields without dropping an earlier patch", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "sdk-tool-result-"));
    directories.push(directory);
    const fakeSeen: unknown[] = [];
    const sdkSeen: unknown[] = [];
    const first = (pi: PiLike) => {
      pi.on("tool_result", () => ({
        content: [{ type: "text", text: "patched" }],
      }));
    };
    const second = (pi: PiLike, seen: unknown[]) => {
      pi.on("tool_result", (event) => {
        seen.push({ content: event.content, isError: event.isError });
        return { isError: true, content: undefined };
      });
    };
    const third = (pi: PiLike, seen: unknown[]) => {
      pi.on("tool_result", (event) => {
        seen.push({ content: event.content, isError: event.isError });
        return {};
      });
    };
    const fake = createFakePi();
    first(fake);
    second(fake, fakeSeen);
    third(fake, fakeSeen);
    const sdk = await createSdkExtensionRunner(
      [
        (api) => first(api),
        (api) => second(api, sdkSeen),
        (api) => third(api, sdkSeen),
      ],
      directory,
    );
    const event = {
      type: "tool_result",
      toolName: "read",
      toolCallId: "composition-result",
      input: { path: "fixture.txt" },
      content: [{ type: "text", text: "original" }],
      details: { retained: true },
      isError: false,
    } satisfies ToolResultEvent;
    const actual = await sdk.runner.emitToolResult(event);
    const patch = await fake.emitToolResult(event);
    expect(actual?.content).toEqual([{ type: "text", text: "patched" }]);
    expect(actual?.isError).toBe(true);
    expect(actual?.details).toEqual({ retained: true });
    expect(patch).toEqual({
      content: [{ type: "text", text: "patched" }],
      isError: true,
    });
    expect(fakeSeen).toEqual([
      { content: [{ type: "text", text: "patched" }], isError: false },
      { content: [{ type: "text", text: "patched" }], isError: true },
    ]);
    expect(sdkSeen).toEqual(fakeSeen);
    expect(event.content).toEqual([{ type: "text", text: "original" }]);
    expect(event.isError).toBe(false);
    const noop = createFakePi();
    noop.on("tool_result", () => ({}));
    const nativeNoop = await createSdkExtensionRunner(
      [
        (api) => {
          api.on("tool_result", () => ({}));
        },
      ],
      directory,
    );
    expect(await noop.emitToolResult(event)).toBeUndefined();
    expect(await nativeNoop.runner.emitToolResult(event)).toBeUndefined();
    expect(sdk.errors).toEqual([]);
    expect(nativeNoop.errors).toEqual([]);
  });
});
