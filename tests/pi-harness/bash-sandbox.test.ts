import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { SandboxAskCallback } from "@anthropic-ai/sandbox-runtime";
import {
  BASH_SANDBOX_PROVIDER_EVENT,
  setupBashSandbox,
  type BashSandboxOperationsProvider,
  type SandboxManagerLike,
} from "../../pi/extensions/pi-harness/features/bash-sandbox";
import type { BashSandboxProfile } from "../../pi/extensions/pi-harness/features/bash-sandbox/profile";
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

const setup = (options: { hasUI?: boolean; attach?: boolean } = {}) => {
  const pi = createFakePi({ cwd: "/repo", hasUI: options.hasUI });
  const fakeManager = manager();
  let provider: BashSandboxOperationsProvider | undefined;
  pi.events.on(BASH_SANDBOX_PROVIDER_EVENT, (value) => {
    provider = value as BashSandboxOperationsProvider;
    if (options.attach !== false) provider.attach();
  });
  const removed: string[] = [];
  const controller = setupBashSandbox(pi, config(), {
    loadRuntime: async () => ({ SandboxManager: fakeManager }),
    buildProfile: async () => profile(),
    makeTempDirectory: async () => "/private/scratch",
    chmodPath: async () => {},
    accessPath: async () => {},
    removePath: async (path) => {
      removed.push(path);
    },
  });
  controller.registerExecutionBoundary({
    blockToolCall: (reason) => ({ block: true, reason }),
  });
  return { pi, fakeManager, removed, controller, getProvider: () => provider };
};

describe("Bash effect sandbox lifecycle", () => {
  test("publishes operations, wraps after attachment, and cleans up", async () => {
    const runtime = setup();
    await runtime.pi.emitSessionStart({ type: "session_start", reason: "startup" });
    expect(runtime.getProvider()).toBeDefined();
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
    expect(runtime.pi.tools.map((tool) => tool.name)).toContain("bash_escalated");

    await runtime.pi.emitSessionShutdown();
    expect(runtime.fakeManager.resets).toBe(1);
    expect(runtime.removed).toEqual(["/private/scratch"]);
  });

  test("blocks ordinary Bash when the owning backend did not attach", async () => {
    const runtime = setup({ attach: false });
    await runtime.pi.emitSessionStart({ type: "session_start", reason: "startup" });
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

  test("memoizes interactive host decisions and denies without UI", async () => {
    const interactive = setup();
    interactive.pi.queueConfirm(true);
    await interactive.pi.emitSessionStart({
      type: "session_start",
      reason: "startup",
    });
    const ask = interactive.fakeManager.asks[0];
    expect(ask).toBeDefined();
    expect(await ask?.({ host: "api.example.com", port: 443 })).toBe(true);
    expect(await ask?.({ host: "api.example.com", port: 443 })).toBe(true);
    expect(interactive.pi.confirmDialogs).toHaveLength(1);

    const headless = setup({ hasUI: false });
    await headless.pi.emitSessionStart({ type: "session_start", reason: "startup" });
    expect(
      await headless.fakeManager.asks[0]?.({ host: "api.example.com", port: 443 }),
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
      queueMicrotask(() => child.emit("close", 0));
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
    await operations.exec("echo ok", "/repo", {
      onData: () => {},
    });
    expect(launch).toMatchObject({
      command: CONTROLLED_BASH_PATH,
      args: ["--noprofile", "--norc", "-c", "echo ok"],
    });
    expect(launch?.env).not.toHaveProperty("BASH_ENV");
  });
});
