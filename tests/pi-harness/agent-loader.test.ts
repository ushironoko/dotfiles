import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupSubagent from "../../pi/extensions/pi-harness/features/subagent/index";
import { MAX_CHAIN_DEPTH } from "../../pi/extensions/pi-harness/features/subagent/limits";
import { loadAgents } from "../../pi/extensions/pi-harness/features/subagent/loader";
import {
  PER_TASK_OUTPUT_CAP,
  type SpawnFunction,
  type SpawnedProcess,
} from "../../pi/extensions/pi-harness/features/subagent/spawn";
import type {
  CtxLike,
  ToolDefLike,
} from "../../pi/extensions/pi-harness/lib/pi-like";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { cleanupTestDirectory, setupTestDirectory } from "../test-helpers";
import { createFakePi } from "./fake-pi";

const tempDirectories: string[] = [];

const makeTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await setupTestDirectory(prefix);
  tempDirectories.push(directory);
  return directory;
};

const makeConfig = (home: string): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": true,
    subagent: true,
    workflow: true,
    "bit-task": true,
    statusline: true,
    "provider-log": false,
    "asuku-notify": true,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths(home),
});

interface FakeProcessController {
  process: SpawnedProcess;
  readonly killSignals: NodeJS.Signals[];
  emitStdout(text: string): void;
  emitStderr(text: string): void;
  emitError(error: Error): void;
  close(code?: number | null, signal?: NodeJS.Signals | null): void;
}

interface FakeProcessOptions {
  autoCloseOnKill?: boolean;
  killResult?: boolean;
  onClose?: () => void;
}

const createFakeProcess = (
  options: FakeProcessOptions = {},
): FakeProcessController => {
  const stdoutListeners: ((chunk: string) => void)[] = [];
  const stderrListeners: ((chunk: string) => void)[] = [];
  const closeListeners: ((
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void)[] = [];
  const errorListeners: ((error: Error) => void)[] = [];
  const killSignals: NodeJS.Signals[] = [];
  let killed = false;
  let closed = false;

  const close = (
    code: number | null = 0,
    signal: NodeJS.Signals | null = null,
  ) => {
    if (closed) return;
    closed = true;
    options.onClose?.();
    for (const listener of closeListeners) listener(code, signal);
  };

  return {
    process: {
      stdout: {
        on(_event, listener) {
          stdoutListeners.push(listener);
          return this;
        },
      },
      stderr: {
        on(_event, listener) {
          stderrListeners.push(listener);
          return this;
        },
      },
      on(event, listener) {
        if (event === "close") {
          closeListeners.push((code, signal) => {
            Reflect.apply(listener, undefined, [code, signal]);
          });
        } else {
          errorListeners.push((error) => {
            Reflect.apply(listener, undefined, [error]);
          });
        }
        return this;
      },
      kill(signal = "SIGTERM") {
        killed = true;
        killSignals.push(signal);
        const result = options.killResult ?? true;
        if (result && (options.autoCloseOnKill ?? true)) {
          close(null, signal);
        }
        return result;
      },
      get killed() {
        return killed;
      },
    },
    emitStdout(text) {
      for (const listener of stdoutListeners) listener(text);
    },
    emitStderr(text) {
      for (const listener of stderrListeners) listener(text);
    },
    emitError(error) {
      for (const listener of errorListeners) listener(error);
    },
    killSignals,
    close,
  };
};

const assistantEvent = (
  text: string,
  metadata: { stopReason?: string; errorMessage?: string } = {},
): string =>
  `${JSON.stringify({
    type: "message_end",
    ...metadata,
    message: { role: "assistant", content: [{ type: "text", text }] },
  })}\n`;

const writeAgent = async (home: string, name = "worker"): Promise<void> => {
  const agentsDirectory = resolvePaths(home).claudeAgentsDir;
  await fs.mkdir(agentsDirectory, { recursive: true });
  await fs.writeFile(
    join(agentsDirectory, `${name}.md`),
    [
      "---",
      `name: ${name}`,
      "description: Runs a task",
      "---",
      "Do the task.",
    ].join("\n"),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTestAbortSignal = (value: unknown): value is AbortSignal =>
  isRecord(value) &&
  typeof value.aborted === "boolean" &&
  typeof value.addEventListener === "function" &&
  typeof value.removeEventListener === "function";

const createTestAbortController = (): {
  signal: AbortSignal;
  abort(): void;
} => {
  const controller: unknown = new AbortController();
  if (
    !isRecord(controller) ||
    typeof controller.abort !== "function" ||
    !isTestAbortSignal(controller.signal)
  ) {
    throw new Error("AbortController is unavailable");
  }
  const { abort, signal } = controller;
  return {
    signal,
    abort: () => Reflect.apply(abort, controller, []),
  };
};

const getSingleResultStrings = (
  value: unknown,
): { text: string; output: string } => {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    throw new Error("Expected a tool result with content");
  }
  const [firstContent] = value.content;
  if (!isRecord(firstContent) || typeof firstContent.text !== "string") {
    throw new Error("Expected text content");
  }
  if (!isRecord(value.details) || !Array.isArray(value.details.results)) {
    throw new Error("Expected result details");
  }
  const [firstResult] = value.details.results;
  if (!isRecord(firstResult) || typeof firstResult.output !== "string") {
    throw new Error("Expected a spawned result output");
  }
  return { text: firstContent.text, output: firstResult.output };
};

const executeTool = (
  tool: ToolDefLike,
  params: Record<string, unknown>,
  ctx: CtxLike,
  signal?: AbortSignal,
): Promise<unknown> =>
  Promise.resolve(
    Reflect.apply(tool.execute, undefined, [
      "subagent-test",
      params,
      signal,
      undefined,
      ctx,
    ]),
  );

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for condition");
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(cleanupTestDirectory));
});

