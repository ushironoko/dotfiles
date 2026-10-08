import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSdkExtensionRunner } from "./sdk-extension-runner";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupGitHubCliReminder, {
  GITHUB_CLI_REMINDER,
  GITHUB_CLI_REMINDER_TYPE,
} from "../../pi/extensions/pi-harness/features/github-cli-reminder/index";
import { COMMAND_HYGIENE_GUIDANCE } from "../../pi/extensions/pi-harness/features/permission-policy/command-hygiene";
import setupHookBridge from "../../pi/extensions/pi-harness/features/hook-bridge/index";
import type { BridgeHookSpec } from "../../pi/extensions/pi-harness/features/hook-bridge/registry";
import { setupHarness } from "../../pi/extensions/pi-harness/index";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { setupTestDirectory } from "../test-helpers";
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

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
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
    const directory = await fs.mkdtemp(join(tmpdir(), "sdk-reminder-session-"));
    tempDirectories.push(directory);
    const manager = SessionManager.create(
      directory,
      join(directory, "sessions"),
    );
    const rootId = manager.appendMessage({
      role: "user",
      content: "inspect GitHub",
      timestamp: 1,
    });
    const sdk = await createSdkExtensionRunner(
      [(api) => setupGitHubCliReminder(api)],
      directory,
      manager,
    );
    const first = await sdk.runner.emitBeforeAgentStart("inspect", undefined, {
      cwd: directory,
      forceSystemPrompt: "base",
    });
    expect(first.messages).toEqual([
      {
        customType: GITHUB_CLI_REMINDER_TYPE,
        content: GITHUB_CLI_REMINDER,
        display: false,
      },
    ]);
    expect(manager.getEntries()).toHaveLength(1);
    const [message] = first.messages;
    if (message === undefined) throw new Error("Missing reminder");
    const reminderId = manager.appendCustomMessageEntry(
      message.customType,
      message.content,
      message.display,
    );
    const file = manager.getSessionFile();
    if (file === undefined) throw new Error("Missing session file");
    expect(await fs.readFile(file, "utf8")).toContain(GITHUB_CLI_REMINDER_TYPE);
    const reopened = SessionManager.open(file, join(directory, "sessions"));
    expect(reopened.getEntries()).toEqual(manager.getEntries());
    expect(
      reopened.buildContextEntries().some((entry) => entry.id === reminderId),
    ).toBe(true);
    const resumed = await createSdkExtensionRunner(
      [(api) => setupGitHubCliReminder(api)],
      directory,
      reopened,
    );
    const resumeResult = await resumed.runner.emitBeforeAgentStart(
      "resume",
      undefined,
      { cwd: directory },
    );
    expect(resumeResult.messages).toEqual([]);
    reopened.branch(rootId);
    expect(
      reopened.buildContextEntries().some((entry) => entry.id === reminderId),
    ).toBe(false);
    const olderBranch = await resumed.runner.emitBeforeAgentStart(
      "older branch",
      undefined,
      { cwd: directory },
    );
    expect(olderBranch.messages).toEqual(first.messages);
    const replacementId = reopened.appendCustomMessageEntry(
      message.customType,
      message.content,
      message.display,
    );
    expect(
      reopened.getEntries().filter((entry) => entry.type === "custom_message"),
    ).toHaveLength(2);
    expect(
      reopened.getTree()[0]?.children.map(({ entry }) => entry.id),
    ).toEqual([reminderId, replacementId]);
    const sameBranchResult = await resumed.runner.emitBeforeAgentStart(
      "same branch",
      undefined,
      { cwd: directory },
    );
    expect(sameBranchResult.messages).toEqual([]);
    reopened.appendCompaction("keep guidance", replacementId, 100);
    expect(
      reopened
        .buildContextEntries()
        .some((entry) => entry.id === replacementId),
    ).toBe(true);
    const keptResult = await resumed.runner.emitBeforeAgentStart(
      "kept after compaction",
      undefined,
      { cwd: directory },
    );
    expect(keptResult.messages).toEqual([]);
    reopened.appendCompaction("summarized guidance", null, 100);
    expect(
      reopened
        .buildContextEntries()
        .some((entry) => entry.type === "custom_message"),
    ).toBe(false);
    expect(
      reopened.getEntries().filter((entry) => entry.type === "custom_message"),
    ).toHaveLength(2);
    const droppedResult = await resumed.runner.emitBeforeAgentStart(
      "dropped after compaction",
      undefined,
      { cwd: directory },
    );
    expect(droppedResult.messages).toEqual(first.messages);
    const compactedFile = reopened.getSessionFile();
    if (compactedFile === undefined)
      throw new Error("Missing compacted session file");
    const compacted = SessionManager.open(
      compactedFile,
      join(directory, "sessions"),
    );
    expect(compacted.getEntries()).toEqual(reopened.getEntries());
    expect(
      compacted
        .buildContextEntries()
        .some((entry) => entry.type === "custom_message"),
    ).toBe(false);
    expect(sdk.errors).toEqual([]);
    expect(resumed.errors).toEqual([]);
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
    const childInjection = await child.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "inspect GitHub",
    });
    expect(childInjection?.message).toBeUndefined();
    expect(childInjection?.systemPrompt).toBe(COMMAND_HYGIENE_GUIDANCE);
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

    const registry: BridgeHookSpec[] = [
      {
        id: "prompt-context",
        stage: "before_agent_start",
        script,
        timeoutMs: 10_000,
        maxOutputBytes: 65_536,
      },
    ];
    const sdk = await createSdkExtensionRunner(
      [
        (api) =>
          setupHookBridge(api, makeConfig(directory), {
            cwd: directory,
            registry,
          }),
        (api) => setupGitHubCliReminder(api),
      ],
      directory,
    );
    const fake = createFakePi({ cwd: directory });
    setupHookBridge(fake, makeConfig(directory), { cwd: directory, registry });
    setupGitHubCliReminder(fake);
    const { messages } = await sdk.runner.emitBeforeAgentStart(
      "inspect an issue",
      undefined,
      { cwd: directory, forceSystemPrompt: "base" },
    );
    const aggregate = await fake.emitBeforeAgentStartAggregate({
      type: "before_agent_start",
      prompt: "inspect an issue",
      systemPrompt: "base",
    });
    expect(messages).toEqual(aggregate.messages);
    expect(sdk.sessionManager.getEntries()).toEqual([]);
    expect(sdk.errors).toEqual([]);

    expect(messages.map(({ customType }) => customType)).toEqual([
      "pi-harness-hook-bridge",
      GITHUB_CLI_REMINDER_TYPE,
    ]);
    expect(messages[0]?.content).toBe("hook context");
    expect(messages[1]?.content).toBe(GITHUB_CLI_REMINDER);
    expect(sdk.sessionManager.getEntries()).toEqual([]);
    expect(messages.every(({ display }) => display === false)).toBe(true);
  });
});
