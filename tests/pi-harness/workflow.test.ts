import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupWorkflow from "../../pi/extensions/pi-harness/features/workflow/index";
import type {
  SpawnFunction,
  SpawnLaunchOptions,
  SpawnedProcess,
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

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(cleanupTestDirectory));
});

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

const writeAgents = async (home: string, names: string[]): Promise<void> => {
  const agentsDirectory = resolvePaths(home).claudeAgentsDir;
  await fs.mkdir(agentsDirectory, { recursive: true });
  await Promise.all(
    names.map((name) =>
      fs.writeFile(
        join(agentsDirectory, `${name}.md`),
        [
          "---",
          `name: ${name}`,
          `description: Test agent ${name}`,
          "---",
          "Do the task.",
        ].join("\n"),
      ),
    ),
  );
};

const assistantEvent = (
  text: string,
  metadata: { stopReason?: string } = {},
): string =>
  `${JSON.stringify({
    type: "message_end",
    stopReason: metadata.stopReason ?? "stop",
    message: { role: "assistant", content: [{ type: "text", text }] },
  })}\n`;

interface ScriptedResponse {
  text?: string;
  stderr?: string;
  code?: number;
}

interface RecordedSpawn {
  command: string;
  args: string[];
  options: SpawnLaunchOptions;
  taskArg: string;
}

const createScriptedProcess = (script: ScriptedResponse): SpawnedProcess => {
  const stdoutListeners: ((chunk: string) => void)[] = [];
  const stderrListeners: ((chunk: string) => void)[] = [];
  const closeListeners: ((
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void)[] = [];

  setTimeout(() => {
    if (script.text !== undefined) {
      for (const listener of stdoutListeners) {
        listener(assistantEvent(script.text));
      }
    }
    if (script.stderr !== undefined) {
      for (const listener of stderrListeners) listener(script.stderr);
    }
    for (const listener of closeListeners) listener(script.code ?? 0, null);
  }, 0);

  return {
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
        closeListeners.push(
          listener as (
            code: number | null,
            signal: NodeJS.Signals | null,
          ) => void,
        );
      }
      return this;
    },
    kill() {
      return true;
    },
    killed: false,
  };
};

const makeSpawnFn = (
  respond: (taskArg: string) => ScriptedResponse,
): { records: RecordedSpawn[]; spawnFn: SpawnFunction } => {
  const records: RecordedSpawn[] = [];
  const spawnFn: SpawnFunction = (command, args, options) => {
    const taskArg = args[args.length - 1] ?? "";
    records.push({ command, args, options, taskArg });
    return createScriptedProcess(respond(taskArg));
  };
  return { records, spawnFn };
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

const getResult = (
  value: unknown,
): { text: string; details: Record<string, unknown> } => {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    throw new Error("Expected a tool result with content");
  }
  const [firstContent] = value.content;
  if (!isRecord(firstContent) || typeof firstContent.text !== "string") {
    throw new Error("Expected text content");
  }
  if (!isRecord(value.details)) throw new Error("Expected details");
  return { text: firstContent.text, details: value.details };
};

const getStageTaskReports = (
  details: Record<string, unknown>,
  stageIndex: number,
): Record<string, unknown>[] => {
  const stages = details.stages;
  if (!Array.isArray(stages)) throw new Error("Expected details.stages");
  const stage = stages[stageIndex];
  if (!isRecord(stage) || !Array.isArray(stage.tasks)) {
    throw new Error("Expected stage tasks");
  }
  return stage.tasks.filter(isRecord);
};

const findWorkflowTool = (tools: ToolDefLike[]): ToolDefLike => {
  const tool = tools.find((candidate) => candidate.name === "workflow");
  if (tool === undefined) throw new Error("workflow tool not registered");
  return tool;
};

const executeTool = (
  tool: ToolDefLike,
  params: Record<string, unknown>,
  ctx: CtxLike,
  signal?: AbortSignal,
): Promise<unknown> =>
  Promise.resolve(
    Reflect.apply(tool.execute, undefined, [
      "workflow-test",
      params,
      signal,
      undefined,
      ctx,
    ]),
  );

