import { describe, expect, test } from "bun:test";
import {
  loadConfig,
  type HarnessConfig,
} from "../../pi/extensions/pi-harness/config";
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
    statusline: false,
    "provider-log": false,
    "asuku-notify": false,
    "ask-user-question": false,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths(`/tmp/${name}`),
});

const registration = (value: HarnessConfig) => {
  const pi = createFakePi({ cwd: value.paths.home });
  const registerKnownEvent = pi.on.bind(pi);
  const childOnlyEvents = new Set([
    "agent_start",
    "message_end",
    "message_start",
    "session_tree",
  ]);
  Object.assign(pi, {
    on(
      event: Parameters<typeof pi.on>[0],
      handler: Parameters<typeof pi.on>[1],
    ) {
      if (childOnlyEvents.has(event)) return;
      registerKnownEvent(event, handler);
    },
  });
  setupHarness(pi, value);
  return {
    pi,
    commands: pi.commands,
    shortcuts: pi.shortcuts,
    tools: pi.tools.map((tool) => tool.name),
  };
};

describe("pi-harness coordination browser composition", () => {
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
      [...registered.commands].filter((name) => name === "subagents"),
    ).toHaveLength(1);
    expect(
      [...registered.commands].filter((name) => name === "bit-issues"),
    ).toHaveLength(1);
    expect(registered.tools).toEqual(
      expect.arrayContaining([
        "subagent",
        "workflow",
        "worktree_create",
        "worktree_remove",
        "task_completed",
      ]),
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
  });

  test("PI_HARNESS_CHILD=1 disables both resident sources", () => {
    const childConfig = loadConfig(
      { PI_HARNESS_CHILD: "1" },
      resolvePaths("/tmp/pi-composition-child-profile"),
    );
    const registered = registration(childConfig);
    expect(childConfig.features.subagent).toBe(false);
    expect(childConfig.features.workflow).toBe(false);
    expect(childConfig.features["bit-task"]).toBe(false);
    expect(registered.commands.has("subagents")).toBe(false);
    expect(registered.commands.has("bit-issues")).toBe(false);
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
    expect(mounted?.render(80)[0]).toContain("Open bit issues: 1");
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
