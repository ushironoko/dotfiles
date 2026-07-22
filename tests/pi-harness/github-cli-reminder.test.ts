import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupGitHubCliReminder, {
  GITHUB_CLI_REMINDER,
  GITHUB_CLI_REMINDER_TYPE,
} from "../../pi/extensions/pi-harness/features/github-cli-reminder/index";
import setupHookBridge from "../../pi/extensions/pi-harness/features/hook-bridge/index";
import type { BridgeHookSpec } from "../../pi/extensions/pi-harness/features/hook-bridge/registry";
import { setupHarness } from "../../pi/extensions/pi-harness/index";
import type {
  PiEventHandler,
  PiEventName,
  PiLike,
} from "../../pi/extensions/pi-harness/lib/pi-like";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { cleanupTestDirectory, setupTestDirectory } from "../test-helpers";
import { createFakePi } from "./fake-pi";

const tempDirectories: string[] = [];

const makeConfig = (home: string, isChild = false): HarnessConfig => ({
  isChild,
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
  paths: resolvePaths(home),
});

const captureBeforeAgentStartHandlers = (
  pi: ReturnType<typeof createFakePi>,
) => {
  const handlers: PiEventHandler<"before_agent_start">[] = [];
  const capturingPi: PiLike = {
    ...pi,
    on: <K extends PiEventName>(event: K, handler: PiEventHandler<K>): void => {
      if (event === "before_agent_start") {
        handlers.push(
          handler as unknown as PiEventHandler<"before_agent_start">,
        );
      }
      pi.on(event, handler);
    },
  };
  return { handlers, pi: capturingPi };
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(cleanupTestDirectory));
});

describe("pi-harness GitHub CLI reminder", () => {
  test("keeps concrete hidden gh guidance without per-turn copies", async () => {
    const pi = createFakePi();
    setupGitHubCliReminder(pi);

    const injection = await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "inspect an issue",
    });
    expect(injection?.message).toEqual({
      customType: GITHUB_CLI_REMINDER_TYPE,
      content: GITHUB_CLI_REMINDER,
      display: false,
    });
    expect(
      await pi.emitBeforeAgentStart({
        type: "before_agent_start",
        prompt: "continue implementation",
      }),
    ).toBeUndefined();

    await pi.emitSessionCompact();
    const refreshed = await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "continue after compaction",
    });
    expect(refreshed?.message?.customType).toBe(GITHUB_CLI_REMINDER_TYPE);

    for (const command of [
      "gh repo view",
      "gh issue view",
      "gh issue list",
      "gh pr view",
      "gh pr list",
      "gh api",
    ]) {
      expect(GITHUB_CLI_REMINDER).toContain(command);
    }
    expect(GITHUB_CLI_REMINDER).toContain(
      "Use web_fetch only for non-GitHub public web pages.",
    );
    expect(GITHUB_CLI_REMINDER).toContain("Use the git CLI");
  });

  test("derives deduplication from the active persisted branch", async () => {
    const pi = createFakePi();
    let entries: unknown[] = [
      {
        type: "custom_message",
        customType: GITHUB_CLI_REMINDER_TYPE,
      },
    ];
    Object.assign(pi.ctx, {
      sessionManager: {
        buildContextEntries: () => entries,
      },
    });
    setupGitHubCliReminder(pi);

    expect(
      await pi.emitBeforeAgentStart({
        type: "before_agent_start",
        prompt: "resume with the reminder present",
      }),
    ).toBeUndefined();

    entries = [];
    const refreshed = await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "navigate before the reminder",
    });
    expect(refreshed?.message?.customType).toBe(GITHUB_CLI_REMINDER_TYPE);
  });

  test("the umbrella registers the reminder only for parent pi sessions", async () => {
    const directory = await setupTestDirectory("pi-github-cli-reminder");
    tempDirectories.push(directory);

    const parent = createFakePi({ cwd: directory });
    setupHarness(parent, makeConfig(directory));
    const parentInjection = await parent.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "inspect GitHub",
    });
    expect(parentInjection?.message?.customType).toBe(GITHUB_CLI_REMINDER_TYPE);
    expect(parentInjection?.message?.display).toBe(false);

    const child = createFakePi({ cwd: directory, hasUI: false });
    setupHarness(child, makeConfig(directory, true));
    expect(
      await child.emitBeforeAgentStart({
        type: "before_agent_start",
        prompt: "inspect GitHub",
      }),
    ).toBeUndefined();
  });

  test("coexists with a hook-bridge before_agent_start message", async () => {
    const directory = await setupTestDirectory("pi-github-cli-hook-bridge");
    tempDirectories.push(directory);
    const script = join(directory, "prompt-hook.sh");
    await fs.writeFile(
      script,
      [
        "#!/usr/bin/env bash",
        "cat > /dev/null",
        `printf '%s' '{"hookSpecificOutput":{"additionalContext":"hook context"}}'`,
      ].join("\n"),
      { mode: 0o755 },
    );

    const fake = createFakePi({ cwd: directory });
    const captured = captureBeforeAgentStartHandlers(fake);
    const registry: BridgeHookSpec[] = [
      {
        id: "prompt-context",
        stage: "before_agent_start",
        script,
        timeoutMs: 10_000,
        maxOutputBytes: 65_536,
      },
    ];
    setupHookBridge(captured.pi, makeConfig(directory), {
      cwd: directory,
      registry,
    });
    setupGitHubCliReminder(captured.pi);

    const messages = [];
    for (const handler of captured.handlers) {
      const result = await handler(
        { type: "before_agent_start", prompt: "inspect an issue" },
        fake.ctx,
      );
      if (result?.message !== undefined) messages.push(result.message);
    }

    expect(messages.map(({ customType }) => customType)).toEqual([
      "pi-harness-hook-bridge",
      GITHUB_CLI_REMINDER_TYPE,
    ]);
    expect(messages[0]?.content).toBe("hook context");
    expect(messages.every(({ display }) => display === false)).toBe(true);
  });
});
