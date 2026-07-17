import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupChildRuns from "../../pi/extensions/pi-harness/features/child-runs/index";
import setupSubagent from "../../pi/extensions/pi-harness/features/subagent/index";
import type {
  SpawnFunction,
  SpawnedProcess,
} from "../../pi/extensions/pi-harness/features/subagent/spawn";
import type {
  CtxLike,
  PiLike,
  ToolDefLike,
} from "../../pi/extensions/pi-harness/lib/pi-like";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { cleanupTestDirectory, setupTestDirectory } from "../test-helpers";

const tempDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(cleanupTestDirectory));
});

const makeConfig = (home: string): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": false,
    subagent: true,
    workflow: false,
    "bit-task": false,
    statusline: false,
    "provider-log": false,
    "asuku-notify": false,
    "ask-user-question": false,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths(home),
});

interface RuntimeComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput?(data: string): void;
  dispose?(): void;
}

const createRuntime = (cwd: string) => {
  const tools: ToolDefLike[] = [];
  const handlers = new Map<
    string,
    ((event: unknown, ctx: RuntimeContext) => unknown)[]
  >();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: RuntimeContext) => Promise<void> }
  >();
  const shortcuts = new Map<
    string,
    { handler: (ctx: RuntimeContext) => Promise<void> | void }
  >();
  const keybindings = {
    matches: (data: string, key: string) =>
      (key === "tui.editor.cursorDown" &&
        (data === "down" || data === "\u001b[1;1:3B")) ||
      (key === "tui.select.confirm" && data === "\r") ||
      (key === "tui.select.cancel" && data === "\u001b") ||
      (key === "tui.select.up" && data === "up") ||
      (key === "tui.select.down" && data === "down"),
  };
  let editorLines = [""];
  let editorCursor = { line: 0, col: 0 };
  const editor: RuntimeComponent & {
    keybindings: typeof keybindings;
    getText(): string;
    getCursor(): { line: number; col: number };
    isShowingAutocomplete(): boolean;
  } = {
    keybindings,
    render: () => ["editor"],
    invalidate() {},
    getText: () => editorLines.join("\n"),
    getCursor: () => ({ ...editorCursor }),
    isShowingAutocomplete: () => false,
    handleInput(data) {
      if (!keybindings.matches(data, "tui.editor.cursorDown")) return;
      if (editorCursor.line < editorLines.length - 1) {
        editorCursor.line += 1;
        editorCursor.col = Math.min(
          editorCursor.col,
          editorLines[editorCursor.line]?.length ?? 0,
        );
        return;
      }
      editorCursor.col = editorLines[editorCursor.line]?.length ?? 0;
    },
  };
  const tui = {
    terminal: { rows: 40 },
    requestRender: () => {},
    focusedComponent: editor as RuntimeComponent | null,
    setFocus(next: RuntimeComponent | null) {
      this.focusedComponent = next;
    },
  };
  let widgetCalls = 0;
  let component: RuntimeComponent | undefined;
  let widgetPlacement: string | undefined;
  let customCalls = 0;
  let customComponent: RuntimeComponent | undefined;
  let customOptions:
    | {
        overlay?: boolean;
        overlayOptions?: Record<string, unknown>;
      }
    | undefined;
  let terminalInputHandler:
    | ((data: string) => { consume?: boolean; data?: string } | undefined)
    | undefined;
  let branch: unknown[] = [];

  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => branch },
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: () => {},
      setWidget(
        _key: string,
        content:
          | ((widgetTui: typeof tui, theme: unknown) => RuntimeComponent)
          | undefined,
        options?: { placement?: string },
      ) {
        widgetCalls += 1;
        if (content === undefined) {
          component?.dispose?.();
          component = undefined;
          return;
        }
        widgetPlacement = options?.placement;
        component = content(tui, {});
      },
      custom(
        factory: (
          customTui: typeof tui,
          theme: unknown,
          customKeybindings: typeof keybindings,
          done: (value: unknown) => void,
        ) => RuntimeComponent,
        options?: {
          overlay?: boolean;
          overlayOptions?: Record<string, unknown>;
        },
      ) {
        customCalls += 1;
        customOptions = options;
        const previousFocus = tui.focusedComponent;
        return new Promise<unknown>((resolve) => {
          let closed = false;
          const done = (value: unknown) => {
            if (closed) return;
            closed = true;
            customComponent?.dispose?.();
            customComponent = undefined;
            tui.setFocus(previousFocus);
            resolve(value);
          };
          customComponent = factory(tui, {}, keybindings, done);
          tui.setFocus(customComponent);
        });
      },
      onTerminalInput(
        handler: (
          data: string,
        ) => { consume?: boolean; data?: string } | undefined,
      ) {
        terminalInputHandler = handler;
        return () => {
          if (terminalInputHandler === handler)
            terminalInputHandler = undefined;
        };
      },
    },
  } as unknown as RuntimeContext;

  const pi = {
    on(
      event: string,
      handler: (event: unknown, eventCtx: RuntimeContext) => unknown,
    ) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: ToolDefLike) {
      tools.push(tool);
    },
    registerCommand(
      name: string,
      options: typeof commands extends Map<string, infer V> ? V : never,
    ) {
      commands.set(name, options);
    },
    registerShortcut(
      key: string,
      options: typeof shortcuts extends Map<string, infer V> ? V : never,
    ) {
      shortcuts.set(key, options);
    },
  } as unknown as PiLike;

  return {
    pi,
    ctx,
    tools,
    commands,
    shortcuts,
    editor,
    tui,
    getWidgetCalls: () => widgetCalls,
    getComponent: () => component,
    getWidgetPlacement: () => widgetPlacement,
    getCustomCalls: () => customCalls,
    getCustomComponent: () => customComponent,
    getCustomOptions: () => customOptions,
    setEditorState(lines: string[], line: number, col: number) {
      editorLines = [...lines];
      editorCursor = { line, col };
    },
    dispatchInput(data: string) {
      const result = terminalInputHandler?.(data);
      if (result?.consume) return;
      tui.focusedComponent?.handleInput?.(result?.data ?? data);
    },
    setBranch(entries: unknown[]) {
      branch = entries;
    },
    async emit(event: string, payload: unknown) {
      let patch: unknown;
      for (const handler of handlers.get(event) ?? []) {
        const next = await handler(payload, ctx);
        if (next !== undefined) patch = next;
      }
      return patch;
    },
  };
};

