import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxAskCallback } from "@anthropic-ai/sandbox-runtime";
import {
  BASH_SANDBOX_PROVIDER_EVENT,
  setupBashSandbox,
  type BashSandboxOperationsProvider,
  type SandboxManagerLike,
} from "../../pi/extensions/pi-harness/features/bash-sandbox";
import {
  buildBashSandboxProfile,
  type BashSandboxProfile,
} from "../../pi/extensions/pi-harness/features/bash-sandbox/profile";
import {
  buildControlledBashEnv,
  CONTROLLED_BASH_PATH,
  createControlledBashOperations,
  type SpawnFunction,
} from "../../pi/extensions/pi-harness/features/bash-sandbox/runtime";
import {
  DEFAULT_BASH_SANDBOX_CONFIG,
  type HarnessConfig,
} from "../../pi/extensions/pi-harness/config";
import type { PermissionAuditIntegration } from "../../pi/extensions/pi-harness/features/permission-audit";
import type { PermissionAuditStage } from "../../pi/extensions/pi-harness/features/permission-audit/model";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { createFakePi } from "./fake-pi";

const config = (): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": false,
    subagent: false,
    workflow: false,
    "bit-task": false,
    statusline: false,
    "provider-log": false,
    "asuku-notify": false,
    "ask-user-question": false,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths("/tmp/pi-bash-sandbox-test-home"),
  bashSandbox: structuredClone(DEFAULT_BASH_SANDBOX_CONFIG),
});

const profile = (cwd = "/repo"): BashSandboxProfile => ({
  cwd,
  writableRoots: [cwd, "/private/scratch"],
  scratchDirectory: "/private/scratch",
  networkMode: "denied",
  fingerprint: "a".repeat(64),
  runtimeConfig: {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      denyRead: ["/home/.ssh"],
      allowWrite: [cwd, "/private/scratch"],
      denyWrite: ["/home/.pi/agent/settings.json"],
    },
  },
});

interface FakeManager extends SandboxManagerLike {
  asks: SandboxAskCallback[];
  wrapped: string[];
  resets: number;
}

const manager = (): FakeManager => ({
  asks: [],
  wrapped: [],
  resets: 0,
  async initialize(_config, ask) {
    if (ask !== undefined) this.asks.push(ask);
  },
  async wrapWithSandbox(command) {
    this.wrapped.push(command);
    return `sandbox(${command})`;
  },
  async reset() {
    this.resets += 1;
  },
});

const setup = (
  options: {
    hasUI?: boolean;
    attach?: boolean;
    commandPrefix?: string;
    spawnFn?: SpawnFunction;
    userOwnerOrder?: "before" | "after";
  } = {},
) => {
  const pi = createFakePi({ cwd: "/repo", hasUI: options.hasUI });
  const fakeManager = manager();
  let provider: BashSandboxOperationsProvider | undefined;
  let providerEvents = 0;
  pi.events.on(BASH_SANDBOX_PROVIDER_EVENT, (value) => {
    providerEvents += 1;
    provider = value as BashSandboxOperationsProvider;
    if (options.attach !== false) {
      provider.attach({ commandPrefix: options.commandPrefix });
    }
  });
  let userOwnerExecutions = 0;
  const ownerOperations: BashOperations = {
    exec(command, cwd, execution) {
      userOwnerExecutions += 1;
      if (provider === undefined) throw new Error("provider unavailable");
      return provider.userOperations.exec(command, cwd, execution);
    },
  };
  const registerUserOwner = (): void => {
    pi.on("user_bash", () =>
      provider === undefined ? undefined : { operations: ownerOperations },
    );
  };
  if (options.userOwnerOrder === "before") registerUserOwner();
  const removed: string[] = [];
  const auditStages: PermissionAuditStage[] = [];
  const permissionAudit: PermissionAuditIntegration = {
    lineageId: "test-lineage",
    addStage(_toolCallId, stage) {
      auditStages.push(stage);
    },
    updateContext() {},
    async finalizeBlock() {
      return true;
    },
    registerTail() {},
    childEnvironment() {
      return {};
    },
  };
  const controller = setupBashSandbox(pi, config(), {
    loadRuntime: async () => ({ SandboxManager: fakeManager }),
    buildProfile: async () => profile(),
    makeTempDirectory: async () => "/private/scratch",
    chmodPath: async () => {},
    accessPath: async () => {},
    removePath: async (path) => {
      removed.push(path);
    },
    ...(options.spawnFn === undefined ? {} : { spawnFn: options.spawnFn }),
  });
  controller.registerExecutionBoundary({
    blockToolCall: (reason) => ({ block: true, reason }),
    permissionAudit,
  });
  if (options.userOwnerOrder === "after") registerUserOwner();
  return {
    pi,
    fakeManager,
    removed,
    auditStages,
    controller,
    getProvider: () => provider,
    getProviderEvents: () => providerEvents,
    getUserOwnerExecutions: () => userOwnerExecutions,
  };
};