describe("pi-harness workflow", () => {
  test("runs a fan-out stage of codex reviewers and reports per-task output", async () => {
    const home = await makeTempDirectory("pi-workflow-fanout");
    await writeAgents(home, ["codex-reviewer"]);
    const { records, spawnFn } = makeSpawnFn((taskArg) =>
      taskArg.includes("lens one")
        ? { text: "finding-one" }
        : { text: "finding-two" },
    );
    const pi = createFakePi({ cwd: home });
    setupWorkflow(pi, makeConfig(home), { spawnFn });

    const result = await executeTool(
      findWorkflowTool(pi.tools),
      {
        stages: [
          {
            mode: "fanout",
            tasks: [
              { agentType: "codex-reviewer", task: "lens one" },
              { agentType: "codex-reviewer", task: "lens two" },
            ],
          },
        ],
      },
      pi.ctx,
    );

    const { text, details } = getResult(result);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.command).toBe("pi");
      expect(record.options.env.PI_HARNESS_CHILD).toBe("1");
      expect(record.options.cwd).toBe(home);
    }
    expect(text).toContain("2/2");
    expect(text).toContain("finding-one");
    expect(text).toContain("finding-two");
    expect(details.succeeded).toBe(2);
    expect(details.total).toBe(2);
  });

  test("oversized outputs share the report budget so every task stays represented", async () => {
    const home = await makeTempDirectory("pi-workflow-budget");
    await writeAgents(home, ["codex-reviewer"]);
    const { spawnFn } = makeSpawnFn((taskArg) =>
      taskArg.includes("lens one")
        ? { text: `ALPHA-${"a".repeat(60_000)}` }
        : { text: `BRAVO-${"b".repeat(60_000)}` },
    );
    const pi = createFakePi({ cwd: home });
    setupWorkflow(pi, makeConfig(home), { spawnFn });

    const result = await executeTool(
      findWorkflowTool(pi.tools),
      {
        stages: [
          {
            mode: "fanout",
            tasks: [
              { agentType: "codex-reviewer", task: "lens one" },
              { agentType: "codex-reviewer", task: "lens two" },
            ],
          },
        ],
      },
      pi.ctx,
    );

    const { text } = getResult(result);
    // A single prefix-preserving cap would let the first 50KB output erase
    // the second task entirely; both identities and output heads must stay.
    expect(text).toContain("ALPHA-");
    expect(text).toContain("BRAVO-");
    expect(text.match(/### \[codex-reviewer\]/g)).toHaveLength(2);
    expect(text).toContain("2/2");
  });

  test("continues on individual task failure and reports the degradation", async () => {
    const home = await makeTempDirectory("pi-workflow-degrade");
    await writeAgents(home, ["codex-reviewer"]);
    const { spawnFn } = makeSpawnFn((taskArg) =>
      taskArg.includes("rate-limited")
        ? { stderr: "codex rate limited", code: 15 }
        : { text: "survivor" },
    );
    const pi = createFakePi({ cwd: home });
    setupWorkflow(pi, makeConfig(home), { spawnFn });

    const result = await executeTool(
      findWorkflowTool(pi.tools),
      {
        stages: [
          {
            mode: "fanout",
            tasks: [
              { agentType: "codex-reviewer", task: "healthy lens" },
              { agentType: "codex-reviewer", task: "rate-limited lens" },
            ],
          },
        ],
      },
      pi.ctx,
    );

    const { text, details } = getResult(result);
    expect(text).toContain("1/2");
    expect(text).toContain("FAILED");
    expect(text).toContain("survivor");
    expect(details.succeeded).toBe(1);
    const reports = getStageTaskReports(details, 0);
    const failed = reports.find(
      (report) =>
        isRecord(report.result) &&
        (report.result as { failed?: boolean }).failed === true,
    );
    expect(failed).toBeDefined();
  });

  test("provisions an isolated worktree for codex-poc and leaves it in place", async () => {
    const home = await makeTempDirectory("pi-workflow-poc");
    await writeAgents(home, ["codex-poc"]);
    const created: { cwd: string; name: string }[] = [];
    const worktreePath = join(home, "worktrees", "poc-one");
    const { records, spawnFn } = makeSpawnFn(() => ({ text: "poc done" }));
    const pi = createFakePi({ cwd: home });
    setupWorkflow(pi, makeConfig(home), {
      spawnFn,
      createWorktree: async (cwd, name) => {
        created.push({ cwd, name });
        return worktreePath;
      },
    });

    const result = await executeTool(
      findWorkflowTool(pi.tools),
      {
        stages: [
          {
            mode: "fanout",
            tasks: [
              {
                agentType: "codex-poc",
                task: "build the poc",
                isolation: "worktree",
              },
            ],
          },
        ],
      },
      pi.ctx,
    );

    const { text, details } = getResult(result);
    expect(created).toHaveLength(1);
    expect(created[0]?.cwd).toBe(home);
    expect(created[0]?.name).not.toBe("");
    expect(records).toHaveLength(1);
    expect(records[0]?.options.cwd).toBe(worktreePath);
    expect(text).toContain(worktreePath);
    expect(text).toContain("left in place");
    const [report] = getStageTaskReports(details, 0);
    expect(report?.worktree).toBe(worktreePath);
  });

  test("rejects an invalid plan before any execution", async () => {
    const home = await makeTempDirectory("pi-workflow-invalid");
    await writeAgents(home, ["codex-poc"]);
    const created: string[] = [];
    const { records, spawnFn } = makeSpawnFn(() => ({ text: "never" }));
    const pi = createFakePi({ cwd: home });
    setupWorkflow(pi, makeConfig(home), {
      spawnFn,
      createWorktree: async (_cwd, name) => {
        created.push(name);
        return join(home, name);
      },
    });

    await expect(
      executeTool(
        findWorkflowTool(pi.tools),
        {
          stages: [
            {
              mode: "fanout",
              tasks: [{ agentType: "codex-poc", task: "poc without worktree" }],
            },
          ],
        },
        pi.ctx,
      ),
    ).rejects.toThrow(/codex-poc/);
    expect(records).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  test("rejects unknown agent types before any execution", async () => {
    const home = await makeTempDirectory("pi-workflow-unknown");
    await writeAgents(home, ["codex-reviewer"]);
    const { records, spawnFn } = makeSpawnFn(() => ({ text: "never" }));
    const pi = createFakePi({ cwd: home });
    setupWorkflow(pi, makeConfig(home), { spawnFn });

    await expect(
      executeTool(
        findWorkflowTool(pi.tools),
        {
          stages: [
            {
              mode: "fanout",
              tasks: [
                { agentType: "codex-reviewer", task: "baseline" },
                { agentType: "mystery-agent", task: "extra" },
              ],
            },
          ],
        },
        pi.ctx,
      ),
    ).rejects.toThrow(/mystery-agent/);
    expect(records).toHaveLength(0);
  });

  test("fills the default codex reviewer agentType for fan-out tasks", async () => {
    const home = await makeTempDirectory("pi-workflow-default");
    await writeAgents(home, ["codex-reviewer"]);
    const { records, spawnFn } = makeSpawnFn(() => ({ text: "defaulted" }));
    const pi = createFakePi({ cwd: home });
    setupWorkflow(pi, makeConfig(home), { spawnFn });

    const result = await executeTool(
      findWorkflowTool(pi.tools),
      { stages: [{ mode: "fanout", tasks: [{ task: "just review" }] }] },
      pi.ctx,
    );

    const { details } = getResult(result);
    expect(records).toHaveLength(1);
    const [report] = getStageTaskReports(details, 0);
    expect(report?.agentType).toBe("codex-reviewer");
  });

  test("runs stages sequentially", async () => {
    const home = await makeTempDirectory("pi-workflow-stages");
    await writeAgents(home, ["codex-reviewer", "codex-runner"]);
    const { records, spawnFn } = makeSpawnFn(() => ({ text: "ok" }));
    const pi = createFakePi({ cwd: home });
    setupWorkflow(pi, makeConfig(home), { spawnFn });

    await executeTool(
      findWorkflowTool(pi.tools),
      {
        stages: [
          {
            mode: "fanout",
            tasks: [
              { agentType: "codex-reviewer", task: "first stage a" },
              { agentType: "codex-reviewer", task: "first stage b" },
            ],
          },
          {
            mode: "single",
            tasks: [{ agentType: "codex-runner", task: "second stage" }],
          },
        ],
      },
      pi.ctx,
    );

    expect(records).toHaveLength(3);
    const order = records.map((record) => record.taskArg);
    expect(order[2]).toContain("second stage");
    expect(order.slice(0, 2).join(" ")).toContain("first stage");
  });

  test("a pre-aborted signal rejects without spawning", async () => {
    const home = await makeTempDirectory("pi-workflow-abort");
    await writeAgents(home, ["codex-reviewer"]);
    const { records, spawnFn } = makeSpawnFn(() => ({ text: "never" }));
    const pi = createFakePi({ cwd: home });
    setupWorkflow(pi, makeConfig(home), { spawnFn });
    const controller = createTestAbortController();
    controller.abort();

    await expect(
      executeTool(
        findWorkflowTool(pi.tools),
        {
          stages: [
            {
              mode: "fanout",
              tasks: [{ agentType: "codex-reviewer", task: "aborted" }],
            },
          ],
        },
        pi.ctx,
        controller.signal,
      ),
    ).rejects.toThrow(/abort/i);
    expect(records).toHaveLength(0);
  });
});