describe("pi-harness subagent", () => {
  test("loads valid markdown agents and skips malformed files", async () => {
    const directory = await makeTempDirectory("pi-agent-loader");
    await fs.writeFile(
      join(directory, "reviewer.md"),
      [
        "---",
        "name: reviewer",
        "description: Reviews a change",
        "tools: read, grep",
        "model: openai-codex/gpt-5.4-mini",
        "---",
        "Review carefully.",
      ].join("\n"),
    );
    await fs.writeFile(join(directory, "broken.md"), "not frontmatter");
    await fs.writeFile(join(directory, "ignored.txt"), "ignored");

    expect(loadAgents(directory)).toEqual([
      {
        name: "reviewer",
        description: "Reviews a change",
        tools: ["read", "grep"],
        model: "openai-codex/gpt-5.4-mini",
        systemPrompt: "Review carefully.",
      },
    ]);
  });

  test("returns an empty agent list for a missing directory", async () => {
    const directory = await makeTempDirectory("pi-agent-missing");
    expect(loadAgents(join(directory, "missing"))).toEqual([]);
  });

  test("registers one subagent tool with a JSON Schema object", async () => {
    const home = await makeTempDirectory("pi-subagent-schema");
    const pi = createFakePi();

    setupSubagent(pi, makeConfig(home));

    expect(pi.tools).toHaveLength(1);
    expect(pi.tools[0]?.name).toBe("subagent");
    const parameters = pi.tools[0]?.parameters;
    if (!isRecord(parameters) || !isRecord(parameters.properties)) {
      throw new Error("Expected object schema properties");
    }
    expect(parameters.type).toBe("object");
    expect(Object.keys(parameters.properties)).toEqual(
      expect.arrayContaining(["agent", "task", "tasks", "chain"]),
    );
  });

  test("spawns pi with agent flags, child env, and prompt file", async () => {
    const home = await makeTempDirectory("pi-subagent-spawn");
    const agentsDirectory = resolvePaths(home).claudeAgentsDir;
    await fs.mkdir(agentsDirectory, { recursive: true });
    await fs.writeFile(
      join(agentsDirectory, "reviewer.md"),
      [
        "---",
        "name: reviewer",
        "description: Reviews a change",
        "tools: read, grep",
        "model: openai-codex/gpt-5.4-mini",
        "---",
        "Review carefully.",
      ].join("\n"),
    );

    let recordedArgs: string[] = [];
    let recordedChildEnv: string | undefined;
    let recordedPrompt = "";
    const spawnFn: SpawnFunction = (_command, args, options) => {
      recordedArgs = [...args];
      recordedChildEnv = options.env.PI_HARNESS_CHILD;
      const promptFlag = args.indexOf("--append-system-prompt");
      recordedPrompt = readFileSync(args[promptFlag + 1] ?? "", "utf8");
      const controller = createFakeProcess();
      queueMicrotask(() => {
        controller.emitStdout(assistantEvent("review complete"));
        controller.close();
      });
      return controller.process;
    };
    const pi = createFakePi({ cwd: home });
    setupSubagent(pi, makeConfig(home), { spawnFn });

    await executeTool(
      pi.tools[0],
      { agent: "reviewer", task: "Review this" },
      pi.ctx,
    );

    expect(recordedArgs).toContain("--no-session");
    expect(recordedArgs).toContain("-p");
    expect(recordedArgs).toContain("--append-system-prompt");
    expect(recordedArgs).toContain("openai-codex/gpt-5.4-mini");
    expect(recordedArgs).toContain("read,grep");
    expect(recordedChildEnv).toBe("1");
    expect(recordedPrompt).toBe("Review carefully.");
  });

  test("runs at most four parallel child processes", async () => {
    const home = await makeTempDirectory("pi-subagent-concurrency");
    const agentsDirectory = resolvePaths(home).claudeAgentsDir;
    await fs.mkdir(agentsDirectory, { recursive: true });
    await fs.writeFile(
      join(agentsDirectory, "worker.md"),
      [
        "---",
        "name: worker",
        "description: Runs a task",
        "---",
        "Do the task.",
      ].join("\n"),
    );

    const controllers: FakeProcessController[] = [];
    let active = 0;
    let highWaterMark = 0;
    const spawnFn: SpawnFunction = () => {
      const controller = createFakeProcess();
      const originalClose = controller.close;
      controller.close = (code) => {
        active -= 1;
        originalClose(code);
      };
      controllers.push(controller);
      active += 1;
      highWaterMark = Math.max(highWaterMark, active);
      return controller.process;
    };
    const pi = createFakePi({ cwd: home });
    setupSubagent(pi, makeConfig(home), { spawnFn });
    const execution = executeTool(
      pi.tools[0],
      {
        tasks: Array.from({ length: 6 }, (_, index) => ({
          agent: "worker",
          task: `Task ${index + 1}`,
        })),
      },
      pi.ctx,
    );

    await waitFor(() => controllers.length === 4);
    expect(controllers).toHaveLength(4);
    expect(highWaterMark).toBe(4);
    for (const controller of controllers.slice(0, 4)) {
      controller.emitStdout(assistantEvent("done"));
      controller.close();
    }
    await waitFor(() => controllers.length === 6);
    expect(controllers).toHaveLength(6);
    for (const controller of controllers.slice(4)) {
      controller.emitStdout(assistantEvent("done"));
      controller.close();
    }

    await execution;
    expect(highWaterMark).toBe(4);
  });

  test("shares the four-child limit across concurrent tool executions", async () => {
    const home = await makeTempDirectory("pi-subagent-parent-concurrency");
    await writeAgent(home);

    const controllers: FakeProcessController[] = [];
    let active = 0;
    let highWaterMark = 0;
    const spawnFn: SpawnFunction = () => {
      active += 1;
      highWaterMark = Math.max(highWaterMark, active);
      const controller = createFakeProcess({
        onClose: () => {
          active -= 1;
        },
      });
      controllers.push(controller);
      return controller.process;
    };
    const pi = createFakePi({ cwd: home });
    setupSubagent(pi, makeConfig(home), { spawnFn });
    const tasks = (prefix: string) =>
      Array.from({ length: 3 }, (_, index) => ({
        agent: "worker",
        task: `${prefix} ${index + 1}`,
      }));

    const first = executeTool(pi.tools[0], { tasks: tasks("first") }, pi.ctx);
    const second = executeTool(pi.tools[0], { tasks: tasks("second") }, pi.ctx);

    await waitFor(() => controllers.length === 4);
    expect(highWaterMark).toBe(4);
    for (const controller of controllers.slice(0, 4)) {
      controller.emitStdout(assistantEvent("done"));
      controller.close();
    }
    await waitFor(() => controllers.length === 6);
    for (const controller of controllers.slice(4)) {
      controller.emitStdout(assistantEvent("done"));
      controller.close();
    }

    await Promise.all([first, second]);
    expect(highWaterMark).toBe(4);
  });

  test("rejects chains deeper than eight before spawning and advertises the cap", async () => {
    const home = await makeTempDirectory("pi-subagent-chain-cap");
    await writeAgent(home);
    let spawnCount = 0;
    const spawnFn: SpawnFunction = () => {
      spawnCount += 1;
      return createFakeProcess().process;
    };
    const pi = createFakePi({ cwd: home });
    setupSubagent(pi, makeConfig(home), { spawnFn });

    const parameters = pi.tools[0]?.parameters;
    if (!isRecord(parameters) || !isRecord(parameters.properties)) {
      throw new Error("Expected object schema properties");
    }
    const { chain } = parameters.properties;
    if (!isRecord(chain)) throw new Error("Expected chain schema");
    // The advertised cap must equal the runtime cap this test exercises.
    expect(chain.maxItems).toBe(MAX_CHAIN_DEPTH);

    const execution = executeTool(
      pi.tools[0],
      {
        chain: Array.from({ length: 9 }, (_, index) => ({
          agent: "worker",
          task: `Step ${index + 1}`,
        })),
      },
      pi.ctx,
    );
    await expect(execution).rejects.toThrow(
      "Too many chain steps (9). Max is 8.",
    );
    expect(spawnCount).toBe(0);
  });

  test("caps oversized assistant output in content and result details", async () => {
    const home = await makeTempDirectory("pi-subagent-output-cap");
    await writeAgent(home);
    const oversizedOutput = "界".repeat(PER_TASK_OUTPUT_CAP);
    const spawnFn: SpawnFunction = () => {
      const controller = createFakeProcess();
      queueMicrotask(() => {
        controller.emitStdout(assistantEvent(oversizedOutput));
        controller.close();
      });
      return controller.process;
    };
    const pi = createFakePi({ cwd: home });
    setupSubagent(pi, makeConfig(home), { spawnFn });

    const value = await executeTool(
      pi.tools[0],
      { agent: "worker", task: "Produce a large response" },
      pi.ctx,
    );
    const result = getSingleResultStrings(value);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      PER_TASK_OUTPUT_CAP,
    );
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(
      PER_TASK_OUTPUT_CAP,
    );
    expect(result.text).toContain("[Output truncated.]");
    expect(result.output).toContain("[Output truncated.]");
  });

  test("treats message_end stopReason error as a failed tool call", async () => {
    const home = await makeTempDirectory("pi-subagent-stop-reason");
    await writeAgent(home);
    const spawnFn: SpawnFunction = () => {
      const controller = createFakeProcess();
      queueMicrotask(() => {
        controller.emitStdout(
          assistantEvent("partial output", {
            stopReason: "error",
            errorMessage: "provider failed",
          }),
        );
        controller.close(0);
      });
      return controller.process;
    };
    const pi = createFakePi({ cwd: home });
    setupSubagent(pi, makeConfig(home), { spawnFn });

    const execution = executeTool(
      pi.tools[0],
      { agent: "worker", task: "Fail at the provider" },
      pi.ctx,
    );
    await expect(execution).rejects.toThrow(
      /stopReason error; errorMessage provider failed/,
    );
  });

  test("substitutes {previous} verbatim in a chain even when the prior output has $ sequences", async () => {
    const home = await makeTempDirectory("pi-subagent-chain-dollar");
    await writeAgent(home);
    const taskArgs: string[] = [];
    const spawnFn: SpawnFunction = (_command, args) => {
      const taskArg = args[args.length - 1] ?? "";
      taskArgs.push(taskArg);
      const controller = createFakeProcess();
      queueMicrotask(() => {
        // A literal String.replace(pattern, output) would expand these.
        controller.emitStdout(
          assistantEvent(taskArg.includes("STEP1") ? "A$&B$$C$`D$'E" : "done"),
        );
        controller.close(0);
      });
      return controller.process;
    };
    const pi = createFakePi({ cwd: home });
    setupSubagent(pi, makeConfig(home), { spawnFn });

    await executeTool(
      pi.tools[0],
      {
        chain: [
          { agent: "worker", task: "STEP1" },
          { agent: "worker", task: "consume {previous}" },
        ],
      },
      pi.ctx,
    );

    const second = taskArgs.find((arg) => arg.includes("consume"));
    expect(second).toContain("A$&B$$C$`D$'E");
    expect(second).not.toContain("{previous}");
  });

  test("treats a signaled child exit as failure and reports the signal", async () => {
    const home = await makeTempDirectory("pi-subagent-signaled");
    await writeAgent(home);
    const spawnFn: SpawnFunction = () => {
      const controller = createFakeProcess();
      queueMicrotask(() => controller.close(null, "SIGKILL"));
      return controller.process;
    };
    const pi = createFakePi({ cwd: home });
    setupSubagent(pi, makeConfig(home), { spawnFn });

    const execution = executeTool(
      pi.tools[0],
      { agent: "worker", task: "Receive a signal" },
      pi.ctx,
    );
    await expect(execution).rejects.toThrow("terminated by signal SIGKILL");
  });

  test("escalates an aborted child from SIGTERM to SIGKILL", async () => {
    const home = await makeTempDirectory("pi-subagent-abort-escalation");
    await writeAgent(home);
    const controllers: FakeProcessController[] = [];
    const spawnFn: SpawnFunction = () => {
      const controller = createFakeProcess({ autoCloseOnKill: false });
      controllers.push(controller);
      return controller.process;
    };
    const pi = createFakePi({ cwd: home });
    setupSubagent(pi, makeConfig(home), { spawnFn, termGraceMs: 20 });
    const abortController = createTestAbortController();
    const execution = executeTool(
      pi.tools[0],
      { agent: "worker", task: "Ignore SIGTERM" },
      pi.ctx,
      abortController.signal,
    );

    await waitFor(() => controllers.length === 1);
    abortController.abort();
    await waitFor(
      () => controllers[0]?.killSignals.includes("SIGKILL") === true,
    );
    expect(controllers[0]?.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    controllers[0]?.close(null, "SIGKILL");
    await expect(execution).rejects.toThrow("Subagent was aborted");
  });

  test("parallel failure stops the queue and aborts in-flight siblings", async () => {
    const home = await makeTempDirectory("pi-subagent-fail-fast");
    await writeAgent(home);
    const controllers: FakeProcessController[] = [];
    let spawnCount = 0;
    const spawnFn: SpawnFunction = () => {
      spawnCount += 1;
      if (spawnCount === 2) throw new Error("launch exploded");
      const controller = createFakeProcess();
      controllers.push(controller);
      return controller.process;
    };
    const pi = createFakePi({ cwd: home });
    setupSubagent(pi, makeConfig(home), { spawnFn, termGraceMs: 20 });
    const execution = executeTool(
      pi.tools[0],
      {
        tasks: Array.from({ length: 8 }, (_, index) => ({
          agent: "worker",
          task: `Task ${index + 1}`,
        })),
      },
      pi.ctx,
    );

    await expect(execution).rejects.toThrow("launch exploded");
    const countAfterFailure = spawnCount;
    await Bun.sleep(5);
    expect(spawnCount).toBe(countAfterFailure);
    expect(spawnCount).toBeLessThanOrEqual(4);
    expect(
      controllers.some((controller) =>
        controller.killSignals.includes("SIGTERM"),
      ),
    ).toBe(true);
  });
});