describe("Bash sandbox profile", () => {
  test("allows only the active worktree, verified Git metadata, scratch, and trusted additions", async () => {
    const sandboxConfig = structuredClone(DEFAULT_BASH_SANDBOX_CONFIG);
    sandboxConfig.filesystem.allowWrite.push("~/trusted-output");
    const result = await buildBashSandboxProfile(
      "/repo/active/subdir",
      "/private/scratch",
      sandboxConfig,
      undefined,
      {
        home: "/home/test",
        canonicalize: async () => "/repo/active/subdir",
        discoverProject: async () => ({
          kind: "git",
          name: "repo",
          cwd: "/repo/active/subdir",
          activeWorktree: "/repo/active",
          navigableRoots: ["/repo/active", "/repo/other-worktree"],
          worktrees: ["/repo/active", "/repo/other-worktree"],
          fingerprint: "project-fingerprint",
        }),
        discoverGitCommonDir: async () => "/repo/common.git",
      },
    );

    expect(result.writableRoots).toEqual([
      "/repo/active",
      "/repo/common.git",
      "/private/scratch",
      "/home/test/trusted-output",
    ]);
    expect(result.writableRoots).not.toContain("/repo/other-worktree");
    expect(result.runtimeConfig.filesystem.allowWrite).toEqual([
      ...result.writableRoots,
    ]);
    expect(result.runtimeConfig.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        "/repo/common.git/config",
        "/repo/common.git/hooks",
      ]),
    );
  });

  test("fails closed when project or Git common-dir discovery is unavailable", async () => {
    await expect(
      buildBashSandboxProfile(
        "/repo",
        "/scratch",
        structuredClone(DEFAULT_BASH_SANDBOX_CONFIG),
        undefined,
        {
          canonicalize: async (path) => path,
          discoverProject: async () => ({
            kind: "unavailable",
            reason: "test failure",
            fingerprint: "unavailable",
          }),
        },
      ),
    ).rejects.toThrow("project boundary unavailable");

    await expect(
      buildBashSandboxProfile(
        "/repo",
        "/scratch",
        structuredClone(DEFAULT_BASH_SANDBOX_CONFIG),
        undefined,
        {
          canonicalize: async (path) => path,
          discoverProject: async () => ({
            kind: "git",
            cwd: "/repo",
            activeWorktree: "/repo",
            navigableRoots: ["/repo"],
            worktrees: ["/repo"],
            fingerprint: "project-fingerprint",
          }),
          discoverGitCommonDir: async () => undefined,
        },
      ),
    ).rejects.toThrow("Git common directory unavailable");
  });
});

