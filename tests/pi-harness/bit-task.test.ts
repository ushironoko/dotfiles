import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupBitTask, {
  createValidatedWorktree,
  type WorktreeCreator,
} from "../../pi/extensions/pi-harness/features/bit-task/index";
import {
  buildTaskMarker,
  matchesTaskMarker,
} from "../../pi/extensions/pi-harness/features/bit-task/lifecycle";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import type {
  CtxLike,
  ToolDefLike,
} from "../../pi/extensions/pi-harness/lib/pi-like";
import { cleanupTestDirectory, setupTestDirectory } from "../test-helpers";
import { createFakePi } from "./fake-pi";

const makeConfig = (): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": true,
    subagent: true,
    workflow: true,
    "bit-task": true,
    statusline: true,
    "provider-log": false,
    "asuku-notify": true,
    "ask-user-question": true,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths("/tmp/pi-bit-task-unit"),
});

const executeTool = (
  tool: ToolDefLike,
  params: Record<string, unknown>,
  ctx: CtxLike,
  signal?: AbortSignal,
): Promise<unknown> =>
  Promise.resolve(
    Reflect.apply(tool.execute, undefined, [
      "bit-task-test",
      params,
      signal,
      undefined,
      ctx,
    ]),
  );

const getTool = (tools: ToolDefLike[], name: string): ToolDefLike => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Tool not registered: ${name}`);
  return tool;
};

const readTextResult = (result: unknown): string => {
  if (result === null || typeof result !== "object") {
    throw new Error("Tool result was not an object");
  }
  const content = Reflect.get(result, "content");
  if (!Array.isArray(content)) throw new Error("Tool result had no content");
  const [first] = content;
  if (first === null || typeof first !== "object") {
    throw new Error("Tool result had no first content block");
  }
  const text = Reflect.get(first, "text");
  if (typeof text !== "string") throw new Error("Tool result was not text");
  return text;
};

describe("bit-task lifecycle", () => {
  test("builds a sequence-aware marker", () => {
    expect(buildTaskMarker("feature/harness", 3, "task-123")).toBe(
      "[task:feature/harness#3:task-123]",
    );
  });

  test("matches sequence-aware and legacy markers", () => {
    expect(
      matchesTaskMarker(
        "#42 [open] [task:feature/harness#99:task-123] Implement adapter",
        "feature/harness",
        "task-123",
      ),
    ).toBe(true);
    expect(
      matchesTaskMarker(
        "#7 [open] [task:feature/harness:task-123] Legacy adapter",
        "feature/harness",
        "task-123",
      ),
    ).toBe(true);
  });

  test("rejects markers for another branch or task id", () => {
    expect(
      matchesTaskMarker(
        "[task:other#3:task-123]",
        "feature/harness",
        "task-123",
      ),
    ).toBe(false);
    expect(
      matchesTaskMarker(
        "[task:feature/harness#3:task-999]",
        "feature/harness",
        "task-123",
      ),
    ).toBe(false);
  });

  test("treats regex metacharacters in branch names literally", () => {
    const branch = "feature/[pi].*+?";
    expect(
      matchesTaskMarker(
        `#4 [open] ${buildTaskMarker(branch, 8, "task.1")}`,
        branch,
        "task.1",
      ),
    ).toBe(true);
    expect(
      matchesTaskMarker(
        "#5 [open] [task:feature/xpiZZ#8:task.1]",
        branch,
        "task.1",
      ),
    ).toBe(false);
  });
});