type RuntimeContext = CtxLike & {
  mode: string;
  sessionManager: { getBranch(): unknown[] };
};

const scriptedSpawn =
  (text: string, stopReason: string = "stop"): SpawnFunction =>
  (_command, _args, _options) => {
    const stdout: ((chunk: string | Uint8Array) => void)[] = [];
    const stderr: ((chunk: string | Uint8Array) => void)[] = [];
    const close: ((
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void)[] = [];
    const error: ((error: Error) => void)[] = [];
    const proc: SpawnedProcess = {
      stdout: {
        on(_event, listener) {
          stdout.push(listener);
          return this;
        },
      },
      stderr: {
        on(_event, listener) {
          stderr.push(listener);
          return this;
        },
      },
      on(event, listener) {
        if (event === "close") close.push(listener as never);
        else error.push(listener as never);
        return this;
      },
      kill: () => true,
      killed: false,
    };
    queueMicrotask(() => {
      const privateEvents = [
        {
          type: "tool_execution_start",
          toolCallId: "SECRET_RAW_TOOL_ID",
          toolName: "read",
          args: { path: "SECRET_ARGUMENT" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "SECRET_RAW_TOOL_ID",
          toolName: "read",
          result: { content: [{ type: "text", text: "SECRET_RESULT" }] },
          isError: false,
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            model: "test-model",
            stopReason,
            content: [
              { type: "thinking", thinking: "SECRET_THINKING" },
              { type: "text", text },
            ],
          },
        },
      ];
      const bytes = Buffer.from(
        `${privateEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
        "utf8",
      );
      // Deliberately split in the middle of a multibyte rune.
      const split = Math.max(1, bytes.indexOf(Buffer.from("界")) + 1);
      for (const listener of stdout) {
        listener(bytes.subarray(0, split));
        listener(bytes.subarray(split));
      }
      for (const listener of close) listener(0, null);
    });
    return proc;
  };

const writeAgent = async (home: string): Promise<void> => {
  const dir = resolvePaths(home).claudeAgentsDir;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, "worker.md"),
    ["---", "name: worker", "description: worker", "---", "Work safely."].join(
      "\n",
    ),
  );
};

describe("child-run subagent integration", () => {
  test("mounts one full-width below-editor panel, streams summaries, and persists a safe transcript", async () => {
    const home = await setupTestDirectory("pi-child-integration");
    tempDirectories.push(home);
    await writeAgent(home);
    const runtime = createRuntime(home);
    const childRuns = setupChildRuns(runtime.pi);
    setupSubagent(runtime.pi, makeConfig(home), {
      childRuns,
      spawnFn: scriptedSpawn("hello 界"),
    });
    const tool = runtime.tools.find((item) => item.name === "subagent")!;
    const updates: unknown[] = [];
    const result = await Reflect.apply(tool.execute, undefined, [
      "parent-call",
      { agent: "worker", task: "inspect" },
      undefined,
      (update: unknown) => updates.push(update),
      runtime.ctx,
    ]);

    expect(runtime.getWidgetCalls()).toBe(1);
    expect(runtime.getWidgetPlacement()).toBe("belowEditor");
    expect(runtime.getComponent()).toBeDefined();
    expect(runtime.tui.focusedComponent).toBe(runtime.editor);
    expect(JSON.stringify(updates)).toContain('"kind":"summary"');
    expect(
      JSON.stringify(
        updates.map((update) => (update as { details?: unknown }).details),
      ),
    ).not.toContain("hello 界");

    const patch = (await runtime.emit("tool_result", {
      type: "tool_result",
      toolName: "subagent",
      toolCallId: "parent-call",
      details: (result as { details: unknown }).details,
      isError: false,
    })) as { details: Record<string, unknown> };
    const serialized = JSON.stringify(patch.details.childRuns);
    expect(serialized).toContain("hello 界");
    expect(serialized).toContain('"name":"read"');
    for (const secret of [
      "SECRET_RAW_TOOL_ID",
      "SECRET_ARGUMENT",
      "SECRET_RESULT",
      "SECRET_THINKING",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(patch.details.mode).toBe("single");
    const renderer = (
      tool as ToolDefLike & {
        renderResult: (
          result: unknown,
          options: { expanded: boolean },
        ) => { render(width: number): string[] };
      }
    ).renderResult;
    const rendered = renderer(
      {
        content: [
          { type: "text", text: "worktree: /tmp/review-tree — left in place" },
        ],
        details: patch.details,
      },
      { expanded: true },
    ).render(36);
    expect(rendered.join("\n")).toContain("/subagents");
    expect(rendered.join("\n")).toContain("/tmp/review-tree");
    expect(rendered.every((line) => line.length <= 36)).toBe(true);
  });

  test("attaches failed child details without changing thrown semantics", async () => {
    const home = await setupTestDirectory("pi-child-failure");
    tempDirectories.push(home);
    await writeAgent(home);
    const runtime = createRuntime(home);
    const childRuns = setupChildRuns(runtime.pi);
    setupSubagent(runtime.pi, makeConfig(home), {
      childRuns,
      spawnFn: scriptedSpawn("provider failed", "error"),
    });
    const tool = runtime.tools.find((item) => item.name === "subagent")!;

    await expect(
      Reflect.apply(tool.execute, undefined, [
        "parent-call",
        { agent: "worker", task: "inspect" },
        undefined,
        undefined,
        runtime.ctx,
      ]),
    ).rejects.toThrow("stopReason error");

    const patch = (await runtime.emit("tool_result", {
      type: "tool_result",
      toolName: "subagent",
      toolCallId: "parent-call",
      details: {},
      isError: true,
    })) as { details: { childRuns: { runs: { status: string }[] } } };
    expect(patch.details.childRuns.runs[0]?.status).toBe("failed");
  });

  test("distinguishes a child-reported aborted stop from a generic failure", async () => {
    const home = await setupTestDirectory("pi-child-model-aborted");
    tempDirectories.push(home);
    await writeAgent(home);
    const runtime = createRuntime(home);
    const childRuns = setupChildRuns(runtime.pi);
    setupSubagent(runtime.pi, makeConfig(home), {
      childRuns,
      spawnFn: scriptedSpawn("child aborted", "aborted"),
    });
    const tool = runtime.tools.find((item) => item.name === "subagent")!;
    await expect(
      Reflect.apply(tool.execute, undefined, [
        "parent-call",
        { agent: "worker", task: "inspect" },
        undefined,
        undefined,
        runtime.ctx,
      ]),
    ).rejects.toThrow("stopReason aborted");
    expect(
      childRuns.registry
        .getSnapshots()[0]
        ?.runs.map((run) => [run.status, run.terminalReason]),
    ).toEqual([["aborted", "model-aborted"]]);
  });

  test("marks the unlaunched remainder of a failed chain as skipped", async () => {
    const home = await setupTestDirectory("pi-child-chain-failure");
    tempDirectories.push(home);
    await writeAgent(home);
    const runtime = createRuntime(home);
    const childRuns = setupChildRuns(runtime.pi);
    setupSubagent(runtime.pi, makeConfig(home), {
      childRuns,
      spawnFn: scriptedSpawn("first failed", "error"),
    });
    const tool = runtime.tools.find((item) => item.name === "subagent")!;

    await expect(
      Reflect.apply(tool.execute, undefined, [
        "parent-call",
        {
          chain: [
            { agent: "worker", task: "first" },
            { agent: "worker", task: "second {previous}" },
          ],
        },
        undefined,
        undefined,
        runtime.ctx,
      ]),
    ).rejects.toThrow("stopReason error");

    expect(
      childRuns.registry
        .getSnapshots()[0]
        ?.runs.map((run) => [run.status, run.terminalReason]),
    ).toEqual([
      ["failed", "model-error"],
      ["skipped", "dependency-failed"],
    ]);
  });

  test("replaces browser history from the active session branch", async () => {
    const home = await setupTestDirectory("pi-child-replay");
    tempDirectories.push(home);
    const runtime = createRuntime(home);
    const childRuns = setupChildRuns(runtime.pi);
    runtime.setBranch([
      {
        type: "message",
        message: {
          role: "toolResult",
          details: {
            childRuns: {
              schema: "pi-harness/child-runs",
              version: 1,
              kind: "transcript",
              invocationId: "persisted-invocation",
              source: "subagent",
              mode: "single",
              label: "persisted",
              createdAt: 1,
              runs: [
                {
                  runId: "persisted-run",
                  agent: "worker",
                  task: "old task",
                  taskIndex: 0,
                  status: "succeeded",
                  terminalReason: "completed",
                  transcript: [{ type: "assistant", text: "old answer" }],
                },
              ],
            },
          },
        },
      },
    ]);
    await runtime.emit("session_start", { type: "session_start" });
    expect(childRuns.registry.getSnapshots()[0]?.invocationId).toBe(
      "persisted-invocation",
    );

    runtime.setBranch([]);
    await runtime.emit("session_tree", { type: "session_tree" });
    expect(childRuns.registry.getSnapshots()).toEqual([]);
  });

  test("Enter opens a focused transcript overlay whose arrows do not move the run list", () => {
    const runtime = createRuntime("/tmp/pi-child-detail-overlay");
    const childRuns = setupChildRuns(runtime.pi);
    const started = childRuns.registry.beginInvocation({
      toolCallId: "overlay-parent",
      source: "workflow",
      label: "workflow",
      runs: [
        { agent: "one", task: "first", taskIndex: 0, stageIndex: 0 },
        { agent: "two", task: "second", taskIndex: 1, stageIndex: 0 },
      ],
    });
    const [, selectedRunId] = started.runIds;
    if (selectedRunId === undefined)
      throw new Error("second child run did not initialize");
    childRuns.registry.observe(selectedRunId, {
      type: "process_started",
      at: 1,
    });
    for (let index = 0; index < 30; index++) {
      childRuns.registry.observe(selectedRunId, {
        type: "assistant_final",
        text: `detail line ${index}`,
        at: index + 2,
      });
    }
    childRuns.ensureVisible(runtime.ctx);
    const panel = runtime.getComponent() as
      | (RuntimeComponent & { getSelectedRunId(): string | undefined })
      | undefined;
    if (panel === undefined) throw new Error("child-run panel did not mount");
    panel.render(80);
    runtime.tui.setFocus(panel);

    runtime.dispatchInput("down");
    expect(panel.getSelectedRunId()).toBe(selectedRunId);
    runtime.dispatchInput("\r");

    const detail = runtime.getCustomComponent();
    if (detail === undefined) throw new Error("detail overlay did not mount");
    expect(runtime.getCustomCalls()).toBe(1);
    expect(runtime.getCustomOptions()).toMatchObject({
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", margin: 1 },
    });
    expect(runtime.tui.focusedComponent).toBe(detail);
    expect(detail.render(80)[0]).toContain("LIVE");

    runtime.dispatchInput("up");
    expect(detail.render(80)[0]).toContain("PAUSED");
    expect(panel.getSelectedRunId()).toBe(selectedRunId);

    runtime.dispatchInput("down");
    expect(detail.render(80)[0]).toContain("LIVE");
    expect(panel.getSelectedRunId()).toBe(selectedRunId);
    for (const kittyDown of ["\u001b[1;1:1B", "\u001b[1;1:2B"]) {
      runtime.dispatchInput("up");
      runtime.dispatchInput(kittyDown);
      expect(detail.render(80)[0]).toContain("LIVE");
      expect(panel.getSelectedRunId()).toBe(selectedRunId);
    }

    runtime.dispatchInput("escape");
    expect(runtime.getCustomComponent()).toBeUndefined();
    expect(runtime.tui.focusedComponent).toBe(panel);
    expect(panel.getSelectedRunId()).toBe(selectedRunId);
  });

  test("Down transfers focus only after native editor navigation reaches its bottom boundary", () => {
    const home = "/tmp/pi-child-down-focus";
    const runtime = createRuntime(home);
    const childRuns = setupChildRuns(runtime.pi);
    childRuns.ensureVisible(runtime.ctx);
    const panel = runtime.getComponent();
    if (panel === undefined) throw new Error("child-run panel did not mount");

    runtime.setEditorState(["first", "second"], 0, 0);
    runtime.dispatchInput("down");
    expect(runtime.editor.getCursor()).toEqual({ line: 1, col: 0 });
    expect(runtime.tui.focusedComponent).toBe(runtime.editor);

    runtime.setEditorState(["first", "second"], 1, 6);
    runtime.dispatchInput("\u001b[1;1:3B");
    expect(runtime.tui.focusedComponent).toBe(runtime.editor);

    runtime.dispatchInput("down");
    expect(runtime.tui.focusedComponent).toBe(panel);

    panel.handleInput?.("\u001b");
    expect(runtime.tui.focusedComponent).toBe(runtime.editor);
  });

  test("custom editors without cursor capability retain native Down handling", () => {
    const runtime = createRuntime("/tmp/pi-child-custom-down");
    const childRuns = setupChildRuns(runtime.pi);
    const received: string[] = [];
    const customEditor: RuntimeComponent = {
      render: () => ["custom editor"],
      invalidate() {},
      handleInput(data) {
        received.push(data);
      },
    };
    runtime.tui.setFocus(customEditor);
    childRuns.ensureVisible(runtime.ctx);

    runtime.dispatchInput("down");
    expect(received).toEqual(["down"]);
    expect(runtime.tui.focusedComponent).toBe(customEditor);
  });

  test("cursor-aware editors honor a remapped Down binding", () => {
    const runtime = createRuntime("/tmp/pi-child-remapped-down");
    const childRuns = setupChildRuns(runtime.pi);
    const received: string[] = [];
    const remappedEditor: RuntimeComponent & {
      keybindings: { matches(data: string, key: string): boolean };
      getText(): string;
      getCursor(): { line: number; col: number };
    } = {
      keybindings: {
        matches: (data, key) =>
          (key === "tui.editor.cursorDown" && data === "\u000e") ||
          (key === "tui.select.cancel" && data === "\u001b"),
      },
      render: () => ["remapped editor"],
      invalidate() {},
      getText: () => "draft",
      getCursor: () => ({ line: 0, col: 5 }),
      handleInput(data) {
        received.push(data);
      },
    };
    runtime.tui.setFocus(remappedEditor);
    childRuns.ensureVisible(runtime.ctx);
    const panel = runtime.getComponent();
    if (panel === undefined) throw new Error("child-run panel did not mount");

    runtime.dispatchInput("\u001b[B");
    expect(received).toEqual(["\u001b[B"]);
    expect(runtime.tui.focusedComponent).toBe(remappedEditor);

    runtime.dispatchInput("\u000e");
    expect(received).toEqual(["\u001b[B", "\u000e"]);
    expect(runtime.tui.focusedComponent).toBe(panel);
    panel.handleInput?.("\u001b");
    expect(runtime.tui.focusedComponent).toBe(remappedEditor);
  });

  test("/subagents restores generic custom-editor focus on Escape and q", async () => {
    const home = await setupTestDirectory("pi-child-command");
    tempDirectories.push(home);
    const runtime = createRuntime(home);
    setupChildRuns(runtime.pi);
    const customEditor: RuntimeComponent = {
      render: () => ["custom editor"],
      invalidate() {},
      handleInput() {},
    };
    runtime.tui.setFocus(customEditor);

    await runtime.commands.get("subagents")!.handler("", runtime.ctx);
    const panel = runtime.getComponent();
    if (panel === undefined) throw new Error("child-run panel did not mount");
    expect(runtime.getWidgetPlacement()).toBe("belowEditor");
    expect(runtime.tui.focusedComponent).toBe(panel);
    panel.handleInput?.("\u001b");
    expect(runtime.tui.focusedComponent).toBe(customEditor);
    expect(runtime.getComponent()).toBeDefined();

    await runtime.commands.get("subagents")!.handler("", runtime.ctx);
    runtime.getComponent()?.handleInput?.("q");
    expect(runtime.tui.focusedComponent).toBe(customEditor);
    expect(runtime.getComponent()).toBeUndefined();
  });

  test("explicit focus refresh replaces a stale pre-mount focus target", async () => {
    const runtime = createRuntime("/tmp/pi-child-stale-focus");
    const childRuns = setupChildRuns(runtime.pi);
    const temporarySelector: RuntimeComponent = {
      render: () => ["selector"],
      invalidate() {},
      handleInput() {},
    };
    runtime.tui.setFocus(temporarySelector);
    childRuns.ensureVisible(runtime.ctx);

    runtime.tui.setFocus(runtime.editor);
    await runtime.commands.get("subagents")!.handler("", runtime.ctx);
    const panel = runtime.getComponent();
    if (panel === undefined) throw new Error("child-run panel did not mount");
    panel.handleInput?.("\u001b");
    expect(runtime.tui.focusedComponent).toBe(runtime.editor);
  });
});
