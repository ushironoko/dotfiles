import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import type { InputEventResult as SdkInputEventResult } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  InputEvent,
  PiLike,
} from "../../pi/extensions/pi-harness/lib/pi-like";
import { createSdkExtensionRunner } from "./sdk-extension-runner";
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

const sdkDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    sdkDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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
  const directory = await mkdtemp(join(tmpdir(), "sdk-input-"));
  sdkDirectories.push(directory);
  const images: ImageContent[] = [
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  ];
  const replacement: ImageContent[] = [
    { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" },
  ];
  for (const scenario of [
    "empty",
    "undefined",
    "continue",
    "identity",
    "chain",
    "replace",
    "clear",
    "handled",
  ] as const) {
    const fakeSeen: InputEvent[] = [];
    const sdkSeen: InputEvent[] = [];
    const install = (pi: PiLike, seen: InputEvent[]) => {
      if (scenario === "empty") return;
      pi.on("input", (event) => {
        seen.push({ ...event });
        if (scenario === "undefined") return undefined;
        if (scenario === "continue") return { action: "continue" };
        const text =
          scenario === "identity" ? event.text : event.text.toUpperCase();
        if (scenario === "replace")
          return { action: "transform", text, images: replacement };
        if (scenario === "clear")
          return { action: "transform", text, images: [] };
        return { action: "transform", text };
      });
      pi.on("input", (event) => {
        seen.push({ ...event });
        if (scenario === "handled") return { action: "handled" };
        if (scenario === "chain")
          return { action: "transform", text: `${event.text}!` };
        return { action: "continue" };
      });
      pi.on("input", (event) => {
        seen.push({ ...event });
        return { action: "continue" };
      });
    };
    const fake = createFakePi();
    install(fake, fakeSeen);
    const sdk = await createSdkExtensionRunner(
      [(api) => install(api, sdkSeen)],
      directory,
    );
    const payload: InputEvent = {
      type: "input",
      text: "request",
      images,
      source: "rpc",
      streamingBehavior: "followUp",
    };
    const actual = await sdk.runner.emitInput(
      "request",
      images,
      "rpc",
      "followUp",
    );
    const expectations: Record<typeof scenario, SdkInputEventResult> = {
      empty: { action: "continue" },
      undefined: { action: "continue" },
      continue: { action: "continue" },
      identity: { action: "continue" },
      chain: { action: "transform", text: "REQUEST!", images },
      replace: { action: "transform", text: "REQUEST", images: replacement },
      clear: { action: "transform", text: "REQUEST", images: [] },
      handled: { action: "handled" },
    };
    const expected = expectations[scenario];
    expect(actual).toEqual(expected);
    expect(await fake.emitInputResult(payload)).toEqual(actual);
    expect(sdkSeen).toEqual(fakeSeen);
    const seenCounts = {
      empty: 0,
      undefined: 3,
      continue: 3,
      identity: 3,
      chain: 3,
      replace: 3,
      clear: 3,
      handled: 2,
    };
    expect(sdkSeen).toHaveLength(seenCounts[scenario]);
    if (
      scenario === "chain" ||
      scenario === "handled" ||
      scenario === "replace" ||
      scenario === "clear"
    ) {
      expect(sdkSeen[1]?.text).toBe("REQUEST");
      let expectedImages = images;
      if (scenario === "replace") expectedImages = replacement;
      if (scenario === "clear") expectedImages = [];
      expect(sdkSeen[1]?.images).toEqual(expectedImages);
    }
    if (scenario === "chain") expect(sdkSeen[2]?.text).toBe("REQUEST!");
    for (const event of sdkSeen) {
      expect(event.source).toBe("rpc");
      expect(event.streamingBehavior).toBe("followUp");
    }
    expect(payload.text).toBe("request");
    expect(payload.images).toBe(images);
    expect(sdk.errors).toEqual([]);
  }
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

    const configFile = resolvePaths(home).localConfigFile;
    writeUltracodeSetting(configFile, false);
    expect(JSON.parse(await readFile(configFile, "utf8"))).toMatchObject({
      ultracode: { autoInjectContext: false },
    });

    let reachedSdkTracker = false;
    const sdk = await createSdkExtensionRunner(
      [
        (api) => setupHarness(api, makeConfig(home)),
        (api) => {
          api.on("input", () => {
            reachedSdkTracker = true;
            return { action: "continue" };
          });
        },
      ],
      home,
    );
    expect(
      await sdk.runner.emitInput(
        "/settings ultracode on",
        undefined,
        "interactive",
      ),
    ).toEqual({ action: "handled" });
    expect(reachedSdkTracker).toBe(false);
    expect(readUltracodeSetting(configFile).autoInjectContext).toBe(true);
    expect(JSON.parse(await readFile(configFile, "utf8"))).toMatchObject({
      ultracode: { autoInjectContext: true },
    });
    expect(sdk.errors).toEqual([]);
    await sdk.runner.emit({ type: "session_shutdown", reason: "quit" });
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