describe("bit-task tool registration", () => {
  test("registers usable lifecycle tools that reject invalid parameters", async () => {
    const pi = createFakePi();
    setupBitTask(pi, makeConfig());

    await expect(
      executeTool(getTool(pi.tools, "worktree_create"), {}, pi.ctx),
    ).rejects.toThrow(/worktree_create.*name/i);
    await expect(
      executeTool(getTool(pi.tools, "task_completed"), {}, pi.ctx),
    ).rejects.toThrow(/task_completed.*task_id/i);
    await expect(
      executeTool(
        getTool(pi.tools, "worktree_remove"),
        { path: "/tmp/example", confirmed: false },
        pi.ctx,
      ),
    ).rejects.toThrow(/user.*approv|confirmed:true/i);
  });

  test("refuses non-boolean removal approvals before spawning", async () => {
    const invocations: string[] = [];
    const pi = createFakePi();
    setupBitTask(pi, makeConfig(), {
      runHook: async () => {
        invocations.push("runHook");
        return {
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
        };
      },
      runCommand: async () => {
        invocations.push("runCommand");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const remove = getTool(pi.tools, "worktree_remove");

    for (const confirmed of [false, "true", 1]) {
      await expect(
        executeTool(
          remove,
          { path: "/path/that/must/not/be-resolved", confirmed },
          pi.ctx,
        ),
      ).rejects.toThrow(/user.*approv|confirmed:true/i);
    }
    expect(invocations).toEqual([]);
  });

  test("refuses a relative removal path before spawning or canonicalizing", async () => {
    const invocations: string[] = [];
    const pi = createFakePi();
    setupBitTask(pi, makeConfig(), {
      runHook: async () => {
        invocations.push("runHook");
        return {
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
        };
      },
      runCommand: async () => {
        invocations.push("runCommand");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await expect(
      executeTool(
        getTool(pi.tools, "worktree_remove"),
        { path: "relative/worktree", confirmed: true },
        pi.ctx,
      ),
    ).rejects.toThrow(/absolute path/i);
    expect(invocations).toEqual([]);
  });

  test("forces the child env guard for hook and command invocations", async () => {
    const directory = await setupTestDirectory("pi-bit-task-env", ["created"]);
    try {
      const created = await fs.realpath(join(directory, "created"));
      const hookEnvs: (Record<string, string | undefined> | undefined)[] = [];
      const commandEnvs: (Record<string, string | undefined> | undefined)[] =
        [];
      const pi = createFakePi({ cwd: directory });
      setupBitTask(pi, makeConfig(), {
        env: { PI_HARNESS_CHILD: "0" },
        runHook: async (_script, _stdin, options) => {
          hookEnvs.push(options?.env);
          return {
            exitCode: 0,
            timedOut: false,
            stdout: `${created}\n`,
            stderr: "",
          };
        },
        runCommand: async (_command, args, options) => {
          commandEnvs.push(options.env);
          if (args.includes("--git-common-dir")) {
            const commonDir = await fs.realpath(directory);
            return { exitCode: 0, stdout: `${commonDir}\n`, stderr: "" };
          }
          return {
            exitCode: 0,
            stdout: `worktree ${created}\n`,
            stderr: "",
          };
        },
      });

      await expect(
        executeTool(
          getTool(pi.tools, "worktree_create"),
          { name: "guarded" },
          pi.ctx,
        ),
      ).resolves.toBeDefined();
      expect(hookEnvs).toHaveLength(1);
      // worktree list + two common-dir identity resolutions (postcondition).
      expect(commandEnvs).toHaveLength(3);
      expect(hookEnvs[0]?.PI_HARNESS_CHILD).toBe("1");
      for (const env of commandEnvs) {
        expect(env?.PI_HARNESS_CHILD).toBe("1");
      }
    } finally {
      await cleanupTestDirectory(directory);
    }
  });

  test("passes cancellation into worktree provisioning and stops before verification", async () => {
    const directory = await setupTestDirectory("pi-bit-task-abort", [
      "created",
    ]);
    try {
      const created = await fs.realpath(join(directory, "created"));
      const controller = new AbortController() as unknown as {
        signal: AbortSignal;
        abort(): void;
      };
      let commandCalls = 0;
      const pi = createFakePi({ cwd: directory });
      setupBitTask(pi, makeConfig(), {
        runHook: async (_script, _stdin, options) => {
          expect(options?.signal).toBe(controller.signal);
          controller.abort();
          return {
            exitCode: 0,
            timedOut: false,
            stdout: `${created}\n`,
            stderr: "",
          };
        },
        runCommand: async () => {
          commandCalls += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });

      await expect(
        executeTool(
          getTool(pi.tools, "worktree_create"),
          { name: "cancelled" },
          pi.ctx,
          controller.signal,
        ),
      ).rejects.toThrow("Worktree creation was aborted");
      expect(commandCalls).toBe(0);
    } finally {
      await cleanupTestDirectory(directory);
    }
  });

  test("reports a published path from an aborted create hook", async () => {
    const directory = await setupTestDirectory("pi-bit-task-provisional", [
      "created",
    ]);
    try {
      const created = await fs.realpath(join(directory, "created"));
      const controller = new AbortController() as unknown as {
        signal: AbortSignal;
        abort(): void;
      };
      const reported: string[] = [];
      const creator: WorktreeCreator = {
        createScript: "/tmp/create.sh",
        invokeHook: async () => {
          controller.abort();
          return {
            exitCode: null,
            timedOut: false,
            stdout: `${created}\n`,
            stderr: "Hook aborted.",
          };
        },
        invokeCommand: async () => {
          throw new Error("verification must not run after cancellation");
        },
        env: () => ({}),
      };

      await expect(
        createValidatedWorktree(
          creator,
          directory,
          "cancelled",
          controller.signal,
          (path) => reported.push(path),
        ),
      ).rejects.toThrow("Worktree creation was aborted");
      expect(reported).toEqual([created]);
    } finally {
      await cleanupTestDirectory(directory);
    }
  });

  test("reports a published path when worktree creation times out", async () => {
    const directory = await setupTestDirectory("pi-bit-task-timeout", [
      "created",
    ]);
    try {
      const created = await fs.realpath(join(directory, "created"));
      const reported: string[] = [];
      const creator: WorktreeCreator = {
        createScript: "/tmp/create.sh",
        invokeHook: async () => ({
          exitCode: null,
          timedOut: true,
          stdout: `${created}\n`,
          stderr: "Hook timed out.",
        }),
        invokeCommand: async () => {
          throw new Error("verification must not run after timeout");
        },
        env: () => ({}),
      };

      await expect(
        createValidatedWorktree(
          creator,
          directory,
          "timed-out",
          undefined,
          (path) => reported.push(path),
        ),
      ).rejects.toThrow("worktree_create timed out");
      expect(reported).toEqual([created]);
    } finally {
      await cleanupTestDirectory(directory);
    }
  });

  test("uses the fifth execute argument cwd and guards task commands", async () => {
    const callCwds: (string | undefined)[] = [];
    const callEnvs: (Record<string, string | undefined> | undefined)[] = [];
    const ctxCwd = "/tmp/pi-bit-task-context-cwd";
    const pi = createFakePi({ cwd: ctxCwd });
    setupBitTask(pi, makeConfig(), {
      env: { PI_HARNESS_CHILD: "0" },
      runCommand: async (command, args, options) => {
        callCwds.push(options.cwd);
        callEnvs.push(options.env);
        if (command === "bash") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "branch") {
          return { exitCode: 0, stdout: "feature/context\n", stderr: "" };
        }
        if (args[0] === "rev-parse") {
          return { exitCode: 0, stdout: "/tmp/common.git\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const result = await executeTool(
      getTool(pi.tools, "task_completed"),
      { task_id: "task-context" },
      pi.ctx,
    );
    expect(readTextResult(result)).toContain("completed and verified");
    expect(callCwds.length).toBeGreaterThan(0);
    expect(callCwds.every((cwd) => cwd === ctxCwd)).toBe(true);
    expect(callEnvs.every((env) => env?.PI_HARNESS_CHILD === "1")).toBe(true);
  });

  test("fails the remove postcondition when the directory still exists", async () => {
    const directory = await setupTestDirectory("pi-bit-task-remove-post", [
      "repo",
      "target",
      "common.git",
    ]);
    try {
      const repo = await fs.realpath(join(directory, "repo"));
      const target = await fs.realpath(join(directory, "target"));
      const common = await fs.realpath(join(directory, "common.git"));
      let listCalls = 0;
      const pi = createFakePi({ cwd: repo });
      setupBitTask(pi, makeConfig(), {
        cwd: repo,
        runHook: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
        }),
        runCommand: async (_command, args) => {
          if (args.includes("--git-common-dir")) {
            return { exitCode: 0, stdout: `${common}\n`, stderr: "" };
          }
          if (args.includes("--show-toplevel")) {
            // Session cwd is the main repo, distinct from the removal target.
            return { exitCode: 0, stdout: `${repo}\n`, stderr: "" };
          }
          listCalls += 1;
          return {
            exitCode: 0,
            stdout:
              listCalls === 1
                ? `worktree ${repo}\n\nworktree ${target}\n`
                : `worktree ${repo}\n`,
            stderr: "",
          };
        },
      });

      await expect(
        executeTool(
          getTool(pi.tools, "worktree_remove"),
          { path: target, confirmed: true },
          pi.ctx,
        ),
      ).rejects.toThrow(/postcondition failed; directory still exists/i);
    } finally {
      await cleanupTestDirectory(directory);
    }
  });

  test("refuses to remove the worktree containing the current session checkout", async () => {
    const directory = await setupTestDirectory("pi-bit-task-self-remove", [
      "repo",
      "linked",
      "common.git",
    ]);
    try {
      const repo = await fs.realpath(join(directory, "repo"));
      const linked = await fs.realpath(join(directory, "linked"));
      const common = await fs.realpath(join(directory, "common.git"));
      let removeCalled = false;
      // The session is running INSIDE the linked worktree it asks to remove.
      const pi = createFakePi({ cwd: linked });
      setupBitTask(pi, makeConfig(), {
        cwd: linked,
        runHook: async () => {
          removeCalled = true;
          return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
        },
        runCommand: async (_command, args) => {
          if (args.includes("--git-common-dir")) {
            return { exitCode: 0, stdout: `${common}\n`, stderr: "" };
          }
          if (args.includes("--show-toplevel")) {
            return { exitCode: 0, stdout: `${linked}\n`, stderr: "" };
          }
          return {
            exitCode: 0,
            stdout: `worktree ${repo}\n\nworktree ${linked}\n`,
            stderr: "",
          };
        },
      });

      await expect(
        executeTool(
          getTool(pi.tools, "worktree_remove"),
          { path: linked, confirmed: true },
          pi.ctx,
        ),
      ).rejects.toThrow(/worktree containing the current session checkout/i);
      // The removal hook must never fire, so the worktree stays registered.
      expect(removeCalled).toBe(false);
    } finally {
      await cleanupTestDirectory(directory);
    }
  });

  test("removes a different linked worktree while running inside another", async () => {
    const directory = await setupTestDirectory("pi-bit-task-other-remove", [
      "repo",
      "linkedA",
      "linkedB",
      "common.git",
    ]);
    try {
      const repo = await fs.realpath(join(directory, "repo"));
      const linkedA = await fs.realpath(join(directory, "linkedA"));
      const linkedB = await fs.realpath(join(directory, "linkedB"));
      const common = await fs.realpath(join(directory, "common.git"));
      let removedB = false;
      const pi = createFakePi({ cwd: linkedA });
      setupBitTask(pi, makeConfig(), {
        cwd: linkedA,
        runHook: async () => {
          await fs.rm(linkedB, { recursive: true, force: true });
          removedB = true;
          return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
        },
        runCommand: async (_command, args) => {
          if (args.includes("--git-common-dir")) {
            return { exitCode: 0, stdout: `${common}\n`, stderr: "" };
          }
          if (args.includes("--show-toplevel")) {
            // Session cwd is linkedA — distinct from the removal target linkedB.
            return { exitCode: 0, stdout: `${linkedA}\n`, stderr: "" };
          }
          return {
            exitCode: 0,
            stdout: removedB
              ? `worktree ${repo}\n\nworktree ${linkedA}\n`
              : `worktree ${repo}\n\nworktree ${linkedA}\n\nworktree ${linkedB}\n`,
            stderr: "",
          };
        },
      });

      const result = await executeTool(
        getTool(pi.tools, "worktree_remove"),
        { path: linkedB, confirmed: true },
        pi.ctx,
      );
      expect(readTextResult(result)).toContain("Removed worktree");
      expect(removedB).toBe(true);
    } finally {
      await cleanupTestDirectory(directory);
    }
  });

  test("skips task verification only when bit cannot be spawned", async () => {
    const pi = createFakePi({ cwd: "/tmp/pi-bit-task-skip" });
    setupBitTask(pi, makeConfig(), {
      runCommand: async (command, args) => {
        if (command === "bash") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "branch") {
          return { exitCode: 0, stdout: "feature/skip\n", stderr: "" };
        }
        if (args[0] === "rev-parse") {
          return { exitCode: 0, stdout: "/tmp/common.git\n", stderr: "" };
        }
        throw Object.assign(new Error("spawn bit ENOENT"), { code: "ENOENT" });
      },
    });

    const result = await executeTool(
      getTool(pi.tools, "task_completed"),
      { task_id: "task-skip" },
      pi.ctx,
    );
    expect(readTextResult(result)).toContain("verification skipped");
  });

  test("fails closed when bit verification exits with a non-127 code", async () => {
    const pi = createFakePi({ cwd: "/tmp/pi-bit-task-fail-closed" });
    setupBitTask(pi, makeConfig(), {
      runCommand: async (command, args) => {
        if (command === "bash") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "branch") {
          return { exitCode: 0, stdout: "feature/fail\n", stderr: "" };
        }
        if (args[0] === "rev-parse") {
          return { exitCode: 0, stdout: "/tmp/common.git\n", stderr: "" };
        }
        return { exitCode: 2, stdout: "", stderr: "bit database failed" };
      },
    });

    await expect(
      executeTool(
        getTool(pi.tools, "task_completed"),
        { task_id: "task-fail" },
        pi.ctx,
      ),
    ).rejects.toThrow(/verification failed.*code 2/i);
  });

  test("fails closed when the current branch cannot be resolved", async () => {
    const pi = createFakePi({ cwd: "/tmp/pi-bit-task-no-branch" });
    setupBitTask(pi, makeConfig(), {
      runCommand: async (command) =>
        command === "bash"
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "not a repository" },
    });

    await expect(
      executeTool(
        getTool(pi.tools, "task_completed"),
        { task_id: "task-no-branch" },
        pi.ctx,
      ),
    ).rejects.toThrow(/verification failed.*current branch unavailable/i);
  });

  test("fails closed when the Git common directory cannot be resolved", async () => {
    const pi = createFakePi({ cwd: "/tmp/pi-bit-task-no-common-dir" });
    setupBitTask(pi, makeConfig(), {
      runCommand: async (command, args) => {
        if (command === "bash") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return args[0] === "branch"
          ? { exitCode: 0, stdout: "feature/no-common\n", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "common dir failed" };
      },
    });

    await expect(
      executeTool(
        getTool(pi.tools, "task_completed"),
        { task_id: "task-no-common" },
        pi.ctx,
      ),
    ).rejects.toThrow(/verification failed.*common directory unavailable/i);
  });
});