describe("Bash effect sandbox lifecycle", () => {
  test("publishes operations, wraps after attachment, and cleans up", async () => {
    const runtime = setup();
    expect(runtime.getProvider()).toBeDefined();
    expect(runtime.getProviderEvents()).toBe(1);
    await runtime.pi.emitSessionStart({
      type: "session_start",
      reason: "startup",
    });
    expect(runtime.getProviderEvents()).toBe(2);
    const call = {
      type: "tool_call" as const,
      toolName: "bash",
      toolCallId: "sandbox-call",
      input: { command: "printf ok" },
    };
    expect(await runtime.pi.emitToolCall(call)).toBeUndefined();
    expect(call.input.command).toBe("sandbox(printf ok)");
    expect(runtime.fakeManager.wrapped).toEqual(["printf ok"]);
    expect(runtime.controller.boundaryFor("bash")).toEqual({
      mode: "sandboxed",
      network: "denied",
      profileFingerprint: "a".repeat(64),
    });
    expect(runtime.pi.tools.map((tool) => tool.name)).toContain(
      "bash_escalated",
    );

    await runtime.pi.emitSessionShutdown();
    expect(runtime.fakeManager.resets).toBe(1);
    expect(runtime.removed).toEqual(["/private/scratch"]);
  });

  test("includes the trusted shell prefix inside the sandbox wrapper", async () => {
    const runtime = setup({ commandPrefix: "set -e" });
    await runtime.pi.emitSessionStart({
      type: "session_start",
      reason: "startup",
    });
    const call = {
      type: "tool_call" as const,
      toolName: "bash",
      toolCallId: "sandbox-prefix",
      input: { command: "printf ok" },
    };
    expect(await runtime.pi.emitToolCall(call)).toBeUndefined();
    expect(runtime.fakeManager.wrapped).toEqual(["set -e\nprintf ok"]);
    expect(call.input.command).toBe("sandbox(set -e\nprintf ok)");
  });

  test("blocks ordinary Bash when the owning backend did not attach", async () => {
    const runtime = setup({ attach: false });
    await runtime.pi.emitSessionStart({
      type: "session_start",
      reason: "startup",
    });
    expect(
      await runtime.pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "unattached",
        input: { command: "echo no" },
      }),
    ).toEqual({
      block: true,
      reason: expect.stringContaining("not attached"),
    });
  });

  test("fails closed on initialization and wrapper failures", async () => {
    const initialization = setup();
    initialization.fakeManager.initialize = async () => {
      throw new Error("initialization failed at /private/profile-secret");
    };
    await initialization.pi.emitSessionStart({
      type: "session_start",
      reason: "startup",
    });
    expect(
      await initialization.pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "initialization-failure",
        input: { command: "echo no" },
      }),
    ).toEqual({
      block: true,
      reason: expect.stringContaining("initialization failed"),
    });
    expect(JSON.stringify(initialization.auditStages)).not.toContain(
      "/private/profile-secret",
    );
    await initialization.pi.emitSessionShutdown();
    expect(initialization.removed).toEqual(["/private/scratch"]);

    const wrapping = setup();
    await wrapping.pi.emitSessionStart({
      type: "session_start",
      reason: "startup",
    });
    wrapping.fakeManager.wrapWithSandbox = async () => {
      throw new Error("wrapper failed for private.example");
    };
    expect(
      await wrapping.pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "wrapper-failure",
        input: { command: "echo no" },
      }),
    ).toEqual({
      block: true,
      reason: expect.stringContaining("wrapper failed"),
    });
    expect(JSON.stringify(wrapping.auditStages)).not.toContain(
      "private.example",
    );
  });

  test("routes user Bash operations through the same sandbox wrapper", async () => {
    let launchedCommand: string | undefined;
    const child = new EventEmitter() as EventEmitter & {
      pid?: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill(signal?: NodeJS.Signals): boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    const spawnFn: SpawnFunction = (_command, args) => {
      launchedCommand = args.at(3);
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    };
    const runtime = setup({ spawnFn });
    await runtime.pi.emitSessionStart({
      type: "session_start",
      reason: "startup",
    });

    const result = await runtime
      .getProvider()
      ?.userOperations.exec("printf user", "/repo", { onData: () => {} });
    expect(result).toEqual({ exitCode: 0 });
    expect(runtime.fakeManager.wrapped).toEqual(["printf user"]);
    expect(launchedCommand).toBe("sandbox(printf user)");
  });

  test("yields attached user Bash to its owner in either load order", async () => {
    for (const userOwnerOrder of ["before", "after"] as const) {
      const child = new EventEmitter() as EventEmitter & {
        pid?: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill(signal?: NodeJS.Signals): boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      const spawnFn: SpawnFunction = () => {
        queueMicrotask(() => {
          child.stdout.emit("end");
          child.stderr.emit("end");
          child.emit("exit", 0);
        });
        return child;
      };
      const runtime = setup({ spawnFn, userOwnerOrder });
      await runtime.pi.emitSessionStart({
        type: "session_start",
        reason: "startup",
      });

      const routed = await runtime.pi.emitUserBash({
        type: "user_bash",
        command: "printf user",
        excludeFromContext: false,
        cwd: "/repo",
      });
      expect(routed?.operations).toBeDefined();
      await routed?.operations?.exec("printf user", "/repo", {
        onData: () => {},
      });
      expect(runtime.getUserOwnerExecutions()).toBe(1);
      expect(runtime.fakeManager.wrapped).toEqual(["printf user"]);
    }
  });

  test("binds escalated execution to the active session cwd", async () => {
    let launchedCwd: string | undefined;
    const child = new EventEmitter() as EventEmitter & {
      pid?: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill(signal?: NodeJS.Signals): boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    const spawnFn: SpawnFunction = (_command, _args, options) => {
      launchedCwd = options.cwd;
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    };
    const runtime = setup({ spawnFn });
    await runtime.pi.emitSessionStart({
      type: "session_start",
      reason: "startup",
    });
    const escalated = runtime.pi.tools.find(
      (tool) => tool.name === "bash_escalated",
    );
    await escalated?.execute(
      "escalated-cwd",
      { command: "printf ok" } as never,
      undefined,
      undefined,
      runtime.pi.ctx,
    );
    expect(launchedCwd).toBe("/repo");
  });

  test("memoizes interactive host decisions and denies without UI", async () => {
    const interactive = setup();
    interactive.pi.queueConfirm(true);
    await interactive.pi.emitSessionStart({
      type: "session_start",
      reason: "startup",
    });
    const [ask] = interactive.fakeManager.asks;
    expect(ask).toBeDefined();
    expect(interactive.controller.boundaryFor("bash")?.network).toBe("denied");
    expect(await ask?.({ host: "api.example.com", port: 443 })).toBe(true);
    expect(interactive.controller.boundaryFor("bash")?.network).toBe(
      "allowlisted",
    );
    expect(await ask?.({ host: "api.example.com", port: 443 })).toBe(true);
    expect(interactive.pi.confirmDialogs).toHaveLength(1);

    const headless = setup({ hasUI: false });
    await headless.pi.emitSessionStart({
      type: "session_start",
      reason: "startup",
    });
    expect(
      await headless.fakeManager.asks[0]?.({
        host: "api.example.com",
        port: 443,
      }),
    ).toBe(false);
    expect(headless.pi.confirmDialogs).toHaveLength(0);
  });
});

describe("controlled Bash launcher", () => {
  test("removes injection and secret environment variables", () => {
    const env = buildControlledBashEnv(
      {
        HOME: "/home/test",
        PATH: "/usr/bin:/repo/bin:/bin",
        LANG: "C.UTF-8",
        BASH_ENV: "/tmp/startup.sh",
        DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
        GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
        GH_TOKEN: "secret",
        OPENAI_API_KEY: "secret",
        HTTPS_PROXY: "http://user:pass@example.test",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
      },
      "/repo",
      "/private/scratch",
    );
    expect(env).toMatchObject({
      HOME: "/home/test",
      LANG: "C.UTF-8",
      SHELL: CONTROLLED_BASH_PATH,
      TMPDIR: "/private/scratch",
    });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(
      buildControlledBashEnv(
        { HOME: "/home/test", PATH: "/repo/bin:relative" },
        "/repo",
        "/private/scratch",
      ).PATH,
    ).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    for (const key of [
      "BASH_ENV",
      "DYLD_INSERT_LIBRARIES",
      "GIT_CONFIG_GLOBAL",
      "GH_TOKEN",
      "OPENAI_API_KEY",
      "HTTPS_PROXY",
      "SSH_AUTH_SOCK",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
  });

  test("uses a fixed no-startup shell argv", async () => {
    let launch:
      | { command: string; args: string[]; env: Record<string, string> }
      | undefined;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      pid?: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill(signal?: NodeJS.Signals): boolean;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => true;
    const spawnFn: SpawnFunction = (command, args, options) => {
      launch = { command, args, env: options.env };
      queueMicrotask(() => {
        child.emit("exit", 0);
        stdout.emit("data", Buffer.from("tail-after-exit"));
        stdout.emit("end");
        stderr.emit("end");
      });
      return child;
    };
    const operations = createControlledBashOperations({
      getScratchDirectory: () => "/private/scratch",
      spawnFn,
      baseEnv: {
        HOME: "/home/test",
        PATH: "/usr/bin:/bin",
        BASH_ENV: "/tmp/should-not-run",
      },
    });
    let output = "";
    await operations.exec("echo ok", "/repo", {
      onData: (chunk) => {
        output += chunk.toString();
      },
    });
    expect(launch).toMatchObject({
      command: CONTROLLED_BASH_PATH,
      args: ["--noprofile", "--norc", "-c", "echo ok"],
    });
    expect(launch?.env).not.toHaveProperty("BASH_ENV");
    expect(output).toBe("tail-after-exit");
  });
});
