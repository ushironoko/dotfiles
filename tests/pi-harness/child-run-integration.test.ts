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

interface OverlayHandleFake {
  hidden: boolean;
  focused: boolean;
  hide(): void;
  setHidden(value: boolean): void;
  isHidden(): boolean;
  focus(): void;
  unfocus(): void;
  isFocused(): boolean;
}

const createOverlayHandle = (): OverlayHandleFake => ({
  hidden: false,
  focused: false,
  hide() {
    this.hidden = true;
  },
  setHidden(value) {
    this.hidden = value;
  },
  isHidden() {
    return this.hidden;
  },
  focus() {
    this.focused = true;
  },
  unfocus() {
    this.focused = false;
  },
  isFocused() {
    return this.focused;
  },
});

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
  const overlayHandle = createOverlayHandle();
  let customCalls = 0;
  let component:
    | { render(width: number): string[]; handleInput?(data: string): void }
    | undefined;
  let overlayOptions: Record<string, unknown> | undefined;
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
      custom(factory: Function, options: Record<string, unknown>) {
        customCalls += 1;
        component = Reflect.apply(factory, undefined, [
          { terminal: { rows: 40 }, requestRender: () => {} },
          {},
          {
            matches: (data: string, key: string) =>
              (key === "tui.select.confirm" && data === "\r") ||
              (key === "tui.select.cancel" && data === "\u001b") ||
              (key === "tui.select.up" && data === "up") ||
              (key === "tui.select.down" && data === "down"),
          },
          () => {},
        ]);
        const rawOverlayOptions = options.overlayOptions;
        overlayOptions =
          typeof rawOverlayOptions === "function"
            ? Reflect.apply(rawOverlayOptions, undefined, [])
            : (rawOverlayOptions as Record<string, unknown>);
        Reflect.apply(options.onHandle as Function, undefined, [overlayHandle]);
        return new Promise<void>(() => {});
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
    overlayHandle,
    getCustomCalls: () => customCalls,
    getComponent: () => component,
    getOverlayOptions: () => overlayOptions,
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
  test("mounts one non-capturing overlay, streams summaries, and persists a safe transcript", async () => {
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

    expect(runtime.getCustomCalls()).toBe(1);
    expect(runtime.getOverlayOptions()?.nonCapturing).toBe(true);
    expect(runtime.overlayHandle.focused).toBe(false);
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

  test("/subagents focuses the resident overlay and Escape only unfocuses", async () => {
    const home = await setupTestDirectory("pi-child-command");
    tempDirectories.push(home);
    const runtime = createRuntime(home);
    setupChildRuns(runtime.pi);

    await runtime.commands.get("subagents")!.handler("", runtime.ctx);
    const visible = runtime.getOverlayOptions()?.visible as
      | ((width: number, height: number) => boolean)
      | undefined;
    expect(visible?.(80, 30)).toBe(true);
    expect(runtime.overlayHandle.focused).toBe(true);
    runtime.getComponent()?.handleInput?.("\u001b");
    expect(runtime.overlayHandle.focused).toBe(false);
    expect(runtime.overlayHandle.hidden).toBe(false);
    runtime.getComponent()?.handleInput?.("q");
    expect(runtime.overlayHandle.hidden).toBe(true);
    expect(visible?.(80, 30)).toBe(false);
  });
});
