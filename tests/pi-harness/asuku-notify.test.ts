import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import settings from "../../pi/settings.json";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupAsukuNotify, {
  runPermissionRequest,
} from "../../pi/extensions/pi-harness/features/asuku-notify/index";
import type { DetachedSpawnFunction } from "../../pi/extensions/pi-harness/lib/detached";
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

const makeConfig = (home: string, enabled = true): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": true,
    subagent: true,
    workflow: true,
    "bit-task": true,
    statusline: true,
    "provider-log": false,
    "asuku-notify": enabled,
    "ask-user-question": true,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths(home),
});

const waitFor = async (condition: () => Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for condition");
};

/** Executable stub standing in for asuku-hook: captures argv + stdin. */
const writeStubBinary = async (
  directory: string,
  captureFile: string,
): Promise<string> => {
  const binary = join(directory, "asuku-hook");
  // Write argv + stdin to a temp file, then rename: pollers must never
  // observe a half-written capture.
  await fs.writeFile(
    binary,
    [
      "#!/bin/bash",
      `{ printf '%s\\n' "$1"; cat; } > "${captureFile}.tmp"`,
      `mv "${captureFile}.tmp" "${captureFile}"`,
    ].join("\n"),
    { mode: 0o755 },
  );
  return binary;
};

const writePermissionStub = async (
  directory: string,
  captureFile: string,
  behavior: "allow" | "deny" | "malformed",
): Promise<string> => {
  const binary = join(directory, "asuku-hook");
  const output =
    behavior === "malformed"
      ? "not-json"
      : JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior },
          },
        });
  await fs.writeFile(
    binary,
    [
      "#!/bin/bash",
      `{ printf '%s\\n' "$1"; cat; } > "${captureFile}"`,
      `printf '%s\\n' '${output}'`,
    ].join("\n"),
    { mode: 0o755 },
  );
  return binary;
};

