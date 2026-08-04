import { chmod, lstat, mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupHookBridge from "../../pi/extensions/pi-harness/features/hook-bridge/index";
import type { BridgeHookSpec } from "../../pi/extensions/pi-harness/features/hook-bridge/registry";
import setupUltracodeSettings, {
  readUltracodeSetting,
  writeUltracodeSetting,
} from "../../pi/extensions/pi-harness/features/ultracode-settings/index";
import { setupHarness } from "../../pi/extensions/pi-harness/index";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { runHook } from "../../pi/extensions/pi-harness/lib/run-hook";
import {
  cleanupTestDirectory,
  createTestFile,
  setupTestDirectory,
} from "../test-helpers";
import { createFakePi } from "./fake-pi";

const makeConfig = (home: string): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": true,
    subagent: false,
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

test("persists ultracode auto-injection without replacing unrelated config", async () => {
  const home = await setupTestDirectory("pi-ultracode-setting");
  const configFile = join(home, ".pi", "agent", "pi-harness.local.json");
  try {
    await createTestFile(
      configFile,
      JSON.stringify({
        features: { workflow: false },
        ultracode: { note: "keep" },
      }),
    );

    writeUltracodeSetting(configFile, true);

    expect(readUltracodeSetting(configFile)).toEqual({
      autoInjectContext: true,
    });
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
      features: { workflow: false },
      ultracode: { note: "keep", autoInjectContext: true },
    });
  } finally {
    await cleanupTestDirectory(home);
  }
});

test("updates a symlinked config target without replacing the link", async () => {
  const home = await setupTestDirectory("pi-ultracode-setting-link");
  const target = join(home, "machine-local.json");
  const configFile = join(home, "pi-harness.local.json");
  try {
    await createTestFile(target, "{}\n");
    await symlink(target, configFile);

    writeUltracodeSetting(configFile, true);

    const linkStats = await lstat(configFile);
    expect(linkStats.isSymbolicLink()).toBe(true);
    expect(readUltracodeSetting(configFile).autoInjectContext).toBe(true);
  } finally {
    await cleanupTestDirectory(home);
  }
});

test("refuses to replace a dangling config symlink", async () => {
  const home = await setupTestDirectory("pi-ultracode-setting-dangling");
  const configFile = join(home, "pi-harness.local.json");
  try {
    await symlink(join(home, "missing.json"), configFile);

    expect(() => writeUltracodeSetting(configFile, true)).toThrow();
    const linkStats = await lstat(configFile);
    expect(linkStats.isSymbolicLink()).toBe(true);
  } finally {
    await cleanupTestDirectory(home);
  }
});

test("refuses to overwrite malformed local config", async () => {
  const home = await setupTestDirectory("pi-ultracode-setting-malformed");
  const configFile = join(home, "pi-harness.local.json");
  try {
    await createTestFile(configFile, "{not-json");

    expect(() => writeUltracodeSetting(configFile, true)).toThrow();
    expect(await readFile(configFile, "utf8")).toBe("{not-json");
    expect(readUltracodeSetting(configFile)).toEqual({
      autoInjectContext: false,
      error: "pi-harness.local.json could not be parsed",
    });
  } finally {
    await cleanupTestDirectory(home);
  }
});

test("shares the local-config writer lock with trust onboarding", async () => {
  const home = await setupTestDirectory("pi-ultracode-setting-lock");
  const directory = join(home, ".pi", "agent");
  const configFile = join(directory, "pi-harness.local.json");
  const lockFile = join(directory, ".pi-harness.local.json.lock");
  try {
    await createTestFile(configFile, '{"custom":"keep"}\n');
    await createTestFile(lockFile, "trust-writer");

    expect(() => writeUltracodeSetting(configFile, true)).toThrow(
      "pi-harness.local.json update already in progress",
    );
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
      custom: "keep",
    });
  } finally {
    await cleanupTestDirectory(home);
  }
});

test("settings input toggles ultracode without registering a conflicting command", async () => {
  const home = await setupTestDirectory("pi-ultracode-command");
  const configFile = join(home, ".pi", "agent", "pi-harness.local.json");
  const pi = createFakePi();
  const emit = (text: string) =>
    pi.emitInputResult({ type: "input", text, source: "interactive" });
  try {
    setupUltracodeSettings(pi, configFile);
    expect(pi.commands.has("settings")).toBe(false);

    expect(await emit("/settings")).toEqual({ action: "continue" });
    expect(await emit("/settings another-feature on")).toEqual({
      action: "continue",
    });
    expect(pi.notifications).toHaveLength(0);

    expect(await emit("/settings ultracode on")).toEqual({
      action: "handled",
    });
    expect(readUltracodeSetting(configFile).autoInjectContext).toBe(true);
    expect(pi.notifications.at(-1)).toEqual({
      message: "Ultracode context auto-injection: on",
      level: "info",
    });

    await emit("/settings ultracode status");
    expect(pi.notifications.at(-1)?.message).toBe(
      "Ultracode context auto-injection: on",
    );

    await emit("/settings ultracode off");
    expect(readUltracodeSetting(configFile).autoInjectContext).toBe(false);

    await emit("/settings ultracode maybe");
    expect(pi.notifications.at(-1)).toEqual({
      message: "Usage: /settings ultracode on|off|status",
      level: "warning",
    });
  } finally {
    await cleanupTestDirectory(home);
  }
});