describe("pi-harness asuku-notify", () => {
  test("agent_settled feeds a detached notification with the session payload", async () => {
    const home = await makeTempDirectory("pi-asuku-home");
    const captureFile = join(home, "captured.txt");
    const binary = await writeStubBinary(home, captureFile);
    const pi = createFakePi({ cwd: home });
    setupAsukuNotify(pi, makeConfig(home), { binaryPath: binary });

    await pi.emitAgentSettled();
    await waitFor(async () => {
      try {
        await fs.access(captureFile);
        return true;
      } catch {
        return false;
      }
    });

    const captured = await fs.readFile(captureFile, "utf8");
    const [argLine, ...payloadLines] = captured.split("\n");
    expect(argLine).toBe("notification");
    const payload = JSON.parse(payloadLines.join("\n"));
    expect(payload.hook_event_name).toBe("Notification");
    expect(payload.session_id).toBe("fake-session");
    expect(payload.cwd).toBe(home);
    expect(payload.title).toBe("pi");
    expect(typeof payload.message).toBe("string");
    expect(payload.message.length).toBeGreaterThan(0);
  });

  test("shows the native TUI while asuku can allow the request", async () => {
    const home = await makeTempDirectory("pi-asuku-permission-allow");
    const binary = join(home, "asuku-hook");
    await fs.writeFile(binary, "#!/bin/bash\n", { mode: 0o755 });
    const capturedPayloads: string[] = [];
    const pi = createFakePi({ cwd: home, sessionId: "pi-session-1" });
    pi.queueConfirmUntilAborted();
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: binary,
      requestPermission: async (_command, payload) => {
        capturedPayloads.push(JSON.stringify(payload));
        return true;
      },
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });
    const accepted = await pi.ctx.ui.confirm(
      "危険なコマンドを実行しますか？",
      "confirmation reason\n\nrm -rf build",
      { timeout: 1_000 },
    );

    expect(accepted).toBe(true);
    expect(pi.confirmDialogs).toHaveLength(1);
    const payload = JSON.parse(capturedPayloads[0] ?? "{}");
    expect(payload.session_id).toBe("pi-session-1");
    expect(payload.hook_event_name).toBe("PermissionRequest");
    expect(payload.tool_name).toBe("PiConfirm");
    expect(payload.tool_input.title).toContain("コマンド");
    expect(payload.tool_input.message).toContain("rm -rf build");
  });

  test("shows the native TUI while asuku can deny the request", async () => {
    const home = await makeTempDirectory("pi-asuku-permission-deny");
    const binary = join(home, "asuku-hook");
    await fs.writeFile(binary, "#!/bin/bash\n", { mode: 0o755 });
    const pi = createFakePi({ cwd: home });
    pi.queueConfirmUntilAborted();
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: binary,
      requestPermission: async () => false,
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });
    const accepted = await pi.ctx.ui.confirm("Permission", "run command", {
      timeout: 1_000,
    });

    expect(accepted).toBe(false);
    expect(pi.confirmDialogs).toHaveLength(1);
  });

  test("does not leave a stale native request when asuku decides in RPC mode", async () => {
    const home = await makeTempDirectory("pi-asuku-rpc");
    const binary = join(home, "asuku-hook");
    await fs.writeFile(binary, "#!/bin/bash\n", { mode: 0o755 });
    const pi = createFakePi({ cwd: home, mode: "rpc" });
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: binary,
      requestPermission: async () => true,
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });
    expect(await pi.ctx.ui.confirm("Permission", "run command")).toBe(true);
    expect(pi.confirmDialogs).toHaveLength(0);
  });

  test("serializes native TUI confirmations while preserving each result", async () => {
    const home = await makeTempDirectory("pi-asuku-native-queue");
    const binary = join(home, "asuku-hook");
    await fs.writeFile(binary, "#!/bin/bash\n", { mode: 0o755 });
    const pi = createFakePi({ cwd: home });
    const openedTitles: string[] = [];
    const nativeResolvers: ((accepted: boolean) => void)[] = [];
    pi.ctx.ui.confirm = async (title) => {
      openedTitles.push(title);
      return new Promise<boolean>((resolve) => nativeResolvers.push(resolve));
    };
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: binary,
      requestPermission: async () => undefined,
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });
    const first = pi.ctx.ui.confirm("First", "first command");
    const second = pi.ctx.ui.confirm("Second", "second command");
    await waitFor(async () => openedTitles.length === 1);
    expect(openedTitles).toEqual(["First"]);

    nativeResolvers[0]?.(true);
    expect(await first).toBe(true);
    await waitFor(async () => openedTitles.length === 2);
    expect(openedTitles).toEqual(["First", "Second"]);

    nativeResolvers[1]?.(false);
    expect(await second).toBe(false);
  });

  test("keeps the native confirmation open for malformed asuku output", async () => {
    const home = await makeTempDirectory("pi-asuku-permission-fallback");
    const captureFile = join(home, "permission.txt");
    const binary = await writePermissionStub(home, captureFile, "malformed");
    const pi = createFakePi({ cwd: home });
    let nativeOpened = false;
    let bridgeSettled = false;
    let resolveNative: ((accepted: boolean) => void) | undefined;
    pi.ctx.ui.confirm = async () => {
      nativeOpened = true;
      return new Promise<boolean>((resolve) => {
        resolveNative = resolve;
      });
    };
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: binary,
      requestPermission: async (command, payload, options) => {
        const decision = await runPermissionRequest(command, payload, options);
        bridgeSettled = true;
        return decision;
      },
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });
    const accepted = pi.ctx.ui.confirm("Permission", "run command", {
      timeout: 1_000,
    });
    await waitFor(async () => nativeOpened && bridgeSettled);
    resolveNative?.(true);

    expect(await accepted).toBe(true);
    expect(nativeOpened).toBe(true);
    expect(bridgeSettled).toBe(true);
  });

  test("gives asuku and the native TUI the same remaining timeout budget", async () => {
    const home = await makeTempDirectory("pi-asuku-timeout-budget");
    const binary = join(home, "asuku-hook");
    await fs.writeFile(binary, "#!/bin/bash\n", { mode: 0o755 });
    let clock = 1_000;
    const observedTimeouts: number[] = [];
    const pi = createFakePi({ cwd: home });
    pi.queueConfirm(true);
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: binary,
      now: () => clock,
      requestPermission: async (_command, _payload, options) => {
        observedTimeouts.push(options.timeoutMs);
        clock = 4_000;
        return undefined;
      },
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });
    const accepted = await pi.ctx.ui.confirm("Permission", "run command", {
      timeout: 5_000,
    });

    expect(accepted).toBe(true);
    expect(observedTimeouts).toEqual([5_000]);
    expect(pi.confirmDialogs[0]?.dialogOptions?.timeout).toBe(5_000);
  });

  test("aborts a pending asuku request when the native TUI decides first", async () => {
    const home = await makeTempDirectory("pi-asuku-native-first");
    const binary = join(home, "asuku-hook");
    await fs.writeFile(binary, "#!/bin/bash\n", { mode: 0o755 });
    let requestAborted = false;
    const pi = createFakePi({ cwd: home });
    pi.queueConfirm(true);
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: binary,
      requestPermission: async (_command, _payload, options) =>
        new Promise<boolean | undefined>((resolve) => {
          if (
            options.signal !== undefined &&
            "addEventListener" in options.signal &&
            typeof options.signal.addEventListener === "function"
          ) {
            options.signal.addEventListener(
              "abort",
              () => {
                requestAborted = true;
                resolve(undefined);
              },
              { once: true },
            );
          }
        }),
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });
    const accepted = await pi.ctx.ui.confirm("Permission", "run command", {
      timeout: 5_000,
    });

    expect(accepted).toBe(true);
    expect(pi.confirmDialogs).toHaveLength(1);
    expect(requestAborted).toBe(true);
  });

  test("replaces a prior reload wrapper and restores the native confirmation on shutdown", async () => {
    const home = await makeTempDirectory("pi-asuku-reload");
    const binary = join(home, "asuku-hook");
    await fs.writeFile(binary, "#!/bin/bash\n", { mode: 0o755 });
    let oldRequests = 0;
    let newRequests = 0;
    const pi = createFakePi({ cwd: home });
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: binary,
      requestPermission: async () => {
        oldRequests += 1;
        return false;
      },
    });
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: binary,
      requestPermission: async () => {
        newRequests += 1;
        return true;
      },
    });

    await pi.emitSessionStart({ type: "session_start", reason: "reload" });
    expect(await pi.ctx.ui.confirm("Permission", "run command")).toBe(true);
    expect(oldRequests).toBe(0);
    expect(newRequests).toBe(1);

    await pi.emitSessionShutdown();
    pi.queueConfirm(false);
    expect(await pi.ctx.ui.confirm("Native", "after shutdown")).toBe(false);
    expect(newRequests).toBe(1);
    expect(pi.confirmDialogs).toHaveLength(2);
  });

  test("a disabled reload removes the prior asuku confirmation wrapper", async () => {
    const home = await makeTempDirectory("pi-asuku-reload-disabled");
    const binary = join(home, "asuku-hook");
    await fs.writeFile(binary, "#!/bin/bash\n", { mode: 0o755 });
    let requests = 0;
    const pi = createFakePi({ cwd: home });
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: binary,
      requestPermission: async () => {
        requests += 1;
        return true;
      },
    });
    setupAsukuNotify(pi, makeConfig(home, false), { binaryPath: binary });

    await pi.emitSessionStart({ type: "session_start", reason: "reload" });
    pi.queueConfirm(false);
    expect(await pi.ctx.ui.confirm("Native", "feature disabled")).toBe(false);
    expect(requests).toBe(0);
    expect(pi.confirmDialogs).toHaveLength(1);
  });

  test("adds Codex quota headers and HTTP 429 state to the completion notification", async () => {
    const home = await makeTempDirectory("pi-asuku-rate-limits");
    const binary = join(home, "asuku-hook");
    await fs.writeFile(binary, "#!/bin/bash\n", { mode: 0o755 });
    const launches: { args: string[]; stdin?: string }[] = [];
    const spawnDetached: DetachedSpawnFunction = (_command, args, options) => {
      launches.push({
        args,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      });
    };
    const pi = createFakePi({ cwd: home });
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: binary,
      spawnDetached,
    });

    await pi.emitAfterProviderResponse({
      type: "after_provider_response",
      status: 429,
      headers: {
        "X-Codex-Primary-Used-Percent": "100",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1785465600",
        "x-codex-secondary-used-percent": "81.25",
        "x-codex-secondary-window-minutes": "10080",
      },
    });
    await pi.emitAgentSettled();

    expect(launches).toHaveLength(1);
    expect(launches[0]?.args).toEqual(["notification"]);
    const payload = JSON.parse(launches[0]?.stdin ?? "{}");
    expect(payload.message).toContain("Codex rate limited (HTTP 429)");
    expect(payload.message).toContain("5h 100% used");
    expect(payload.message).toContain("7d 81.25% used");
    expect(payload.message).toContain("reset 2026-");
  });

  test("keeps a headerless Codex HTTP 429 without mislabeling another provider", async () => {
    expect(settings.transport).toBe("sse");
    const home = await makeTempDirectory("pi-asuku-headerless-429");
    const binary = join(home, "asuku-hook");
    await fs.writeFile(binary, "#!/bin/bash\n", { mode: 0o755 });
    const payloads: string[] = [];
    const pi = createFakePi({
      cwd: home,
      model: { id: "gpt-test", provider: "openai-codex" },
    });
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: binary,
      spawnDetached: (_command, _args, options) => {
        if (options.stdin !== undefined) payloads.push(options.stdin);
      },
    });

    await pi.emitAfterProviderResponse({
      type: "after_provider_response",
      status: 429,
      headers: { "retry-after": "30" },
    });
    await pi.emitAgentSettled();
    expect(JSON.parse(payloads[0] ?? "{}").message).toContain(
      "Codex rate limited (HTTP 429)",
    );

    await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "other provider",
    });
    pi.ctx.model = { id: "claude-test", provider: "anthropic" };
    await pi.emitAfterProviderResponse({
      type: "after_provider_response",
      status: 429,
      headers: { "retry-after": "30" },
    });
    await pi.emitAgentSettled();
    expect(JSON.parse(payloads[1] ?? "{}").message).not.toContain(
      "Codex rate limited",
    );
  });

  test("clears stale Codex quota details when a new agent turn starts", async () => {
    const home = await makeTempDirectory("pi-asuku-rate-reset");
    const binary = join(home, "asuku-hook");
    await fs.writeFile(binary, "#!/bin/bash\n", { mode: 0o755 });
    const payloads: string[] = [];
    const pi = createFakePi({ cwd: home });
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: binary,
      spawnDetached: (_command, _args, options) => {
        if (options.stdin !== undefined) payloads.push(options.stdin);
      },
    });

    await pi.emitAfterProviderResponse({
      type: "after_provider_response",
      status: 200,
      headers: { "x-codex-primary-used-percent": "42" },
    });
    await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "next turn",
    });
    await pi.emitAgentSettled();

    const payload = JSON.parse(payloads[0] ?? "{}");
    expect(payload.message).not.toContain("Codex rate limit");
  });

  test("a missing binary is silently skipped without launching anything", async () => {
    const home = await makeTempDirectory("pi-asuku-missing");
    const launches: string[] = [];
    const spawnDetached: DetachedSpawnFunction = (command) => {
      launches.push(command);
    };
    const pi = createFakePi({ cwd: home });
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: join(home, "does-not-exist"),
      spawnDetached,
    });

    await pi.emitAgentSettled();
    expect(launches).toHaveLength(0);
  });

  test("a non-executable binary is silently skipped", async () => {
    const home = await makeTempDirectory("pi-asuku-noexec");
    const binary = join(home, "asuku-hook");
    await fs.writeFile(binary, "#!/bin/bash\n", { mode: 0o644 });
    const launches: string[] = [];
    const spawnDetached: DetachedSpawnFunction = (command) => {
      launches.push(command);
    };
    const pi = createFakePi({ cwd: home });
    setupAsukuNotify(pi, makeConfig(home), {
      binaryPath: binary,
      spawnDetached,
    });

    await pi.emitAgentSettled();
    expect(launches).toHaveLength(0);
  });
});