test("fake input result matches Pi aggregate transform behavior", async () => {
  const pi = createFakePi();
  const images = [{ type: "image" }];
  pi.on("input", (event) => ({
    action: "transform",
    text: event.text.toUpperCase(),
  }));

  expect(
    await pi.emitInputResult({
      type: "input",
      text: "request",
      images,
      source: "interactive",
    }),
  ).toEqual({ action: "transform", text: "REQUEST", images });
});

test("umbrella consumes settings before later input trackers", async () => {
  const home = await setupTestDirectory("pi-ultracode-input-order");
  try {
    const pi = createFakePi();
    setupHarness(pi, makeConfig(home));
    let reachedLaterTracker = false;
    pi.on("input", () => {
      reachedLaterTracker = true;
      return { action: "continue" };
    });

    expect(
      await pi.emitInputResult({
        type: "input",
        text: "/settings ultracode on",
        source: "interactive",
      }),
    ).toEqual({ action: "handled" });
    expect(reachedLaterTracker).toBe(false);
  } finally {
    await cleanupTestDirectory(home);
  }
});

test("umbrella omits settings input when the bridge is inactive", async () => {
  const home = await setupTestDirectory("pi-ultracode-inactive");
  try {
    const configs: HarnessConfig[] = [
      {
        ...makeConfig(home),
        features: { ...makeConfig(home).features, "hook-bridge": false },
      },
      { ...makeConfig(home), isChild: true },
    ];
    for (const config of configs) {
      const pi = createFakePi();
      setupHarness(pi, config);
      expect(
        await pi.emitInputResult({
          type: "input",
          text: "/settings ultracode on",
          source: "interactive",
        }),
      ).toEqual({ action: "continue" });
      expect(pi.notifications).toHaveLength(0);
    }
    expect(readUltracodeSetting(resolvePaths(home).localConfigFile)).toEqual({
      autoInjectContext: false,
    });
  } finally {
    await cleanupTestDirectory(home);
  }
});

const hookPath = join(
  import.meta.dir,
  "..",
  "..",
  "claude",
  ".claude",
  "hooks",
  "user_prompt_submit",
  "ultracode_codex_context.sh",
);

const runUltracodeHook = async (
  home: string,
  prompt: string,
  piConfigFile?: string,
): Promise<string> => {
  const bin = join(home, ".bun", "bin");
  const temporary = join(home, "tmp");
  await mkdir(bin, { recursive: true });
  await mkdir(temporary, { recursive: true });
  const codex = join(bin, "codex");
  await createTestFile(codex, "#!/bin/sh\nexit 0\n");
  await chmod(codex, 0o700);
  const result = await runHook(hookPath, JSON.stringify({ prompt }), {
    cwd: home,
    env: {
      HOME: home,
      TMPDIR: temporary,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      PI_HARNESS_LOCAL_CONFIG_FILE: piConfigFile,
    },
    timeoutMs: 5_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.timedOut).toBe(false);
  return result.stdout;
};

test("hook bridge supplies the Pi-local config path", async () => {
  const home = await setupTestDirectory("pi-ultracode-hook-bridge");
  const script = join(home, "config-path-hook.sh");
  const configReference = `${String.fromCharCode(36)}{PI_HARNESS_LOCAL_CONFIG_FILE:-}`;
  try {
    await createTestFile(
      script,
      [
        "#!/usr/bin/env bash",
        "cat > /dev/null",
        `jq -n --arg ctx "${configReference}" '{hookSpecificOutput:{additionalContext:$ctx}}'`,
      ].join("\n"),
    );
    const pi = createFakePi({ cwd: home });
    const config = makeConfig(home);
    const registry: BridgeHookSpec[] = [
      {
        id: "ultracode-config-path",
        stage: "before_agent_start",
        script,
        timeoutMs: 5_000,
        maxOutputBytes: 65_536,
      },
    ];
    setupHookBridge(pi, config, { registry });

    const injection = await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "ordinary request",
    });
    expect(injection?.message?.content).toBe(config.paths.localConfigFile);
  } finally {
    await cleanupTestDirectory(home);
  }
});

test("hook keeps Claude keyword-only and honors Pi auto-injection", async () => {
  const home = await setupTestDirectory("pi-ultracode-hook");
  const configFile = join(home, ".pi", "agent", "pi-harness.local.json");
  try {
    expect(await runUltracodeHook(home, "ordinary request")).toBe("");
    expect(await runUltracodeHook(home, "please use ultracode")).toContain(
      "additionalContext",
    );

    writeUltracodeSetting(configFile, true);
    expect(await runUltracodeHook(home, "ordinary request")).toBe("");
    expect(
      await runUltracodeHook(home, "ordinary request", configFile),
    ).toContain("additionalContext");

    writeUltracodeSetting(configFile, false);
    expect(await runUltracodeHook(home, "ordinary request", configFile)).toBe(
      "",
    );

    await createTestFile(
      configFile,
      JSON.stringify({ ultracode: { autoInjectContext: "true" } }),
    );
    expect(await runUltracodeHook(home, "ordinary request", configFile)).toBe(
      "",
    );
    await createTestFile(configFile, "{not-json");
    expect(await runUltracodeHook(home, "ordinary request", configFile)).toBe(
      "",
    );
    await createTestFile(
      configFile,
      '{}\n{"ultracode":{"autoInjectContext":true}}\n',
    );
    expect(await runUltracodeHook(home, "ordinary request", configFile)).toBe(
      "",
    );
  } finally {
    await cleanupTestDirectory(home);
  }
});
